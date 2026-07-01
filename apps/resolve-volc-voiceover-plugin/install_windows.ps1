param(
  [switch]$InstallProbes
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkspaceRoot = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
$TargetRoot = Join-Path $env:APPDATA "Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Edit"
$TargetConfigDir = Join-Path $env:APPDATA "Blackmagic Design\DaVinci Resolve\Support\Fusion\Config\KairosVolcVoiceover"
$IpcRoot = Join-Path $WorkspaceRoot ".tmp\resolve-volc-voiceover-plugin\ipc"

New-Item -ItemType Directory -Force -Path $TargetRoot, $TargetConfigDir, (Join-Path $IpcRoot "requests"), (Join-Path $IpcRoot "processing"), (Join-Path $IpcRoot "responses") | Out-Null

$legacyNames = @(
  "Kairos Volc Voiceover",
  "Kairos Volc Voiceover.py",
  "Kairos Script Probe.py",
  "KairosVolcVoiceover.py",
  "KairosVolcVoiceover.lua",
  "KairosLuaProbe.lua"
)
foreach ($name in $legacyNames) {
  Remove-Item -LiteralPath (Join-Path $TargetRoot $name) -Recurse -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath (Join-Path $TargetRoot "KairosVolcVoiceoverLib") -Recurse -Force -ErrorAction SilentlyContinue

Copy-Item -LiteralPath (Join-Path $ScriptDir "KairosVolcVoiceover.lua") -Destination (Join-Path $TargetRoot "KairosVolcVoiceover.lua") -Force

$workspaceLink = [ordered]@{
  workspaceRoot = $WorkspaceRoot
  runtimeConfigPath = Join-Path $WorkspaceRoot "config\runtime.json"
  supervisorUrl = "http://127.0.0.1:8940"
  ipcRoot = $IpcRoot
}
$workspaceLink | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $TargetConfigDir "kairos_workspace.json") -Encoding UTF8

if ($InstallProbes -or $env:KAIROS_INSTALL_PROBES -eq "1") {
  Copy-Item -LiteralPath (Join-Path $ScriptDir "Kairos Lua Probe.lua") -Destination (Join-Path $TargetRoot "KairosLuaProbe.lua") -Force
}

Write-Host "Installed Kairos Volc Voiceover to:"
Write-Host (Join-Path $TargetRoot "KairosVolcVoiceover.lua")
Write-Host (Join-Path $TargetConfigDir "kairos_workspace.json")
Write-Host ""
Write-Host "Start Kairos Supervisor, restart DaVinci Resolve, then open Workspace -> Scripts -> Edit -> KairosVolcVoiceover."
