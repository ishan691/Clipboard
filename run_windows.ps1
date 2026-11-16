# Native PowerShell alternative to run_windows.sh (Git Bash).
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js is required. Install Node.js and npm, then reopen PowerShell.'
    exit 1
}
& node (Join-Path $PSScriptRoot 'scripts/run-dev.mjs') @args
exit $LASTEXITCODE
