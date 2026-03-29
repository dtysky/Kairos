---
name: deploy-kairos
description: >-
  Deploy the Kairos middle-version project on a new device. Covers Node.js core,
  Python ML server, jianying-mcp submodule, and LLM API configuration.
  Use when setting up Kairos on a fresh machine, cross-device deployment,
  or when the user mentions deploy, install, setup, or environment.
---

# Deploy Kairos (Middle Version)

Full deployment guide for a new device. Kairos has three subsystems:

| Subsystem | Runtime | Location | Required |
|-----------|---------|----------|----------|
| TypeScript core | Node.js >= 18 + pnpm | `./` (root) | Always |
| ML server | Python >= 3.10 + uv/pip | `ml-server/` | For media analysis |
| Jianying MCP | Python >= 3.13 + uv | `vendor/jianying-mcp/` | For Jianying export |

## Prerequisites Checklist

Copy and track progress:

```
- [ ] Git (with submodule support)
- [ ] Node.js >= 18
- [ ] pnpm (corepack enable && corepack prepare pnpm@latest --activate)
- [ ] Python >= 3.10 (recommend 3.12+, 3.13 for jianying-mcp)
- [ ] uv (curl -LsSf https://astral.sh/uv/install.sh | sh)
- [ ] ffmpeg + ffprobe (media analysis)
- [ ] GPU driver (optional, for ML acceleration)
```

## Step 1: Clone & Init Submodules

```bash
git clone --recurse-submodules <REPO_URL> Kairos
cd Kairos
```

If already cloned without submodules:

```bash
git submodule update --init --recursive
```

Verify: `ls vendor/jianying-mcp/jianyingdraft/server.py` should exist.

## Step 2: TypeScript Core

```bash
pnpm install
pnpm build
```

Verify: `ls dist/index.js` should exist and `npx tsc --noEmit` should pass.

## Step 3: ML Server (media analysis)

### 3a. Detect platform

| Platform | Device | Notes |
|----------|--------|-------|
| Windows + NVIDIA GPU | `cuda` | Install CUDA toolkit + cuDNN first |
| macOS Apple Silicon | `mps` | Works out of box, slower than CUDA |
| Linux / macOS Intel | `cpu` | Functional but slow for inference |

### 3b. Install dependencies

```bash
cd ml-server
uv venv && uv pip install -e ".[ocr]"
```

For Windows with CUDA, install PyTorch with CUDA first:

```bash
uv pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
uv pip install -e ".[ocr]"
```

For EasyOCR instead of PaddleOCR:

```bash
uv pip install -e ".[ocr-easy]"
```

### 3c. Start ML server

```bash
kairos-ml
# or: uv run python -m kairos_ml.main
```

Verify: `curl http://127.0.0.1:8910/health` should return `{"status":"ok","device":"cuda"}`

## Step 4: Jianying MCP (optional, for Jianying export)

```bash
cd vendor/jianying-mcp
uv sync
```

**Note**: jianying-mcp requires Python >= 3.13. If your system Python is older, use:

```bash
uv python install 3.13
uv sync
```

No need to start separately — Kairos spawns it via stdio on demand.

### Configure paths

When using `createJianyingMcpCaller`, provide:

| Param | Meaning | Example |
|-------|---------|---------|
| `jianyingMcpRoot` | Submodule root | `./vendor/jianying-mcp` |
| `savePath` | Intermediate data dir | `/tmp/kairos-drafts` |
| `outputPath` | Jianying drafts dir | Platform-specific, see below |

Jianying draft directories by platform:

- **macOS**: `~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/`
- **Windows**: `C:\Users\<USER>\AppData\Local\JianyingPro\User Data\Projects\com.lveditor.draft\`

## Step 5: LLM API (for script generation)

Create `.env` in project root:

```bash
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o
```

Any OpenAI-compatible API works (OpenRouter, DeepSeek, local ollama, etc).

## Step 6: System Tools

Ensure `ffmpeg` and `ffprobe` are on `PATH`:

```bash
ffmpeg -version
ffprobe -version
```

Install if missing:

- **macOS**: `brew install ffmpeg`
- **Windows**: `choco install ffmpeg` or download from ffmpeg.org
- **Linux**: `sudo apt install ffmpeg`

## Quick Smoke Test

After all steps, run:

```bash
# 1. TypeScript compiles
pnpm build

# 2. ML server responds
curl http://127.0.0.1:8910/health

# 3. ffprobe works
ffprobe -version

# 4. Submodule present
ls vendor/jianying-mcp/jianyingdraft/server.py
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `ERR_PNPM_UNEXPECTED_STORE` | Delete `node_modules` and re-run `pnpm install` |
| `Cannot find module 'node:fs/promises'` | Ensure `@types/node` is installed (`pnpm add -D @types/node`) |
| ML server `torch not found` | Install PyTorch separately matching your CUDA version |
| `faster-whisper` fails on macOS | Falls back to CPU; set `CT2_USE_MKL=0` if MKL errors |
| jianying-mcp `Python >= 3.13 required` | Use `uv python install 3.13` then `uv sync` |
| `SAVE_PATH not found` | Create the directory: `mkdir -p /tmp/kairos-drafts` |

## Project Structure Reference

For detailed structure info, see [project-structure.md](project-structure.md).
