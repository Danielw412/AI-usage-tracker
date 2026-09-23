$ErrorActionPreference = "Stop"

$projectPath = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $projectPath "scripts\start-ai-usage-tracker.ps1"
$taskName = "AI Usage Tracker"
$user = "$env:USERDOMAIN\$env:USERNAME"

# The task used to be called "Codex Usage Dashboard" and ran start-dashboard.ps1,
# which no longer exists. Left registered, it fails silently at every sign-in.
foreach ($legacyTaskName in @("Codex Usage Dashboard")) {
    if (Get-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue) {
        try {
            Unregister-ScheduledTask -TaskName $legacyTaskName -Confirm:$false
            Write-Host "Removed the old '$legacyTaskName' startup task."
        } catch {
            Write-Warning "Could not remove the old '$legacyTaskName' task (it was registered as administrator). From an administrator PowerShell run: Unregister-ScheduledTask -TaskName '$legacyTaskName' -Confirm:`$false"
        }
    }
}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`""

# Scoped to the current user so installing does not need an administrator shell.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Days 3650)

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Collect AI usage, quota, and token history in the background." `
    -Force | Out-Null

# Start (or restart) the tracker now instead of waiting for the next sign-in.
Start-ScheduledTask -TaskName $taskName

Write-Host "AI Usage Tracker is running and will start automatically when you sign in."
