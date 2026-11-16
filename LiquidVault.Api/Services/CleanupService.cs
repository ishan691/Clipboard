namespace LiquidVault.Api.Services;

public sealed class CleanupService(TransferStore store, ILogger<CleanupService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(store.Options.CleanupIntervalSeconds));
        try
        {
            do
            {
                try { await store.CleanupAsync(stoppingToken); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                { logger.LogWarning(ex, "Cleanup will retry on the next sweep."); }
            } while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
}
