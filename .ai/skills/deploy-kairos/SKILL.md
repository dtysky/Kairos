---
name: deploy-kairos
description: >-
  Deploy the Kairos middle-version project on a new device. Covers Node.js core,
  Python ML server, vendored jianying-mcp, and environment variables.
  Use when setting up Kairos on a fresh machine, cross-device deployment,
  or when the user mentions deploy, install, setup, or environment.
---

# Deploy Kairos (Middle Version)

Full deployment guide for a new device. Kairos has three subsystems:

| Subsystem | Runtime | Location | Required |
|-----------|---------|----------|----------|
| TypeScript core | Node.js >= 16 + pnpm | `./` (root) | Always |
| ML server | Python >= 3.10 + uv/pip | `ml-server/` | For media analysis (Whisper ASR + VLM) |
| Jianying MCP | Python >= 3.13 + uv | `vendor/jianying-mcp/` | Configured externally by MCP host for Jianying export |

### 平台 ML 后端差异

| Platform | ASR | CLIP | VLM | 安装方式 |
|----------|-----|------|-----|---------|
| macOS Apple Silicon | **mlx-whisper** | **mlx_clip** | **mlx-vlm** (Qwen3-VL-4B-8bit) | `pip install -e ".[mlx]"` |
| Windows + NVIDIA GPU | transformers Whisper (CUDA) | open-clip-torch (CUDA) | transformers Qwen3-VL-4B (CUDA) | `pip install -e ".[cuda]"` |
| Linux / macOS Intel | transformers Whisper (CPU) | open-clip-torch (CPU) | transformers Qwen3-VL-4B (CPU) | `pip install -e ".[cuda]"` |

Apple Silicon 上全栈使用 MLX，**不需要 PyTorch**。后端自动检测，也可通过 `KAIROS_ML_BACKEND=mlx|torch` 强制指定。

LLM 调用由 Cursor / Codex agent 直接完成，不需要单独配置 LLM API key。

## Prerequisites Checklist

```
- [ ] Git
- [ ] Node.js >= 16
- [ ] pnpm (corepack enable && corepack prepare pnpm@latest --activate)
- [ ] Python >= 3.10 (recommend 3.12+, 3.13 for jianying-mcp)
- [ ] uv (curl -LsSf https://astral.sh/uv/install.sh | sh)
- [ ] ffmpeg + ffprobe (media analysis)
- [ ] GPU driver (optional, for ML acceleration)
```

## Step 1: Clone Repository

```bash
git clone <REPO_URL> Kairos
cd Kairos
```

Verify: `ls vendor/jianying-mcp/jianyingdraft/server.py` should exist.

## Step 2: TypeScript Core

```bash
pnpm install
pnpm build
```

注：当前项目在 `WSL + zsh + Node 16` 下已完成基础构建验证。
如果安装依赖时看到个别三方包声明 `node >= 18` 的 engine warning，可先继续验证本项目链路，再按需要升级 Node。

Verify: `ls dist/index.js` should exist and `npx tsc --noEmit` should pass.

## Step 3: ML Server (media analysis)

### 3a. Detect platform

| Platform | Device | Notes |
|----------|--------|-------|
| Windows + NVIDIA GPU | `cuda` | Preferred for VLM; run the ML server in native Windows Python, not WSL |
| macOS Apple Silicon | `mps` | Works out of box, slower than CUDA |
| Linux / macOS Intel | `cpu` | Functional but slow for inference |

### 3b. Install dependencies

**macOS Apple Silicon（纯 MLX，无 PyTorch）：**

注意：必须使用 **arm64 架构的 Python**。如果 Homebrew 是 x86_64 版本（`/usr/local`），用 `uv` 安装 arm64 Python：

```bash
uv python install 3.12
uv venv .venv-ml --python 3.12
# 验证架构
.venv-ml/bin/python -c "import platform; print(platform.machine())"  # 应输出 arm64
```

安装依赖：

```bash
cd ml-server
uv pip install --python ../.venv-ml/bin/python -e ".[mlx]"
```

mlx-vlm 首次使用时自动下载 `mlx-community/Qwen3-VL-4B-Instruct-8bit` (~3GB)。
mlx-whisper 首次使用时自动下载 Whisper 模型。
mlx_clip 首次使用时自动转换 CLIP 权重到 MLX 格式。

**Windows + NVIDIA GPU：**

```bash
cd ml-server
uv venv && uv pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
uv pip install -e ".[cuda]"
```

在 `Windows + NVIDIA GPU` 上，建议直接使用 **Windows 原生 Python 环境** 启动 `kairos-ml`，
让推理直接走 `CUDA`。不要从 WSL 拉起推理服务。

**Linux / macOS Intel（CPU fallback）：**

```bash
cd ml-server
uv venv && uv pip install -e ".[cuda]"
```

OCR 按需安装（任意平台，不影响主后端选择）：

```bash
uv pip install -e ".[ocr]"      # PaddleOCR
uv pip install -e ".[ocr-easy]" # 或 EasyOCR
```

### 3c. Configure VLM model

VLM 后端通过 `KAIROS_VLM_MODEL_SOURCE` 控制，默认 `auto`：

| `KAIROS_VLM_MODEL_SOURCE` | 行为 |
|---|---|
| `auto`（默认） | macOS → mlx-vlm，CUDA → transformers + ModelScope |
| `mlx` | 强制 mlx-vlm，默认模型 `mlx-community/Qwen3-VL-4B-Instruct-8bit` |
| `modelscope` | 强制 transformers，从 ModelScope 下载 |
| `huggingface` | 强制 transformers，从 HuggingFace 下载 |

Optional overrides:

```bash
export KAIROS_VLM_MODEL_SOURCE=auto          # auto / mlx / modelscope / huggingface
export KAIROS_VLM_MODEL_ID=Qwen/Qwen3-VL-4B-Instruct   # transformers 模式下的模型 ID
# Optional: point to a pre-downloaded local directory (overrides source/id)
export KAIROS_VLM_MODEL_PATH=/path/to/Qwen3-VL-4B-Instruct
```

### 3d. Start ML server

推荐用仓库内的管理脚本来启动，而不是手写 `uvicorn` 命令。脚本会把服务固定命名为 `kairos-ml`，把 `pid / stdout / stderr` 记录到 `.tmp/run/kairos-ml/`，重启前自动清理旧实例。

**macOS / Linux：**

```bash
./scripts/ml-server.sh start
./scripts/ml-server.sh status
./scripts/ml-server.sh logs
```

**Windows (PowerShell)：**

```powershell
powershell -ExecutionPolicy Bypass -File scripts/ml-server.ps1 restart
powershell -ExecutionPolicy Bypass -File scripts/ml-server.ps1 status
powershell -ExecutionPolicy Bypass -File scripts/ml-server.ps1 logs
```

**手动启动（任意平台）：**

```bash
cd ml-server && python -m uvicorn kairos_ml.main:app --host 127.0.0.1 --port 8910
```

Verify: `curl http://127.0.0.1:8910/health`

| Platform | 期望 device | 期望 backend |
|----------|------------|-------------|
| Windows + NVIDIA | `cuda` | `torch` |
| macOS Apple Silicon | `mps` | `mlx` |
| CPU fallback | `cpu` | `torch` |

在 Windows 上如果返回 `cpu`，检查是否误在 WSL 环境启动了 ML server。
在 macOS 上首次调用各模型端点时会按需下载（VLM ~3GB, Whisper ~500MB, CLIP ~600MB），请耐心等待。

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

Kairos 不再在内部直接拉起它；请在你的工程 / MCP host 中把它配置成独立 MCP server。

### Configure external MCP server

Example:

```json
{
  "mcpServers": {
    "jianying": {
      "command": "uv",
      "args": [
        "--directory",
        "H:\\SpriaHeaven\\Kairos\\vendor\\jianying-mcp\\jianyingdraft",
        "run",
        "server.py"
      ],
      "env": {
        "SAVE_PATH": "H:\\SpriaHeaven\\Kairos\\.tmp\\jianying-save",
        "OUTPUT_PATH": "C:\\Users\\<USER>\\AppData\\Local\\JianyingPro\\User Data\\Projects\\com.lveditor.draft"
      }
    }
  }
}
```

需要保证：

- `uv` 可用
- `SAVE_PATH` 目录存在
- `OUTPUT_PATH` 指向当前机器的剪映草稿目录
- 这个 MCP server 由宿主环境管理生命周期，而不是由 Kairos Core 直接启动

Jianying draft directories by platform:

- **macOS**: `~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/`
- **Windows**: `C:\Users\<USER>\AppData\Local\JianyingPro\User Data\Projects\com.lveditor.draft\`

## Step 5: System Tools

初始化媒体链路时，先检查**当前平台的原生** `ffmpeg / ffprobe`。
例如在 Windows 上，优先检查 Windows 原生安装，而不是直接假设 WSL 里的版本可用。
如果系统 `PATH` 里没有，再检查用户常见自定义目录（如 `C:\Applications\...`）；若仍找不到，先把它们写入项目内的 `config/runtime.json`，再考虑下载。

Ensure `ffmpeg` and `ffprobe` are on `PATH`:

```bash
ffmpeg -version
ffprobe -version
```

Install if missing:

- **macOS**: `brew install ffmpeg`
- **Windows**: `choco install ffmpeg` or download from ffmpeg.org
- **Linux**: `sudo apt install ffmpeg`

Windows 补充建议：

- 先用 `where ffmpeg` / `where ffprobe` 检查系统 `PATH`
- 如果用户有自定义软件目录，再检查类似 `C:\Applications\...` 的原生安装位置
- 如果 Windows 原生版本没有自动探测到，优先在项目的 `config/runtime.json` 中设置 `ffmpegPath` / `ffprobePath`
- 只有在用户本机确实没有可用原生版本时，再提醒下载，不要默认退回到 WSL 版本

推荐的项目配置：

**macOS（Homebrew ffmpeg + VideoToolbox 硬件加速）：**

```json
{
  "ffmpegHwaccel": "videotoolbox",
  "analysisProxyWidth": 1024,
  "sceneDetectFps": 4
}
```

**Windows：**

```json
{
  "ffmpegPath": "C:\\Applications\\YourFFmpeg\\ffmpeg.exe",
  "ffprobePath": "C:\\Applications\\YourFFmpeg\\ffprobe.exe",
  "ffmpegHwaccel": "cuda"
}
```

`initProject()` 现在会创建 `config/runtime.json`，后续编排层应从这里读取媒体工具路径。

## Step 6: Environment Variables (optional)

环境变量现在只保留给远端 ML server 或临时调试用，不再推荐用它们配置本机 `ffmpeg / ffprobe`：

| Variable | Default | Purpose |
|----------|---------|---------|
| `KAIROS_ML_URL` | `http://127.0.0.1:8910` | ML server URL (for remote/cross-device) |
| `KAIROS_ML_BACKEND` | auto-detect | 强制后端: `mlx` / `torch` |
| `KAIROS_VLM_MODEL_SOURCE` | `auto` | VLM model source: `auto` / `mlx` / `modelscope` / `huggingface` |
| `KAIROS_VLM_MODEL_ID` | (per backend) | VLM model identifier (transformers 模式) |
| `KAIROS_VLM_MODEL_PATH` | unset | Pre-downloaded local VLM directory (overrides source/id) |

Example: ML server on Windows GPU machine, TS core on Mac:

```bash
export KAIROS_ML_URL=http://192.168.1.100:8910
```

## LLM 调用说明

Kairos 的脚本生成（style analysis, outline, narration）通过 Cursor / Codex agent 直接完成。
agent 本身就是 LLM，不需要额外配置 API key。

`OpenAIClient` 保留为备用路径，用于未来可能的独立 CLI 模式。

## Quick Smoke Test

```bash
# 1. TypeScript compiles
pnpm build

# 2. ML server responds (if started)
curl http://127.0.0.1:8910/health

# 3. ffprobe works
ffprobe -version

# 4. Vendored Jianying MCP present
ls vendor/jianying-mcp/jianyingdraft/server.py
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `ERR_PNPM_UNEXPECTED_STORE` | Delete `node_modules` and re-run `pnpm install` |
| `Cannot find module 'node:fs/promises'` | Ensure `@types/node` is installed (`pnpm add -D @types/node`) |
| ML server `torch not found` | 仅 Windows/Linux 需要：`pip install -e ".[cuda]"` |
| macOS `No module named 'mlx'` | 确认 arm64 Python：`python -c "import platform; print(platform.machine())"` |
| MLX 模型下载慢 | 设置 `HF_ENDPOINT=https://hf-mirror.com` 使用镜像 |
| jianying-mcp `Python >= 3.13 required` | Use `uv python install 3.13` then `uv sync` |
| `SAVE_PATH not found` | Create the directory configured in the MCP host, e.g. `mkdir -p /tmp/kairos-drafts` |
| ffmpeg/ffprobe not found on Windows | Set `FFMPEG_PATH` / `FFPROBE_PATH` environment variables |

## Project Structure Reference

For detailed structure info, see [project-structure.md](project-structure.md).
