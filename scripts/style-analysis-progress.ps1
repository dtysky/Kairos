param(
  [ValidateSet("start", "stop", "restart", "status", "logs")]
  [string]$Action = "start",
  [string]$CategorySlug = "personal-serious-works",
  [int]$Port = 8940,
  [bool]$OpenBrowser = $true,
  [int]$Tail = 80
)

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ProgressDir = Join-Path $RepoRoot ".tmp\\style-analysis\\$CategorySlug"
$ServerKey = "style-analysis-progress-$CategorySlug"
$GenericScript = Join-Path $PSScriptRoot "kairos-progress.ps1"

& $GenericScript `
  -Action $Action `
  -ProgressDir $ProgressDir `
  -ServerKey $ServerKey `
  -Port $Port `
  -OpenBrowser $OpenBrowser `
  -Tail $Tail
