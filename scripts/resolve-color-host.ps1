param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$BackendRoot = Join-Path $RepoRoot "vendor\\resolve-color-host"
$PythonPath = Join-Path $BackendRoot ".venv\\Scripts\\python.exe"
$HostScript = Join-Path $BackendRoot "resolve-color-host.py"

if (-not (Test-Path $HostScript)) {
  throw "Cannot find Resolve color host script at '$HostScript'. Expected fixed vendored backend root '$BackendRoot'."
}

if (-not (Test-Path $PythonPath)) {
  throw "Cannot find Resolve backend Python at '$PythonPath'. Create the fixed vendored backend venv under '$BackendRoot\\.venv' first."
}

& $PythonPath $HostScript @Arguments
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
