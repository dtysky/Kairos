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
IPC_ROOT="${WORKSPACE_ROOT}/.tmp/resolve-volc-voiceover-plugin/ipc"

rm -rf "${LEGACY_SYSTEM_DIR}" "${LEGACY_USER_DIR}"
rm -f "${SYSTEM_TARGET_ROOT}/Kairos Volc Voiceover.py" "${SYSTEM_TARGET_ROOT}/Kairos Script Probe.py" "${SYSTEM_TARGET_ROOT}/KairosVolcVoiceover.py" "${SYSTEM_TARGET_ROOT}/KairosVolcVoiceover.lua" "${SYSTEM_TARGET_ROOT}/KairosLuaProbe.lua"
rm -rf "${SYSTEM_TARGET_ROOT}/KairosVolcVoiceoverLib"
rm -f "${USER_TARGET_ROOT}/Kairos Volc Voiceover.py" "${USER_TARGET_ROOT}/Kairos Script Probe.py" "${USER_TARGET_ROOT}/KairosVolcVoiceover.py" "${USER_TARGET_ROOT}/KairosVolcVoiceover.lua" "${USER_TARGET_ROOT}/KairosLuaProbe.lua"
rm -rf "${USER_TARGET_ROOT}/KairosVolcVoiceoverLib"
mkdir -p "${TARGET_ROOT}" "${TARGET_LIB_DIR}" "${IPC_ROOT}/requests" "${IPC_ROOT}/processing" "${IPC_ROOT}/responses"
cp "${SCRIPT_DIR}/KairosVolcVoiceover.lua" "${TARGET_ROOT}/KairosVolcVoiceover.lua"
runtime_config="${WORKSPACE_ROOT}/config/runtime.json"
{
  printf '{\n'
  printf '  "workspaceRoot": "%s",\n' "${WORKSPACE_ROOT//\"/\\\"}"
  printf '  "runtimeConfigPath": "%s",\n' "${runtime_config//\"/\\\"}"
  printf '  "supervisorUrl": "http://127.0.0.1:8940",\n'
  printf '  "ipcRoot": "%s"\n' "${IPC_ROOT//\"/\\\"}"
  printf '}\n'
} > "${TARGET_LIB_DIR}/kairos_workspace.json"
chmod 755 "${TARGET_ROOT}/KairosVolcVoiceover.lua"
chmod 644 "${TARGET_LIB_DIR}/kairos_workspace.json"

installed_files=(
  "${TARGET_ROOT}/KairosVolcVoiceover.lua"
  "${TARGET_LIB_DIR}/kairos_workspace.json"
)

if [[ "${KAIROS_INSTALL_PROBES:-0}" == "1" ]]; then
  cp "${SCRIPT_DIR}/Kairos Lua Probe.lua" "${TARGET_ROOT}/KairosLuaProbe.lua"
  chmod 755 "${TARGET_ROOT}/KairosLuaProbe.lua"
  installed_files+=(
    "${TARGET_ROOT}/KairosLuaProbe.lua"
  )
fi

xattr -d com.apple.provenance "${installed_files[@]}" 2>/dev/null || true
xattr -d com.apple.quarantine "${installed_files[@]}" 2>/dev/null || true

echo "Installed Kairos Volc Voiceover to:"
echo "${TARGET_ROOT}/KairosVolcVoiceover.lua"
echo "${TARGET_LIB_DIR}/kairos_workspace.json"
if [[ "${KAIROS_INSTALL_PROBES:-0}" == "1" ]]; then
  echo "${TARGET_ROOT}/KairosLuaProbe.lua"
fi
echo
echo "Start Kairos Supervisor, restart DaVinci Resolve, then open Workspace -> Scripts -> Edit -> KairosVolcVoiceover."
