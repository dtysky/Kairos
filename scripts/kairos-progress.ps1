param(
  [ValidateSet("start", "stop", "restart", "status", "logs")]
  [string]$Action = "start",
  [Parameter(Mandatory = $true)]
  [string]$ProgressDir,
  [string]$ServerKey = "kairos-progress",
  [int]$Port = 8940,
  [string]$OpenBrowser = "true",
  [int]$Tail = 80
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ViewerTemplate = Join-Path $PSScriptRoot "style-analysis-progress-viewer.html"
$ViewerRoot = [System.IO.Path]::GetFullPath($ProgressDir)
$IndexPath = Join-Path $ViewerRoot "index.html"
$SafeServerKey = ($ServerKey -replace '[^A-Za-z0-9._-]', '-')
$RunRoot = Join-Path $RepoRoot ".tmp\\run\\$SafeServerKey"
$PidPath = Join-Path $RunRoot "server.pid"
$StdoutPath = Join-Path $RunRoot "stdout.log"
$StderrPath = Join-Path $RunRoot "stderr.log"
$MetaPath = Join-Path $RunRoot "server.json"

function Test-Truthy([string]$Value) {
  $normalized = ''
  if ($null -ne $Value) {
    $normalized = $Value.Trim().ToLowerInvariant()
  }
  return $normalized -in @('1', 'true', 'yes', 'on')
}

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
    throw "PID $targetPid does not look like $SafeServerKey."
  }
  return $process
}

function Get-AllViewerProcesses {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine.Contains("http.server") -and
      $_.CommandLine.Contains("$Port") -and
      $_.CommandLine.Contains("127.0.0.1")
    }
}

function Stop-Viewer {
  $tracked = @()
  $process = Get-TrackedProcess
  if ($null -ne $process) {
    $tracked += $process
  }
  foreach ($viewer in @(Get-AllViewerProcesses)) {
    if ($tracked.ProcessId -notcontains $viewer.ProcessId) {
      $tracked += $viewer
    }
  }
  $tracked = @($tracked | Sort-Object ProcessId -Unique)

  if ($tracked.Count -eq 0) {
    Remove-Item -Force $PidPath, $MetaPath -ErrorAction SilentlyContinue
    Write-Output "$SafeServerKey is not running."
    return
  }

  foreach ($viewer in $tracked) {
    Stop-Process -Id $viewer.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500
  Remove-Item -Force $PidPath, $MetaPath -ErrorAction SilentlyContinue
  Write-Output ("Stopped {0} instance(s): {1}" -f $SafeServerKey, (($tracked | Select-Object -ExpandProperty ProcessId) -join ", "))
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
    name = $SafeServerKey
    pid = $process.Id
    port = $Port
    viewerRoot = $ViewerRoot
    url = "http://127.0.0.1:$Port/"
    startedAt = (Get-Date).ToString("o")
  }
  Set-Content -Path $MetaPath -Value ($meta | ConvertTo-Json -Depth 4) -Encoding UTF8
  if (Test-Truthy $OpenBrowser) {
    Start-Process "http://127.0.0.1:$Port/"
  }
  Write-Output "Started $SafeServerKey on http://127.0.0.1:$Port/"
}

function Show-Status {
  $process = Get-TrackedProcess
  if ($null -eq $process) {
    Write-Output "$SafeServerKey is not running."
    return
  }
  $meta = if (Test-Path $MetaPath) { Get-Content -Raw $MetaPath | ConvertFrom-Json } else { $null }
  [ordered]@{
    name = $SafeServerKey
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
