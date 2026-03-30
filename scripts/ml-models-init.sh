#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
MODELS_DIR="$REPO_ROOT/models"
VENV_PYTHON="$REPO_ROOT/.venv-ml/bin/python"

WHISPER_REPO="${KAIROS_WHISPER_MODEL:-mlx-community/whisper-large-v3-turbo}"
WHISPER_LOCAL="whisper-large-v3-turbo"
CLIP_REPO="openai/clip-vit-base-patch32"
CLIP_LOCAL="clip-vit-base-patch32"
VLM_REPO="${KAIROS_VLM_MODEL_ID:-mlx-community/Qwen3-VL-4B-Instruct-8bit}"
VLM_LOCAL="Qwen3-VL-4B-Instruct-8bit"

if [[ ! -x "$VENV_PYTHON" ]]; then
    echo "ERROR: .venv-ml/bin/python not found."
    echo "Run the ML server setup first (see deploy-kairos skill)."
    exit 1
fi

ARCH=$("$VENV_PYTHON" -c "import platform; print(platform.machine())")
if [[ "$ARCH" != "arm64" ]]; then
    echo "WARNING: Python arch is $ARCH, not arm64. MLX requires Apple Silicon arm64 Python."
    exit 1
fi

mkdir -p "$MODELS_DIR"

echo "=== Kairos MLX Model Initialization ==="
echo "Python : $VENV_PYTHON ($ARCH)"
echo "Target : $MODELS_DIR/"
echo ""
echo "Models:"
echo "  [1/3] Whisper ASR : $WHISPER_REPO -> $WHISPER_LOCAL/"
echo "  [2/3] CLIP embed  : $CLIP_REPO -> $CLIP_LOCAL/"
echo "  [3/3] VLM (Qwen)  : $VLM_REPO -> $VLM_LOCAL/"
echo ""
if [[ -n "${HF_ENDPOINT:-}" ]]; then
    echo "HF mirror: $HF_ENDPOINT"
    echo ""
fi

echo "[1/3] Downloading Whisper: $WHISPER_REPO"
"$VENV_PYTHON" -c "
from huggingface_hub import snapshot_download
snapshot_download('${WHISPER_REPO}', local_dir='${MODELS_DIR}/${WHISPER_LOCAL}')
print('  -> done')
"

echo ""
echo "[2/3] Downloading & converting CLIP: $CLIP_REPO"
"$VENV_PYTHON" -c "
from mlx_clip import mlx_clip
m = mlx_clip('${MODELS_DIR}/${CLIP_LOCAL}', hf_repo='${CLIP_REPO}')
print('  -> done')
"

echo ""
echo "[3/3] Downloading VLM: $VLM_REPO"
"$VENV_PYTHON" -c "
from huggingface_hub import snapshot_download
snapshot_download('${VLM_REPO}', local_dir='${MODELS_DIR}/${VLM_LOCAL}')
print('  -> done')
"

echo ""
echo "=== All models initialized ==="
echo ""
du -sh "$MODELS_DIR"/*/ 2>/dev/null || true
