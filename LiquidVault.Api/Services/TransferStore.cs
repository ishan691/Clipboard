using System.Buffers;
using System.Security.Cryptography;
using System.Text.Json;
using LiquidVault.Api.Models;
using Microsoft.Extensions.Options;

namespace LiquidVault.Api.Services;

public sealed class TransferStore
{
    private const int BufferSize = 128 * 1024;
    private readonly string _root;
    private readonly ILogger<TransferStore> _logger;
    public UploadOptions Options { get; }

    public TransferStore(IOptions<UploadOptions> options, IWebHostEnvironment environment, ILogger<TransferStore> logger)
    {
        Options = options.Value;
        _logger = logger;
        _root = Path.GetFullPath(Options.StoragePath, environment.ContentRootPath);
        Directory.CreateDirectory(_root);
        if ((File.GetAttributes(_root) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("Upload storage must not be a symbolic link.");
    }

    // Keep existing eight-character records readable while issuing 256-bit IDs for new transfers.
    public static bool ValidId(string? id) => id is not null && (id.Length == 8 || id.Length == 64)
        && id.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

    public string Resolve(string id, string suffix = "")
    {
        if (!ValidId(id)) throw new TransferException("Invalid transfer identifier.");
        var target = Path.GetFullPath(Path.Combine(_root, id + suffix));
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        if (!target.StartsWith(_root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, comparison))
            throw new TransferException("Invalid storage path.");
        if (File.Exists(target) && (File.GetAttributes(target) & FileAttributes.ReparsePoint) != 0)
            throw new TransferException("Linked files are not supported.");
        return target;
    }

    public static string SafeFilename(string? name)
    {
        name = name?.Trim();
        if (string.IsNullOrEmpty(name) || name.Length > 180 || name is "." or ".."
            || name.Any(c => char.IsControl(c) || "\\/:*?\"<>|".Contains(c)))
            throw new TransferException("Use a filename of 1–180 characters without paths or reserved characters.");
        return name;
    }

    public async Task<long> CopyBoundedAsync(Stream input, Stream output, long maximum, CancellationToken token)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(BufferSize);
        long total = 0;
        try
        {
            int read;
            while ((read = await input.ReadAsync(buffer.AsMemory(0, BufferSize), token)) != 0)
            {
                total += read;
                if (total > maximum) throw new TransferException("The transfer exceeds the configured size limit.", 413);
                await output.WriteAsync(buffer.AsMemory(0, read), token);
            }
            return total;
        }
        finally { ArrayPool<byte>.Shared.Return(buffer); }
    }

    public async Task<TransferRecord> WriteAsync(string filename, string type, bool keepForever,
        Func<Stream, CancellationToken, Task> write, CancellationToken token, Action<TransferRecord>? configure = null)
    {
        var id = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var partial = Resolve(id, ".partial");
        var content = Resolve(id);
        var metadataTemp = Resolve(id, ".meta.pending");
        var metadata = Resolve(id, ".meta.json");
        var moved = false;
        var ownsPartial = false;
        var ownsMetadataTemp = false;
        try
        {
            await using (var stream = new FileStream(partial, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                BufferSize, FileOptions.Asynchronous | FileOptions.SequentialScan))
            {
                ownsPartial = true;
                await write(stream, token);
                await stream.FlushAsync(token);
            }
            token.ThrowIfCancellationRequested();
            var size = new FileInfo(partial).Length;
            if (size == 0) throw new TransferException("Empty files cannot be transferred.");
            var now = DateTime.UtcNow;
            var record = new TransferRecord { Id = id, Filename = filename, Type = type, Size = size,
                CreatedAt = now, ExpiresAt = keepForever ? DateTime.MaxValue : now.AddHours(Options.ExpirationHours) };
            configure?.Invoke(record);
            await using (var stream = new FileStream(metadataTemp, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                4096, FileOptions.Asynchronous))
            {
                ownsMetadataTemp = true;
                await JsonSerializer.SerializeAsync(stream, record, cancellationToken: token);
            }
            token.ThrowIfCancellationRequested();
            // Publish complete content before atomically exposing its metadata to list/download readers.
            File.Move(partial, content, overwrite: false);
            moved = true;
            File.Move(metadataTemp, metadata, overwrite: false);
            return record;
        }
        catch
        {
            if (ownsPartial) TryDelete(partial);
            if (ownsMetadataTemp) TryDelete(metadataTemp);
            if (moved) TryDelete(content);
            throw;
        }
    }

    private void TryDelete(string path)
    {
        try { File.Delete(path); }
        catch (IOException ex) { _logger.LogWarning(ex, "Could not reclaim an incomplete transfer."); }
        catch (UnauthorizedAccessException ex) { _logger.LogWarning(ex, "Could not reclaim an incomplete transfer."); }
    }

    public async Task<TransferRecord?> ReadAsync(string id, CancellationToken token)
    {
        if (!ValidId(id)) throw new TransferException("Invalid transfer identifier.");
        try
        {
            var metadata = Resolve(id, ".meta.json");
            await using var stream = new FileStream(metadata, FileMode.Open, FileAccess.Read,
                FileShare.Read | FileShare.Delete, 4096, FileOptions.Asynchronous);
            var record = await JsonSerializer.DeserializeAsync<TransferRecord>(stream, cancellationToken: token);
            if (record is null || record.Id != id || record.Size < 0 || record.Type is not ("file" or "zip" or "text"))
                throw new JsonException("Invalid transfer metadata.");
            SafeFilename(record.Filename);
            if (record.CreatedAt == default) record.CreatedAt = File.GetLastWriteTimeUtc(metadata);
            return record;
        }
        catch (Exception ex) when (ex is IOException or JsonException or TransferException or UnauthorizedAccessException)
        {
            // One corrupt/disappearing record must not take down other transfers or the cleanup sweep.
            if (ex is not FileNotFoundException)
                _logger.LogWarning("Skipping unreadable metadata for transfer {TransferId}: {Reason}", id, ex.GetType().Name);
            return null;
        }
    }

    public IEnumerable<string> MetadataIds() => Directory.EnumerateFiles(_root, "*.meta.json")
        .Select(Path.GetFileName).Select(name => name![..^10]).Where(ValidId);

    public async Task<IReadOnlyList<TransferRecord>> ListAsync(int limit, CancellationToken token)
    {
        var records = new List<TransferRecord>();
        foreach (var id in MetadataIds())
        {
            token.ThrowIfCancellationRequested();
            try
            {
                var record = await ReadAsync(id, token);
                if (record is not null && record.ExpiresAt > DateTime.UtcNow && File.Exists(Resolve(id))) records.Add(record);
            }
            catch (TransferException) { _logger.LogWarning("Skipping unsafe content for {TransferId}.", id); }
        }
        return records.OrderByDescending(r => r.CreatedAt).ThenByDescending(r => r.Id).Take(limit).ToList();
    }

    public void Delete(string id)
    {
        // Withdraw metadata first, so no new download can start while content is being removed.
        var content = Resolve(id);
        var metadata = Resolve(id, ".meta.json");
        File.Delete(metadata);
        File.Delete(content);
    }

    public async Task CleanupAsync(CancellationToken token)
    {
        foreach (var id in MetadataIds())
        {
            token.ThrowIfCancellationRequested();
            try
            {
                var record = await ReadAsync(id, token);
                if (record is not null && record.ExpiresAt <= DateTime.UtcNow) Delete(id);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or TransferException)
            { _logger.LogWarning(ex, "Cleanup could not process transfer {TransferId}.", id); }
        }
    }
}
