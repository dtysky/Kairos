#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
VENV_PYTHON="$REPO_ROOT/.venv-ml/bin/python"

WHISPER_MODEL="${KAIROS_WHISPER_MODEL:-mlx-community/whisper-large-v3-turbo}"
CLIP_MODEL="openai/clip-vit-base-patch32"
VLM_MODEL="${KAIROS_VLM_MODEL_ID:-mlx-community/Qwen3-VL-4B-Instruct-8bit}"

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

echo "=== Kairos MLX Model Initialization ==="
echo "Python:  $VENV_PYTHON ($ARCH)"
echo ""
echo "Models to download:"
echo "  [1/3] Whisper ASR : $WHISPER_MODEL"
echo "  [2/3] CLIP embed  : $CLIP_MODEL"
echo "  [3/3] VLM (Qwen)  : $VLM_MODEL"
echo ""
if [[ -n "${HF_ENDPOINT:-}" ]]; then
    echo "HF mirror: $HF_ENDPOINT"
    echo ""
fi

echo "[1/3] Downloading Whisper model: $WHISPER_MODEL"
"$VENV_PYTHON" -c "
from huggingface_hub import snapshot_download
snapshot_download('${WHISPER_MODEL}')
print('  -> Whisper model ready')
"

echo ""
echo "[2/3] Downloading & converting CLIP model: $CLIP_MODEL"
"$VENV_PYTHON" -c "
from mlx_clip import mlx_clip
m = mlx_clip('${CLIP_MODEL}')
print('  -> CLIP model ready')
"

echo ""
echo "[3/3] Downloading VLM model: $VLM_MODEL"
"$VENV_PYTHON" -c "
from mlx_vlm import load
model, processor = load('${VLM_MODEL}')
print('  -> VLM model ready')
"

echo ""
echo "=== All models initialized ==="
echo ""
echo "Cached models:"
"$VENV_PYTHON" -c "
from huggingface_hub import scan_cache_dir
info = scan_cache_dir()
for repo in sorted(info.repos, key=lambda r: r.repo_id):
    print(f'  {repo.repo_id}  ({repo.size_on_disk / (1024**2):.0f} MB)')
"
