param(
  [ValidateSet("start", "stop", "restart", "status", "logs")]
  [string]$Action = "status",
  [string]$ServerHost = "127.0.0.1",
  [int]$Port = 8910,
  [int]$Tail = 80,
  [string]$PythonPath
)

$ErrorActionPreference = "Stop"

$ServerName = "kairos-ml"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$MlServerRoot = Join-Path $RepoRoot "ml-server"
$RunRoot = Join-Path $RepoRoot ".tmp\\run\\$ServerName"
$PidPath = Join-Path $RunRoot "server.pid"
$MetaPath = Join-Path $RunRoot "server.json"
$StdoutPath = Join-Path $RunRoot "stdout.log"
$StderrPath = Join-Path $RunRoot "stderr.log"
$CommandArgs = @("-m", "uvicorn", "kairos_ml.main:app", "--host", $ServerHost, "--port", "$Port")
$ExpectedMarker = "kairos_ml.main:app"

function Ensure-RunRoot {
  New-Item -ItemType Directory -Force -Path $RunRoot | Out-Null
}

function Resolve-PythonPath {
  if ($PythonPath) {
    return $PythonPath
  }

  $defaultPath = Join-Path $RepoRoot ".venv-ml\\Scripts\\python.exe"
  if (Test-Path $defaultPath) {
    return $defaultPath
  }

  throw "Cannot find Python executable. Pass -PythonPath or create .venv-ml\\Scripts\\python.exe."
}

function Test-CommandLineMatch([string]$CommandLine) {
  return $CommandLine -and $CommandLine.Contains($ExpectedMarker)
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
    Remove-Item -Force $PidPath -ErrorAction SilentlyContinue
    Remove-Item -Force $MetaPath -ErrorAction SilentlyContinue
    return $null
  }

  if (-not (Test-CommandLineMatch $process.CommandLine)) {
    throw "PID $targetPid exists but does not look like $ServerName. Refusing to manage it."
  }

  return $process
}

function Get-AllServerProcesses {
  Get-CimInstance Win32_Process |
    Where-Object {
      Test-CommandLineMatch $_.CommandLine -or
      ($_.CommandLine -and $_.CommandLine.Contains("--host $ServerHost") -and $_.CommandLine.Contains("--port $Port"))
    }
}

function Remove-StateFiles {
  Remove-Item -Force $PidPath -ErrorAction SilentlyContinue
  Remove-Item -Force $MetaPath -ErrorAction SilentlyContinue
}

function Stop-TrackedProcesses {
  $tracked = @()
  $trackedProcess = Get-TrackedProcess
  if ($null -ne $trackedProcess) {
    $tracked += $trackedProcess
  }

  $all = @(Get-AllServerProcesses)
  foreach ($process in $all) {
    if ($tracked.ProcessId -notcontains $process.ProcessId) {
      $tracked += $process
    }
  }

  $tracked = @($tracked | Sort-Object ProcessId -Unique)

  if ($tracked.Count -eq 0) {
    Remove-StateFiles
    Write-Output "$ServerName is not running."
    return
  }

  foreach ($process in $tracked) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }

  Start-Sleep -Seconds 1
  Remove-StateFiles
  Write-Output ("Stopped {0} instance(s): {1}" -f $ServerName, (($tracked | Select-Object -ExpandProperty ProcessId) -join ", "))
}

function Test-Health {
  try {
    $response = & curl.exe --silent --show-error --noproxy "*" "http://$ServerHost`:$Port/health"
    if (-not $response) {
      return $null
    }
    return $response | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Write-Metadata([int]$ProcessId, [string]$Python) {
  $meta = [ordered]@{
    name = $ServerName
    pid = $ProcessId
    host = $ServerHost
    port = $Port
    pythonPath = $Python
    workingDirectory = $MlServerRoot
    startedAt = (Get-Date).ToString("o")
    command = @($Python) + $CommandArgs
    stdoutPath = $StdoutPath
    stderrPath = $StderrPath
  }
  Set-Content -Path $PidPath -Value "$ProcessId" -Encoding UTF8
  Set-Content -Path $MetaPath -Value ($meta | ConvertTo-Json -Depth 5) -Encoding UTF8
}

function Start-Server {
  Ensure-RunRoot
  $python = Resolve-PythonPath

  if (-not (Test-Path $MlServerRoot)) {
    throw "Cannot find ml-server directory: $MlServerRoot"
  }

  Stop-TrackedProcesses | Out-Null
  Remove-Item -Force $StdoutPath, $StderrPath -ErrorAction SilentlyContinue

  $process = Start-Process `
    -FilePath $python `
    -ArgumentList $CommandArgs `
    -WorkingDirectory $MlServerRoot `
    -RedirectStandardOutput $StdoutPath `
    -RedirectStandardError $StderrPath `
    -WindowStyle Hidden `
    -PassThru

  Write-Metadata -ProcessId $process.Id -Python $python

  $health = $null
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    $health = Test-Health
    if ($null -ne $health) {
      break
    }

    $live = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)" -ErrorAction SilentlyContinue
    if ($null -eq $live) {
      break
    }
  }

  if ($null -eq $health) {
    $stderrTail = if (Test-Path $StderrPath) { Get-Content -Tail 40 $StderrPath } else { @() }
    throw ("{0} failed to become healthy on {1}:{2}.`n{3}" -f $ServerName, $ServerHost, $Port, ($stderrTail -join [Environment]::NewLine))
  }

  Write-Output ("Started {0} (PID {1}) on {2}:{3} with device={4}" -f $ServerName, $process.Id, $ServerHost, $Port, $health.device)
}

function Show-Status {
  $process = Get-TrackedProcess
  $health = Test-Health

  if ($null -eq $process) {
    Write-Output "$ServerName is not running."
    return
  }

  $status = [ordered]@{
    name = $ServerName
    pid = $process.ProcessId
    running = $true
    host = $ServerHost
    port = $Port
    commandLine = $process.CommandLine
    health = $health
    stdoutPath = $StdoutPath
    stderrPath = $StderrPath
  }
  $status | ConvertTo-Json -Depth 5
}

function Show-Logs {
  Ensure-RunRoot
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
  "start" { Start-Server }
  "stop" { Stop-TrackedProcesses }
  "restart" {
    Stop-TrackedProcesses | Out-Null
    Start-Server
  }
  "status" { Show-Status }
  "logs" { Show-Logs }
}
