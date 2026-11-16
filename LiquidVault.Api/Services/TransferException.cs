namespace LiquidVault.Api.Services;

public sealed class TransferException(string message, int statusCode = 400) : Exception(message)
{
    public int StatusCode { get; } = statusCode;
}
