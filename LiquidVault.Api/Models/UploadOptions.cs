namespace LiquidVault.Api.Models;

public sealed class UploadOptions
{
    public string StoragePath { get; set; } = "Uploads";
    public long MaxFileSizeBytes { get; set; } = 10L * 1024 * 1024 * 1024;
    public int MaxBatchFiles { get; set; } = 50;
    public int MaxTextBytes { get; set; } = 1024 * 1024;
    public int ExpirationHours { get; set; } = 24;
    public int CleanupIntervalSeconds { get; set; } = 300;
}
