param(
  [ValidateSet("start", "stop", "restart", "status", "logs")]
  [string]$Action = "start",
  [string]$CategorySlug = "personal-serious-works",
  [int]$Port = 8940,
  [switch]$OpenBrowser = $true,
  [int]$Tail = 80
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ViewerTemplate = Join-Path $PSScriptRoot "style-analysis-progress-viewer.html"
$ViewerRoot = Join-Path $RepoRoot ".tmp\\style-analysis\\$CategorySlug"
$IndexPath = Join-Path $ViewerRoot "index.html"
$RunRoot = Join-Path $RepoRoot ".tmp\\run\\style-analysis-progress-$CategorySlug"
$PidPath = Join-Path $RunRoot "server.pid"
$StdoutPath = Join-Path $RunRoot "stdout.log"
$StderrPath = Join-Path $RunRoot "stderr.log"
$MetaPath = Join-Path $RunRoot "server.json"
$ServerName = "style-analysis-progress-$CategorySlug"

function Ensure-Dirs {
  New-Item -ItemType Directory -Force -Path $ViewerRoot | Out-Null
  New-Item -ItemType Directory -Force -Path $RunRoot | Out-Null
}

function Resolve-PythonPath {
  $defaultPath = Join-Path $RepoRoot ".venv-ml\\Scripts\\python.exe"
  if (Test-Path $defaultPath) {
    return $defaultPath
  }
  $py = Get-Command python -ErrorAction SilentlyContinue
  if ($py) {
    return $py.Source
  }
  throw "Cannot find Python runtime for progress viewer."
}

function Sync-ViewerFiles {
  Ensure-Dirs
  Copy-Item -LiteralPath $ViewerTemplate -Destination $IndexPath -Force
}

function Get-TrackedProcess {
  if (-not (Test-Path $PidPath)) {
    return $null
  }
  $pidText = (Get-Content -Raw $PidPath).Trim()
  if (-not $pidText) {
    return $null
  }
  $targetPid = [int]$pidText
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid" -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    Remove-Item -Force $PidPath, $MetaPath -ErrorAction SilentlyContinue
    return $null
  }
  if (-not ($process.CommandLine -and $process.CommandLine.Contains("http.server") -and $process.CommandLine.Contains("$Port"))) {
    throw "PID $targetPid does not look like $ServerName."
  }
  return $process
}

function Stop-Viewer {
  $process = Get-TrackedProcess
  if ($null -eq $process) {
    Remove-Item -Force $PidPath, $MetaPath -ErrorAction SilentlyContinue
    Write-Output "$ServerName is not running."
    return
  }
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Remove-Item -Force $PidPath, $MetaPath -ErrorAction SilentlyContinue
  Write-Output "Stopped $ServerName ($($process.ProcessId))."
}

function Start-Viewer {
  Sync-ViewerFiles
  Stop-Viewer | Out-Null
  Remove-Item -Force $StdoutPath, $StderrPath -ErrorAction SilentlyContinue
  $python = Resolve-PythonPath
  $process = Start-Process `
    -FilePath $python `
    -ArgumentList "-m", "http.server", "$Port", "--bind", "127.0.0.1" `
    -WorkingDirectory $ViewerRoot `
    -RedirectStandardOutput $StdoutPath `
    -RedirectStandardError $StderrPath `
    -WindowStyle Hidden `
    -PassThru
  Set-Content -Path $PidPath -Value "$($process.Id)" -Encoding UTF8
  $meta = [ordered]@{
    name = $ServerName
    pid = $process.Id
    port = $Port
    viewerRoot = $ViewerRoot
    url = "http://127.0.0.1:$Port/"
    startedAt = (Get-Date).ToString("o")
  }
  Set-Content -Path $MetaPath -Value ($meta | ConvertTo-Json -Depth 4) -Encoding UTF8
  if ($OpenBrowser) {
    Start-Process "http://127.0.0.1:$Port/"
  }
  Write-Output "Started $ServerName on http://127.0.0.1:$Port/"
}

function Show-Status {
  $process = Get-TrackedProcess
  if ($null -eq $process) {
    Write-Output "$ServerName is not running."
    return
  }
  $meta = if (Test-Path $MetaPath) { Get-Content -Raw $MetaPath | ConvertFrom-Json } else { $null }
  [ordered]@{
    name = $ServerName
    pid = $process.ProcessId
    running = $true
    port = $Port
    viewerRoot = $ViewerRoot
    url = if ($meta) { $meta.url } else { "http://127.0.0.1:$Port/" }
  } | ConvertTo-Json -Depth 3
}

function Show-Logs {
  if (Test-Path $StdoutPath) {
    Write-Output "=== stdout ==="
    Get-Content -Tail $Tail $StdoutPath
  }
  if (Test-Path $StderrPath) {
    Write-Output "=== stderr ==="
    Get-Content -Tail $Tail $StderrPath
  }
}

switch ($Action) {
  "start" { Start-Viewer }
  "stop" { Stop-Viewer }
  "restart" {
    Stop-Viewer | Out-Null
    Start-Viewer
  }
  "status" { Show-Status }
  "logs" { Show-Logs }
}
