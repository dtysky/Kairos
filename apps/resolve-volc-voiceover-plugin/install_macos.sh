#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
USER_TARGET_ROOT="${HOME}/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Edit"
SYSTEM_TARGET_ROOT="/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Edit"
if [[ -d "${SYSTEM_TARGET_ROOT}" && -w "${SYSTEM_TARGET_ROOT}" ]]; then
  TARGET_ROOT="${SYSTEM_TARGET_ROOT}"
else
  TARGET_ROOT="${USER_TARGET_ROOT}"
fi
LEGACY_SYSTEM_DIR="${SYSTEM_TARGET_ROOT}/Kairos Volc Voiceover"
LEGACY_USER_DIR="${USER_TARGET_ROOT}/Kairos Volc Voiceover"
TARGET_LIB_DIR="${TARGET_ROOT}/KairosVolcVoiceoverLib"

rm -rf "${LEGACY_SYSTEM_DIR}" "${LEGACY_USER_DIR}"
rm -f "${SYSTEM_TARGET_ROOT}/Kairos Volc Voiceover.py" "${SYSTEM_TARGET_ROOT}/Kairos Script Probe.py" "${SYSTEM_TARGET_ROOT}/KairosVolcVoiceover.py" "${SYSTEM_TARGET_ROOT}/KairosVolcVoiceover.lua" "${SYSTEM_TARGET_ROOT}/KairosLuaProbe.lua"
rm -rf "${SYSTEM_TARGET_ROOT}/KairosVolcVoiceoverLib"
rm -f "${USER_TARGET_ROOT}/Kairos Volc Voiceover.py" "${USER_TARGET_ROOT}/Kairos Script Probe.py" "${USER_TARGET_ROOT}/KairosVolcVoiceover.py" "${USER_TARGET_ROOT}/KairosVolcVoiceover.lua" "${USER_TARGET_ROOT}/KairosLuaProbe.lua"
rm -rf "${USER_TARGET_ROOT}/KairosVolcVoiceoverLib"
mkdir -p "${TARGET_ROOT}" "${TARGET_LIB_DIR}"
cp "${SCRIPT_DIR}/KairosVolcVoiceover.lua" "${TARGET_ROOT}/KairosVolcVoiceover.lua"
cp "${SCRIPT_DIR}/Kairos Volc Voiceover.py" "${TARGET_LIB_DIR}/KairosVolcVoiceover.py"
cp "${SCRIPT_DIR}/kairos_volc_voiceover_core.py" "${TARGET_LIB_DIR}/kairos_volc_voiceover_core.py"
TARGET_LIB_DIR="${TARGET_LIB_DIR}" WORKSPACE_ROOT="${WORKSPACE_ROOT}" python3 - <<'PY'
import json
import os
from pathlib import Path
target = Path(os.environ["TARGET_LIB_DIR"]) / "kairos_workspace.json"
workspace = Path(os.environ["WORKSPACE_ROOT"])
target.write_text(json.dumps({
    "workspaceRoot": str(workspace),
    "runtimeConfigPath": str(workspace / "config" / "runtime.json"),
}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
chmod 755 "${TARGET_ROOT}/KairosVolcVoiceover.lua"
chmod 644 "${TARGET_LIB_DIR}/KairosVolcVoiceover.py" "${TARGET_LIB_DIR}/kairos_volc_voiceover_core.py" "${TARGET_LIB_DIR}/kairos_workspace.json"

installed_files=(
  "${TARGET_ROOT}/KairosVolcVoiceover.lua"
  "${TARGET_LIB_DIR}/KairosVolcVoiceover.py"
  "${TARGET_LIB_DIR}/kairos_volc_voiceover_core.py"
  "${TARGET_LIB_DIR}/kairos_workspace.json"
)

if [[ "${KAIROS_INSTALL_PROBES:-0}" == "1" ]]; then
  cp "${SCRIPT_DIR}/Kairos Lua Probe.lua" "${TARGET_ROOT}/KairosLuaProbe.lua"
  cp "${SCRIPT_DIR}/Kairos Script Probe.py" "${TARGET_LIB_DIR}/KairosScriptProbe.py"
  chmod 755 "${TARGET_ROOT}/KairosLuaProbe.lua"
  chmod 644 "${TARGET_LIB_DIR}/KairosScriptProbe.py"
  installed_files+=(
    "${TARGET_ROOT}/KairosLuaProbe.lua"
    "${TARGET_LIB_DIR}/KairosScriptProbe.py"
  )
fi

xattr -d com.apple.provenance "${installed_files[@]}" 2>/dev/null || true
xattr -d com.apple.quarantine "${installed_files[@]}" 2>/dev/null || true

echo "Installed Kairos Volc Voiceover to:"
echo "${TARGET_ROOT}/KairosVolcVoiceover.lua"
echo "${TARGET_LIB_DIR}/KairosVolcVoiceover.py"
echo "${TARGET_LIB_DIR}/kairos_volc_voiceover_core.py"
echo "${TARGET_LIB_DIR}/kairos_workspace.json"
if [[ "${KAIROS_INSTALL_PROBES:-0}" == "1" ]]; then
  echo "${TARGET_ROOT}/KairosLuaProbe.lua"
  echo "${TARGET_LIB_DIR}/KairosScriptProbe.py"
fi
echo
echo "Restart DaVinci Resolve, then open Workspace -> Scripts -> Edit -> KairosVolcVoiceover."
