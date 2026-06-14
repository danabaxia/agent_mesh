<#
.SYNOPSIS
  Restart the agent-mesh dashboard cleanly on Windows.
.DESCRIPTION
  Stops stale agent-mesh dashboard node processes, clears the requested port,
  then starts a fresh dashboard server for the mesh. By default it starts hidden
  on port 7078 with shell + dashboard chat enabled.
.EXAMPLE
  ./scripts/start-dashboard.ps1
  ./scripts/start-dashboard.ps1 -MeshRoot C:\AI\agents_mesh\my-mesh -Port 7078
  ./scripts/start-dashboard.ps1 -Foreground
#>
param(
  [string]$MeshRoot,
  [int]$Port = 7078,
  [switch]$Foreground
)
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $MeshRoot) {
  $MeshRoot = Join-Path $RepoRoot 'my-mesh'
}
$MeshRoot = (Resolve-Path -LiteralPath $MeshRoot).Path

function Stop-ProcessTreeById([int]$ProcessId, [string]$Reason) {
  if ($ProcessId -eq $PID) { return }
  Write-Host "Stopping PID $ProcessId ($Reason)..."
  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    return
  } catch {
    $stopError = $_.Exception.Message
  }

  # Call taskkill.exe directly (no cmd.exe wrapper): `& cmd.exe /c …` produced a
  # powershell→cmd.exe lineage that CrowdStrike/EDR flags. PowerShell runs
  # taskkill.exe directly and 2>&1 merges its streams natively.
  $taskkillOutput = & taskkill /pid $ProcessId /T /F 2>&1
  if ($LASTEXITCODE -eq 0) {
    $taskkillOutput | Out-Host
  } else {
    $taskkillOutput | Out-Host
    Write-Warning "Could not stop PID ${ProcessId}: $stopError"
  }
}

function Stop-StaleDashboards {
  try {
    $dashboards = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
      Where-Object { $_.CommandLine -like '*agent-mesh.js dashboard*' }
    foreach ($proc in $dashboards) {
      Stop-ProcessTreeById -ProcessId ([int]$proc.ProcessId) -Reason 'stale agent-mesh dashboard'
    }
  } catch {
    # Some managed Windows environments deny command-line process inspection.
    # Port-owner cleanup below is the reliable path for replacing this dashboard.
  }
}

function Stop-PortOwner([int]$LocalPort) {
  $owners = @()
  try {
    $pattern = "^\s*TCP\s+(?:\S+:$LocalPort|\[[^\]]+\]:$LocalPort)\s+\S+\s+LISTENING\s+(\d+)\s*$"
    $owners = @(netstat -ano |
      ForEach-Object {
        if ($_ -match $pattern) { [int]$Matches[1] }
      } |
      Where-Object { $_ -gt 0 } |
      Select-Object -Unique
    )
  } catch {
    $owners = @()
  }

  if (-not $owners -or $owners.Count -eq 0) {
    try {
      $owners = @(Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction Stop |
        Select-Object -ExpandProperty OwningProcess |
        Where-Object { $_ -gt 0 } |
        Select-Object -Unique
      )
    } catch {
      Write-Warning "Could not inspect port ${LocalPort}: $($_.Exception.Message)"
    }
  }

  foreach ($owner in $owners) {
    if ($owner -and $owner -ne $PID) {
      Stop-ProcessTreeById -ProcessId ([int]$owner) -Reason "listener on port $LocalPort"
    }
  }
}

function Wait-PortClear([int]$LocalPort) {
  for ($i = 0; $i -lt 20; $i++) {
    $busy = $false
    try {
      $busy = [bool](netstat -ano | Select-String ":$LocalPort\s+.*LISTENING")
    } catch {
      $busy = $false
    }
    if (-not $busy) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Port $LocalPort is still busy after cleanup."
}

Set-Location $RepoRoot
Stop-StaleDashboards
Stop-PortOwner -LocalPort $Port
Wait-PortClear -LocalPort $Port

$argsList = @(
  '.\bin\agent-mesh.js',
  'dashboard',
  $MeshRoot,
  '--allow-shell',
  '--enable-chat',
  '--no-open',
  '--port',
  [string]$Port
)

if ($Foreground) {
  Write-Host "Starting dashboard in foreground on http://127.0.0.1:$Port ..."
  & node @argsList
  exit $LASTEXITCODE
}

$proc = Start-Process -FilePath 'node' -ArgumentList $argsList -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru
Start-Sleep -Milliseconds 800
if ($proc.HasExited) {
  Write-Error "Dashboard exited immediately with code $($proc.ExitCode). Try -Foreground to see the error."
}

$tokenPath = Join-Path $MeshRoot '.agent-mesh\dashboard-token'
$token = if (Test-Path -LiteralPath $tokenPath) { (Get-Content -LiteralPath $tokenPath -Raw).Trim() } else { '' }
$url = if ($token) { "http://127.0.0.1:$Port/?t=$token" } else { "http://127.0.0.1:$Port/" }

Write-Host "Dashboard PID: $($proc.Id)"
Write-Host "Dashboard URL: $url"
