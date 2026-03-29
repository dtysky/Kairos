# Kairos Project Structure

```
Kairos/
├── package.json              # Node.js ESM, pnpm
├── tsconfig.json             # TypeScript strict, ES2022, Node16
├── .env                      # KAIROS_ML_URL, FFMPEG_PATH, FFPROBE_PATH
│
├── src/                      # TypeScript core
│   ├── index.ts              # Top-level re-exports
│   ├── protocol/
│   │   ├── schema.ts         # KTEP Zod schemas (IKtep*, E*, C*)
│   │   ├── validator.ts      # 8 protocol invariant checks
│   │   └── index.ts
│   ├── store/
│   │   ├── writer.ts         # Atomic JSON read/write
│   │   ├── project.ts        # initProject, loadManifest
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
│       ├── script/           # M3: script generation
│       │   ├── style-analyzer.ts
│       │   ├── style-loader.ts
│       │   ├── outline-builder.ts
│       │   ├── script-generator.ts
│       │   ├── script-editor.ts
│       │   └── index.ts
│       ├── timeline-core/    # M3: timeline construction
│       │   ├── placement.ts
│       │   ├── transition.ts
│       │   ├── subtitle.ts
│       │   ├── timeline-builder.ts
│       │   └── index.ts
│       └── nle/              # M4: NLE adapter layer
│           ├── adapter.ts    # INleAdapter interface + executeAdapter
│           ├── mcp-caller.ts # IMcpCaller interface
│           ├── mcp-stdio.ts  # StdioMcpCaller + createJianyingMcpCaller
│           ├── jianying.ts   # JianyingAdapter
│           ├── export-srt.ts # SRT/WebVTT export
│           └── index.ts
│
├── ml-server/                # Python ML server (FastAPI)
│   ├── pyproject.toml        # Dependencies: faster-whisper, torch, open-clip, etc.
│   └── kairos_ml/
│       ├── main.py           # FastAPI app, port 8910
│       ├── device.py         # cuda/mps/cpu detection
│       ├── whisper_runner.py # ASR via faster-whisper
│       ├── ocr_runner.py     # OCR via PaddleOCR/EasyOCR
│       ├── clip_runner.py    # Image embeddings via OpenCLIP
│       └── vlm_runner.py     # Scene analysis via Florence-2
│
├── vendor/
│   └── jianying-mcp/        # Git submodule: Jianying MCP server
│       ├── pyproject.toml    # Requires Python >= 3.13
│       └── jianyingdraft/
│           └── server.py     # MCP stdio entry point
│
├── config/                   # Runtime project config (per-project)
│   └── styles/
│       ├── catalog.json      # IStyleCatalog: registry of all categories
│       ├── travel-doc.md     # Style profile per category
│       └── ...
│
├── test/
│   └── style-profile.md     # Manual style reference (example)
│
├── designs/                  # Design documents
│   ├── 2026-03-28--middle-version-protocol-first.md
│   └── 2026-03-29--m1-protocol-and-store.md
│
└── .cursor/
    └── skills/
        └── deploy-kairos/    # This deployment skill
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
| Jianying MCP | stdio | `create_draft`, `create_track`, `add_*_segment`, `export_draft` |

## Data Flow

```
Raw Media → scanner → probe → capture-time → shot-detect → slicer → slices
                                                                        ↓
                ML server (ASR/OCR/VLM/CLIP) ← ml-client ← evidence ← sampler
                                                                        ↓
                    LLM API ← script-generator ← outline-builder ← style-loader
                                                                        ↓
                            timeline-builder → placement → transition → subtitle
                                                                        ↓
                                    JianyingAdapter → jianying-mcp → 剪映草稿
```
