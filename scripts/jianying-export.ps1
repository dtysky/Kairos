param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$DefaultPython = Join-Path $RepoRoot "vendor\\pyJianYingDraft\\.venv\\Scripts\\python.exe"
$PythonPath = if ($env:KAIROS_JIANYING_PYTHON) { $env:KAIROS_JIANYING_PYTHON } else { $DefaultPython }
$ExportScript = Join-Path $PSScriptRoot "jianying-export.py"

if (-not (Test-Path $PythonPath)) {
  throw "Cannot find Jianying Python at '$PythonPath'. Create 'vendor/pyJianYingDraft/.venv' first or set KAIROS_JIANYING_PYTHON."
}

& $PythonPath $ExportScript @Arguments
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
