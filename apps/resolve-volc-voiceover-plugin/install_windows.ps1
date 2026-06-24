param(
  [switch]$InstallProbes
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkspaceRoot = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
$TargetRoot = Join-Path $env:APPDATA "Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Edit"
$TargetLibDir = Join-Path $TargetRoot "KairosVolcVoiceoverLib"

$PythonExecutable = $env:KAIROS_PYTHON
if (-not $PythonExecutable) {
  $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
  if ($pythonCommand) {
    $PythonExecutable = $pythonCommand.Source
  }
}
if (-not $PythonExecutable) {
  throw "Python executable not found. Install Python or set KAIROS_PYTHON to python.exe before running this installer."
}

New-Item -ItemType Directory -Force -Path $TargetRoot, $TargetLibDir | Out-Null

$legacyNames = @(
  "Kairos Volc Voiceover.py",
  "Kairos Script Probe.py",
  "KairosVolcVoiceover.py",
  "KairosVolcVoiceover.lua",
  "KairosLuaProbe.lua"
)
foreach ($name in $legacyNames) {
  Remove-Item -LiteralPath (Join-Path $TargetRoot $name) -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $TargetLibDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $TargetLibDir | Out-Null

Copy-Item -LiteralPath (Join-Path $ScriptDir "KairosVolcVoiceover.lua") -Destination (Join-Path $TargetRoot "KairosVolcVoiceover.lua") -Force
Copy-Item -LiteralPath (Join-Path $ScriptDir "Kairos Volc Voiceover.py") -Destination (Join-Path $TargetLibDir "KairosVolcVoiceover.py") -Force
Copy-Item -LiteralPath (Join-Path $ScriptDir "kairos_volc_voiceover_core.py") -Destination (Join-Path $TargetLibDir "kairos_volc_voiceover_core.py") -Force

$workspaceLink = [ordered]@{
  workspaceRoot = $WorkspaceRoot
  runtimeConfigPath = Join-Path $WorkspaceRoot "config\runtime.json"
  pythonExecutable = $PythonExecutable
}
$workspaceLink | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $TargetLibDir "kairos_workspace.json") -Encoding UTF8

if ($InstallProbes -or $env:KAIROS_INSTALL_PROBES -eq "1") {
  Copy-Item -LiteralPath (Join-Path $ScriptDir "Kairos Lua Probe.lua") -Destination (Join-Path $TargetRoot "KairosLuaProbe.lua") -Force
  Copy-Item -LiteralPath (Join-Path $ScriptDir "Kairos Script Probe.py") -Destination (Join-Path $TargetLibDir "KairosScriptProbe.py") -Force
}

Write-Host "Installed Kairos Volc Voiceover to:"
Write-Host (Join-Path $TargetRoot "KairosVolcVoiceover.lua")
Write-Host (Join-Path $TargetLibDir "KairosVolcVoiceover.py")
Write-Host (Join-Path $TargetLibDir "kairos_volc_voiceover_core.py")
Write-Host (Join-Path $TargetLibDir "kairos_workspace.json")
Write-Host ""
Write-Host "Restart DaVinci Resolve, then open Workspace -> Scripts -> Edit -> KairosVolcVoiceover."
