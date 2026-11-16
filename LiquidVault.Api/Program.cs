using LiquidVault.Api.Models;
using LiquidVault.Api.Services;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
builder.Services.AddProblemDetails();
builder.Services.AddOptions<UploadOptions>().BindConfiguration("UploadSettings")
    .Validate(o => o.MaxFileSizeBytes > 0 && o.MaxFileSizeBytes <= 1L << 40, "File limit must be between 1 byte and 1 TiB.")
    .Validate(o => o.MaxBatchFiles is >= 1 and <= 100 && o.MaxTextBytes is >= 1 and <= 1048576
        && o.ExpirationHours is >= 1 and <= 8760 && o.CleanupIntervalSeconds is >= 1 and <= 86400,
        "Invalid upload/retention settings.").ValidateOnStart();
var limits = builder.Configuration.GetSection("UploadSettings").Get<UploadOptions>() ?? new UploadOptions();
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = checked(limits.MaxFileSizeBytes + 8L * 1024 * 1024));
builder.Services.AddSingleton<TransferStore>();
builder.Services.AddHostedService<CleanupService>();

var app = builder.Build();
// Initialize the storage volume before serving requests or starting the worker.
_ = app.Services.GetRequiredService<TransferStore>();
app.UseExceptionHandler(handler => handler.Run(async context =>
{
    var exception = context.Features.Get<Microsoft.AspNetCore.Diagnostics.IExceptionHandlerFeature>()?.Error;
    if (exception is OperationCanceledException && context.RequestAborted.IsCancellationRequested) return;
    var status = exception switch
    {
        TransferException transfer => transfer.StatusCode,
        BadHttpRequestException request => request.StatusCode,
        InvalidDataException => 400,
        IOException => 503,
        _ => 500
    };
    var message = exception is TransferException ? exception.Message : status == 413 ? "The request is too large."
        : status == 400 ? "The upload is incomplete or malformed." : "The transfer could not be completed. Please retry.";
    await Results.Problem(statusCode: status, title: message).ExecuteAsync(context);
}));
app.Use(async (context, next) =>
{
    context.Response.Headers.XContentTypeOptions = "nosniff";
    context.Response.Headers.CacheControl = "no-store";
    // UI requests use the same-origin proxy; no permissive browser CORS policy is needed.
    // Reject cross-origin mutations, including simple form requests from unrelated sites.
    if (context.Request.Method is not ("GET" or "HEAD" or "OPTIONS")
        && context.Request.Headers.TryGetValue("Origin", out var origin)
        && (!Uri.TryCreate(origin.ToString(), UriKind.Absolute, out var uri)
            || !string.Equals(uri.Authority, context.Request.Host.Value, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(uri.Scheme, context.Request.Scheme, StringComparison.OrdinalIgnoreCase)))
    {
        await Results.Problem(statusCode: 403, title: "Cross-origin changes are not allowed.").ExecuteAsync(context);
        return;
    }
    await next();
});
app.MapGet("/health", () => Results.Ok(new { status = "online" }));
app.MapControllers();
app.Run();
