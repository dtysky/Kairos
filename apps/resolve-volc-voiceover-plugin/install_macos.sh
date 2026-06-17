#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_ROOT="/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Edit"
TARGET_DIR="${TARGET_ROOT}/Kairos Volc Voiceover"

mkdir -p "${TARGET_DIR}"
cp "${SCRIPT_DIR}/Kairos Volc Voiceover.py" "${TARGET_DIR}/Kairos Volc Voiceover.py"
cp "${SCRIPT_DIR}/kairos_volc_voiceover_core.py" "${TARGET_DIR}/kairos_volc_voiceover_core.py"

echo "Installed Kairos Volc Voiceover to:"
echo "${TARGET_DIR}"
echo
echo "Restart DaVinci Resolve, then open Workspace -> Scripts -> Edit -> Kairos Volc Voiceover."
