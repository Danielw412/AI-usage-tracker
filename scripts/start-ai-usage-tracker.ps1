$ErrorActionPreference = "Stop"

$projectPath = Split-Path -Parent $PSScriptRoot
Set-Location $projectPath

$logDirectory = Join-Path $projectPath "logs"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

$stdoutLog = Join-Path $logDirectory "ai-usage-tracker.log"
$stderrLog = Join-Path $logDirectory "ai-usage-tracker-error.log"

$port = 8893
$envFile = Join-Path $projectPath ".env"
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*PORT\s*=\s*(\d+)\s*$') { $port = [int]$Matches[1] }
    }
}

# Replace any tracker already serving this port. An instance started from an
# agent's sandboxed shell keeps the port but cannot launch codex app-server, so
# running this script (or the scheduled task) must take over rather than bail.
$listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($processId in @($listeners | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique)) {
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
    if ($existing -and $existing.CommandLine -match 'dist-server[\\/]index\.js') {
        Stop-Process -Id $processId -Force
        Wait-Process -Id $processId -Timeout 10 -ErrorAction SilentlyContinue
    }
}

Start-Process `
    -FilePath "node.exe" `
    -ArgumentList "dist-server/index.js" `
    -WorkingDirectory $projectPath `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog
