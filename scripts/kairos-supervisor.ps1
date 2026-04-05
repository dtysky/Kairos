param(
  [string]$Action = "status"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $RepoRoot
try {
  & node "dist/supervisor/cli.js" $Action
} finally {
  Pop-Location
}
