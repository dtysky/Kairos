#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
USER_DATA_ROOT="${HOME}/Library/Application Support/Blackmagic Design/DaVinci Resolve"
SYSTEM_DATA_ROOT="/Library/Application Support/Blackmagic Design/DaVinci Resolve"
TARGET_ROOT="${USER_DATA_ROOT}/Fusion/Scripts/Edit"
TARGET_CONFIG_DIR="${USER_DATA_ROOT}/Fusion/Config/KairosVolcVoiceover"
IPC_ROOT="${WORKSPACE_ROOT}/.tmp/resolve-volc-voiceover-plugin/ipc"

cleanup_scripts_root() {
  local data_root="$1"
  local scripts_root="${data_root}/Fusion/Scripts/Edit"
  rm -rf "${scripts_root}/Kairos Volc Voiceover" 2>/dev/null || true
  rm -f \
    "${scripts_root}/Kairos Volc Voiceover.py" \
    "${scripts_root}/Kairos Script Probe.py" \
    "${scripts_root}/KairosVolcVoiceover.py" \
    "${scripts_root}/KairosVolcVoiceover.lua" \
    "${scripts_root}/KairosLuaProbe.lua" 2>/dev/null || true
  rm -rf "${scripts_root}/KairosVolcVoiceoverLib" 2>/dev/null || true
}

cleanup_scripts_root "${USER_DATA_ROOT}"
cleanup_scripts_root "${SYSTEM_DATA_ROOT}"

mkdir -p "${TARGET_ROOT}" "${TARGET_CONFIG_DIR}" "${IPC_ROOT}/requests" "${IPC_ROOT}/processing" "${IPC_ROOT}/responses"
cp "${SCRIPT_DIR}/KairosVolcVoiceover.lua" "${TARGET_ROOT}/KairosVolcVoiceover.lua"
runtime_config="${WORKSPACE_ROOT}/config/runtime.json"
{
  printf '{\n'
  printf '  "workspaceRoot": "%s",\n' "${WORKSPACE_ROOT//\"/\\\"}"
  printf '  "runtimeConfigPath": "%s",\n' "${runtime_config//\"/\\\"}"
  printf '  "supervisorUrl": "http://127.0.0.1:8940",\n'
  printf '  "ipcRoot": "%s"\n' "${IPC_ROOT//\"/\\\"}"
  printf '}\n'
} > "${TARGET_CONFIG_DIR}/kairos_workspace.json"
chmod 755 "${TARGET_ROOT}/KairosVolcVoiceover.lua"
chmod 644 "${TARGET_CONFIG_DIR}/kairos_workspace.json"

installed_files=(
  "${TARGET_ROOT}/KairosVolcVoiceover.lua"
  "${TARGET_CONFIG_DIR}/kairos_workspace.json"
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
echo "${TARGET_CONFIG_DIR}/kairos_workspace.json"
if [[ "${KAIROS_INSTALL_PROBES:-0}" == "1" ]]; then
  echo "${TARGET_ROOT}/KairosLuaProbe.lua"
fi
echo
echo "Start Kairos Supervisor, restart DaVinci Resolve, then open Workspace -> Scripts -> Edit -> KairosVolcVoiceover."
