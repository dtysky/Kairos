# Kairos Project Structure

```
Kairos/
├── package.json              # Node.js ESM, pnpm
├── tsconfig.json             # TypeScript strict, ES2022, Node16
│
├── src/                      # TypeScript core
│   ├── index.ts              # Top-level re-exports
│   ├── protocol/
│   │   ├── schema.ts         # KTEP Zod schemas (IKtep*, E*, C*)
│   │   ├── validator.ts      # KTEP protocol invariant checks
│   │   └── index.ts
│   ├── store/
│   │   ├── writer.ts         # Atomic JSON read/write
│   │   ├── project.ts        # initProject, loadManifest
│   │   ├── incremental.ts    # mergeAssets, appendAssets, findUnanalyzedAssets
│   │   └── index.ts
│   └── modules/
│       ├── media/            # M2: media analysis pipeline
│       │   ├── scanner.ts    # Directory scan + classify
│       │   ├── probe.ts      # ffprobe metadata
│       │   ├── capture-time.ts
│       │   ├── shot-detect.ts
│       │   ├── keyframe.ts
│       │   ├── slicer.ts
│       │   ├── ml-client.ts  # HTTP client for ML server
│       │   ├── transcriber.ts
│       │   ├── ocr.ts
│       │   ├── density.ts
│       │   ├── sampler.ts
│       │   ├── evidence.ts
│       │   ├── recognizer.ts
│       │   └── index.ts
│       ├── llm/
│       │   ├── client.ts     # ILlmClient + OpenAIClient
│       │   └── index.ts
│       ├── script/           # Script generation + style loading
│       │   ├── style-analyzer.ts
│       │   ├── style-loader.ts
│       │   ├── outline-builder.ts
│       │   ├── script-generator.ts
│       │   ├── script-editor.ts
│       │   └── index.ts
│       ├── timeline-core/    # Timeline construction
│       │   ├── placement.ts
│       │   ├── transition.ts
│       │   ├── subtitle.ts
│       │   ├── timeline-builder.ts
│       │   └── index.ts
│       └── nle/              # M4: NLE adapter layer
│           ├── adapter.ts    # INleAdapter interface + executeAdapter
│           ├── mcp-caller.ts # IMcpCaller interface (injected by external MCP host)
│           ├── jianying.ts   # JianyingAdapter
│           ├── export-srt.ts # SRT/WebVTT export
│           └── index.ts
│
├── ml-server/                # Python ML server (FastAPI)
│   ├── pyproject.toml        # Dependencies: mlx-whisper, mlx-vlm, etc.
│   └── kairos_ml/
│       ├── main.py           # FastAPI app, port 8910
│       ├── device.py         # cuda/mps/cpu + mlx/torch detection
│       ├── whisper_runner.py # ASR (MLX: whisper-large-v3-turbo / Torch: whisper-small)
│       ├── ocr_runner.py     # OCR via PaddleOCR/EasyOCR
│       ├── clip_runner.py    # Image embeddings (MLX: mlx_clip / Torch: open-clip)
│       └── vlm_runner.py     # VLM (MLX: Qwen3-VL-4B-8bit / Torch: Qwen3.5-9B)
│
├── scripts/
│   ├── kairos-supervisor.sh  # macOS/Linux: start/stop/status Supervisor + React console
│   ├── kairos-supervisor.ps1 # Windows PowerShell: start/stop/status Supervisor + React console
│   ├── ml-server.sh          # macOS/Linux: start/stop/status ML server
│   ├── ml-server.ps1         # Windows PowerShell: start/stop/status ML server
│   ├── ml-models-init.sh     # macOS: pre-download all MLX models from HF Hub
│
├── apps/
│   └── kairos-console/       # Official React console served by Supervisor (`/analyze`, `/style`, ...)
│
├── models/                   # ML model weights (gitignored, ~7 GB total)
│   ├── whisper-large-v3-turbo/     # mlx-whisper ASR model
│   ├── clip-vit-base-patch32/      # mlx_clip embedding model
│   ├── Qwen3-VL-4B-Instruct-8bit/ # mlx-vlm model (Apple Silicon)
│   └── Qwen3_5-9B/                # transformers VLM model (CUDA / CPU)
│
├── vendor/
│   └── pyJianYingDraft/      # Vendored upstream Jianying draft library repo
│       ├── pyJianYingDraft/   # Python package imported by Kairos local exporter
│       ├── requirements.txt   # Upstream runtime deps
│       └── README.md          # Upstream usage / compatibility notes
│
├── config/                   # Workspace-shared runtime + style config
│   ├── runtime.json          # ffmpeg / ffprobe / ML endpoint config
│   ├── style-sources.json    # Workspace style-source manifest
│   └── styles/
│       ├── travel-doc.md     # Style profile per category
│       └── ...
├── analysis/
│   ├── reference-transcripts/ # Workspace style-analysis ASR cache
│   └── style-references/      # Workspace style-analysis per-video reports
│
├── test/
│   └── style-profile.md     # Manual style reference (example)
│
├── designs/                  # Design documents
│   ├── 2026-03-28--middle-version-protocol-first.md
│   └── 2026-03-29--m1-protocol-and-store.md
│
└── .ai/
    └── skills/               # Agent skills (symlinked from .cursor/skills)
        ├── deploy-kairos/    # Deployment skill
        ├── kairos-workflow/  # Master workflow orchestrator
        ├── kairos-ingest/    # Phase 1: media ingest
        ├── kairos-analyze/   # Phase 2: media analysis
        ├── kairos-style-analysis/  # Style extraction from reference works
        ├── kairos-script/    # Phase 3: script generation
        ├── kairos-timeline/  # Phase 4: timeline construction
        ├── kairos-export/    # Phase 5: export router
        ├── kairos-export-jianying/ # Phase 5: Jianying export
        └── kairos-export-resolve/  # Phase 5: Resolve export
```

## Naming Conventions

| Prefix | Meaning | Example |
|--------|---------|---------|
| `E` | Enum | `EAssetKind`, `ETrackKind` |
| `I` | Interface/Type | `IKtepDoc`, `INleAdapter` |
| `C` | Constant | `CPROTOCOL`, `CVERSION` |

## Key Ports & Endpoints

| Service | Port | Endpoints |
|---------|------|-----------|
| ML server | 8910 | `/health`, `/asr`, `/ocr`, `/clip/embed`, `/vlm/analyze` |
| Supervisor dashboard | 8940 | `/`, `/analyze`, `/style`, `/script`, `/timeline-export`, `/project` |
| Jianying draft backend | Local Python CLI | `JianyingDraftSpec` → `scripts/jianying-export.py` |

## Data Flow

```
Raw Media → scanner → probe → capture-time → shot-detect → slicer → slices
                                                                        ↓
                ML server (ASR/OCR/VLM/CLIP) ← ml-client ← evidence ← sampler
                                                                        ↓
Agent (workspace style-analysis) → style-loader → outline-builder → Agent (script)
                                                                        ↓
                            timeline-builder → placement → transition → subtitle
                                                                        ↓
                                    JianyingAdapter → local pyJianYingDraft CLI → 剪映草稿
```
