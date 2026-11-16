using System.IO.Compression;
using System.Text;
using LiquidVault.Api.Models;
using LiquidVault.Api.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Net.Http.Headers;

namespace LiquidVault.Api.Controllers;

[ApiController]
[Route("api/transfer")]
public sealed class TransferController(TransferStore store) : ControllerBase
{
    [HttpGet("settings")]
    public IActionResult Settings() => Ok(new { store.Options.MaxFileSizeBytes, store.Options.MaxBatchFiles,
        store.Options.MaxTextBytes, store.Options.ExpirationHours });

    // No IFormFile binding: bytes go directly from the request to the final storage volume.
    [HttpPost("raw")]
    public async Task<IActionResult> Raw([FromQuery] string filename, [FromQuery] bool keepForever = false)
    {
        filename = TransferStore.SafeFilename(filename);
        if (Request.ContentLength > store.Options.MaxFileSizeBytes)
            throw new TransferException("The file exceeds the configured size limit.", 413);
        return Ok(await store.WriteAsync(filename, "file", keepForever, async (output, token) =>
            { await store.CopyBoundedAsync(Request.Body, output, store.Options.MaxFileSizeBytes, token); }, HttpContext.RequestAborted));
    }

    [HttpPost("upload")]
    [HttpPost("batch")]
    [DisableFormValueModelBinding]
    public async Task<IActionResult> Multipart([FromQuery] bool keepForever = false)
    {
        var batch = Request.Path.Value!.EndsWith("/batch", StringComparison.OrdinalIgnoreCase);
        if (!MediaTypeHeaderValue.TryParse(Request.ContentType, out var mediaType)
            || !string.Equals(mediaType.MediaType.Value, "multipart/form-data", StringComparison.OrdinalIgnoreCase))
            throw new TransferException("A multipart form upload is required.");
        var boundary = HeaderUtilities.RemoveQuotes(mediaType.Boundary).Value;
        if (string.IsNullOrEmpty(boundary) || boundary.Length > 128) throw new TransferException("Invalid multipart boundary.");
        var reader = new MultipartReader(boundary, Request.Body) { BodyLengthLimit = store.Options.MaxFileSizeBytes + 8L * 1024 * 1024 };
        var files = 0;
        var sections = 0;
        long total = 0;
        var name = batch ? "files.zip" : "file";
        var usedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var record = await store.WriteAsync(name, batch ? "zip" : "file", keepForever, async (output, token) =>
        {
            using var archive = batch ? new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true) : null;
            MultipartSection? section;
            while ((section = await reader.ReadNextSectionAsync(token)) is not null)
            {
                if (++sections > store.Options.MaxBatchFiles + 4) throw new TransferException("Too many upload sections.");
                if (!ContentDispositionHeaderValue.TryParse(section.ContentDisposition, out var disposition))
                    throw new TransferException("Invalid upload section.");
                if (disposition.FileName.HasValue || disposition.FileNameStar.HasValue)
                {
                    if (++files > (batch ? store.Options.MaxBatchFiles : 1)) throw new TransferException("Too many files in this transfer.");
                    var filename = TransferStore.SafeFilename(HeaderUtilities.RemoveQuotes(
                        disposition.FileNameStar.HasValue ? disposition.FileNameStar : disposition.FileName).Value);
                    name = filename;
                    long length;
                    if (archive is null)
                        length = await store.CopyBoundedAsync(section.Body, output, store.Options.MaxFileSizeBytes, token);
                    else
                    {
                        var unique = filename;
                        var counter = 2;
                        while (!usedNames.Add(unique)) unique = $"{Path.GetFileNameWithoutExtension(filename)} ({counter++}){Path.GetExtension(filename)}";
                        // Store-only ZIP favors LAN throughput and avoids recompressing photos/videos/archives.
                        var entry = archive.CreateEntry(unique, CompressionLevel.NoCompression);
                        await using var destination = entry.Open();
                        length = await store.CopyBoundedAsync(section.Body, destination, store.Options.MaxFileSizeBytes - total, token);
                    }
                    if (length == 0) throw new TransferException("Empty files cannot be transferred.");
                    total += length;
                }
                else
                {
                    await using var field = new MemoryStream();
                    await store.CopyBoundedAsync(section.Body, field, 64, token);
                    if (HeaderUtilities.RemoveQuotes(disposition.Name).Value == "keepForever")
                    {
                        if (!bool.TryParse(Encoding.UTF8.GetString(field.ToArray()), out var parsed)) throw new TransferException("Invalid retention option.");
                        keepForever = parsed;
                    }
                }
            }
            if (files == 0) throw new TransferException("Select at least one file.");
        }, HttpContext.RequestAborted, result =>
        {
            result.Filename = batch ? "files.zip" : name;
            result.ExpiresAt = keepForever ? DateTime.MaxValue : result.CreatedAt.AddHours(store.Options.ExpirationHours);
        });
        return Ok(record);
    }

    public sealed class TextRequest
    {
        public string? Title { get; set; }
        public string? Text { get; set; }
        public bool KeepForever { get; set; }
    }

    [HttpPost("text")]
    [RequestSizeLimit(6_500_000)]
    public async Task<IActionResult> Text([FromBody] TextRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Text)) throw new TransferException("Enter some text to share.");
        var title = TransferStore.SafeFilename(string.IsNullOrWhiteSpace(request.Title) ? "Untitled snippet.txt" : request.Title);
        var bytes = Encoding.UTF8.GetBytes(request.Text);
        if (bytes.Length > store.Options.MaxTextBytes) throw new TransferException("The text exceeds the configured size limit.", 413);
        return Ok(await store.WriteAsync(title, "text", request.KeepForever,
            (output, token) => output.WriteAsync(bytes, token).AsTask(), HttpContext.RequestAborted));
    }

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] int limit = 200)
    {
        if (limit is < 1 or > 200) throw new TransferException("Limit must be between 1 and 200.");
        return Ok(await store.ListAsync(limit, HttpContext.RequestAborted));
    }

    [HttpDelete("{id}")]
    public IActionResult Delete(string id) { store.Delete(id); return NoContent(); }

    [HttpGet("download/{id}")]
    [HttpHead("download/{id}")]
    public async Task<IActionResult> Download(string id)
    {
        var record = await store.ReadAsync(id, HttpContext.RequestAborted);
        if (record is null || record.ExpiresAt <= DateTime.UtcNow) return NotFound();
        try
        {
            var path = store.Resolve(id);
            var modified = new DateTimeOffset(System.IO.File.GetLastWriteTimeUtc(path));
            var stream = new FileStream(path, FileMode.Open, FileAccess.Read,
                FileShare.Read | FileShare.Delete, 128 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
            var type = record.Type == "zip" ? "application/zip" : record.Type == "text" ? "text/plain; charset=utf-8" : "application/octet-stream";
            return File(stream, type, record.Filename, modified,
                new EntityTagHeaderValue($"\"{record.Id}-{record.Size}\""), enableRangeProcessing: true);
        }
        catch (FileNotFoundException) { return NotFound(); }
    }
}
