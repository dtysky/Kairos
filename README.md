# Kairos

> *καιρός — the decisive moment.*

AI-powered post-production toolkit for travel filmmakers.

From raw footage and GPS tracks to color, script, and story — Kairos finds the moments that matter and weaves them into the film they were meant to be.

> *Pharos lights the way. Kairos seizes the moment.*

## Current Shape

Kairos currently runs as a `Node.js core + Agent skills` workflow around a formal `KTEP` timeline protocol and a project store rooted at `projects/<projectId>/`.

Current stable pipeline:

- `Pharos -> ingest -> analyze -> script -> timeline -> export`
- `Pharos` 的正式输入位置已收口到项目内固定目录 `projects/<projectId>/pharos/<trip_id>/`
  - 每个 trip 子目录当前消费 `plan.json`，可选消费 `record.json` 与 `gpx/*.gpx`
  - 项目初始化会直接创建 `projects/<projectId>/pharos/`；Console 读取项目配置时也会补齐缺失目录
  - `project-brief.md` 只允许通过 `## Pharos` / `包含 Trip：...` 做可选 trip 筛选，不再填写外部 `Pharos` 路径
  - `/ingest-gps` 会明确提示这个固定目录，并提醒用户把 `trip_id/plan.json`、`record.json`、`gpx/` 镜像放进来
  - Console 会把 `Pharos` 状态显示为 `空 / 解析成功 / 解析失败`
- `导入与 GPS` 当前正式承载素材时间阻塞与修正：
  - 高置信 `exif` / `manual` 不会再因为文件名日期不同而被硬阻塞
  - 弱时间源会同时校验项目时间线、文件名完整时间戳漂移，以及已纳入 `Pharos` trip 的整体时间边界
  - 阻塞项通过 Console 卡片式“素材时间校正”处理，而不是要求用户直接回填 Markdown 表格
  - 用户当前可直接在 UI 中选择 `保持当前 / 使用建议 / 手动修正`
  - 手动修正默认只要求 `正确时间 + 时区`；`正确日期` 会优先按 `suggestedDate`，否则按当前时间在该时区对应的本地日期自动补齐
  - 项目内跨设备时钟漂移当前也通过这里正式修正：`/ingest-gps` 会并列提供 root 级“设备时钟偏移”面板与单素材 `captureTimeOverrides`
  - root 级偏移写入 `config/ingest-roots.json` 的 `clockOffsetMs`；单素材 `captureTimeOverrides` 继续作为更高优先级例外层
  - `media/chronology.json` 的 `sortCapturedAt` 当前是 Script / Timeline 共享的唯一时序真值：优先 `capturedAtOverride`，其次 `asset.capturedAt + root.clockOffsetMs`，最后才回退原始 `asset.capturedAt`
- official local runtime / monitor entry is `Supervisor + React console (apps/kairos-console/)`
  - `http://127.0.0.1:8940/analyze` is the official Analyze monitor route
  - `http://127.0.0.1:8940/style` is the official workspace-level Style monitor route
  - `scripts/kairos-supervisor.* start` only starts `Supervisor + React console`; it does not start ML and does not resume old jobs
  - `progress.json` is only a durable progress cache; a phase is live only when Supervisor still has the matching active job
  - console refresh now prefers the project that currently owns the latest active project-scoped job before falling back to the last locally remembered selection
  - when multiple projects share the same display name, the selector must surface `projectId` to avoid mixing monitor context
  - top-level workflow jobs now always reconcile to `ML stopped` after completion, failure, manual stop, or interruption
- reusable style assets now live at workspace scope, not project scope:
  - `config/styles/` stores the shared style library
  - `config/style-sources.json` stores the shared style-source manifest and is the only structured style index
  - `analysis/reference-transcripts/` and `analysis/style-references/` store shared style-analysis outputs
  - `config/styles/{category}.md` holds profile content only; it is no longer paired with a separate `catalog.json`
- workspace style profiles are no longer treated as prose-only references:
  - each `config/styles/*.md` should carry directly consumable rhythm-stage guidance, material-role guidance, camera/shot-language preferences, function-slot hints, stable parameter keys, and anti-patterns
  - these style outputs are expected to guide `script` recall / outline / beat writing directly, not only provide high-level narrative tone
  - script/timeline runtime now resolves a small internal arrangement-signal layer from the existing style profile; it is not a new public schema, but it lets downstream logic tell whether the current style is mainly time/route-driven, space-driven, emotion-driven, or payoff-driven
- project script work now references a workspace style category instead of owning its own `config/styles/`
- workspace style-analysis now runs as a formal deterministic prep job:
  - `health-check -> clip -> probe -> shot-detect -> transcribe -> keyframes -> vlm -> video-complete -> awaiting_agent|completed`
  - the prep job writes workspace `.tmp/style-analysis/{category}/progress.json`, `analysis/reference-transcripts/`, and `analysis/style-references/`
  - `/style` now resolves the most relevant category in this order: explicit `categoryId` -> live style job -> latest style job -> latest cached style progress -> `defaultCategory` -> first category
  - the `/style` monitor is no longer limited to a coarse stage string; it should show current video context plus concrete `keyframes / vlm / queue` runtime state when available
  - the final style profile remains agent-authored from those prep outputs, but it now goes through a clean-context subagent chain:
    - deterministic prep writes `analysis/style-references/{category}/agent-summary.json`
    - `style-profile-synthesizer` reads only that packetized summary and writes `style-draft.json`
    - `style-profile-reviewer` reads only the draft + packet and writes `style-review.json`
    - reviewer blockers are a hard gate before `config/styles/{category}.md`
- the `/script` console page now acts as deterministic script preparation:
  - user first selects a workspace `styleCategory` in `/script`; that selection auto-saves
  - changing `styleCategory` now invalidates the previous script run immediately; Kairos clears the old `material-overview`, brief draft body, arrangement artifacts, outline, and `script/current.json`, then returns the workflow to `await_brief_draft`
  - agent then generates `script/material-overview.md` and the initial `script-brief`
  - user reviews and manually saves the brief in `/script`
  - the console now surfaces these handoffs with persistent workflow prompts and explicit hana modal confirmations instead of relying on low-contrast inline copy
  - `/script` validates `store/spans.json`, the selected workspace `styleCategory`, and the matching style profile
  - `/script` now prepares deterministic script inputs such as `script/material-overview.facts.json`, `script/material-overview.md`, `script/segment-plan.json`, `script/material-slots.json`, and `analysis/material-bundles.json`
  - the agent-authored script phase now uses clean-context internal stages instead of one shared writer context:
    - `script/spatial-story.json` + `script/spatial-story.md` summarize chronology / spans / Pharos / GPS into a narrative-hint layer
    - `script/agent-contract.json` becomes the single locked truth for goals, constraints, style must/forbidden, GPS hints, Pharos must-cover hints, and chronology guardrails
    - each generator/reviewer stage reads only its own `script/agent-packets/{stage}.json`
    - stage reviews write to `script/reviews/{stage}.json`
    - pipeline state writes to `script/agent-pipeline.json`
  - the final `script/current.json` remains the only formal script output consumed by timeline/export
  - if the reviewed brief was already user-edited and a fresh initial draft is needed, overwrite permission is granted explicitly from `/script` instead of silent agent overwrite
  - the selected style profile should already expose structured `arrangementStructure`, `narrationConstraints`, rhythm stages, material grammar, camera language, and anti-patterns, so Agent work does not depend on re-inferring everything from a long style essay
  - script prep now follows `Analyze -> Material Overview -> Script Brief -> Segment Plan -> Material Slots -> Bundle Lookup -> Chosen SpanIds -> Beat / Script`
  - when the selected style clearly emphasizes chronology / route continuity / continuous process, script prep now enforces ordering in three layers:
    - internal arrangement signals resolve that the style is time-axis-strong from the existing style markdown
    - deterministic prep builds monotonic time bands for segments and only retrieves spans inside the legal band
    - downstream timeline assembly re-validates chronology and refuses to silently output a backwards sequence
  - deterministic prep no longer treats style averages or inferred material capacity as the driver of rough-cut duration; `targetDurationMs` stays optional and advisory-only unless the user explicitly sets it
  - rough-cut recall is now high-recall by default: valid spans should stay in `material-slots / outline / script` unless they are empty, clearly bad, or near-duplicate
  - `analysis/material-bundles.json` is now a full span index, and `script/material-slots.json` may fan out to many single-span slots instead of one shortlist slot per segment
  - key process videos with real event progression / relationship progression / effective source speech are now protected from being swallowed by broad summary segments
- project brief now carries one project-level semantic vocab layer for analyze/script:
  - `材料模式短语`
- subtitles support two formal paths:
  - narration path from `beat.text`
  - source-speech path from `span.transcriptSegments`
  - source-speech subtitles now run through cleanup and hard cue splitting first; noisy ASR that still cannot produce readable cues now stays silent instead of falling back to explanatory narration
- source-speech rough cut now prefers transcript-driven speech islands over one long enclosing window: short pauses may remain, but long silent gaps should be cut out instead of being carried through a preserved-speech beat
- source-speech now treats filtered spoken transcript cues as timing truth:
  - navigation / device-command transcript tails should be filtered out before speech-island building and subtitle generation
  - coarse transcript segments that split into multiple subtitle cues should be re-timed by cue length / speech pacing, not evenly divided
- video Analyze now produces formal video `visualSummary + decision` in a single unified VLM pass during `finalize`:
  - with audio: `coarse-scan -> audio-analysis -> finalize -> deferred scene detect(if needed)`
  - without audio: `coarse-scan -> finalize -> deferred scene detect(if needed)`
  - `coarse-scan` prepares keyframes, `hasAudioTrack`, and source context; it is not the formal visual-summary stage
  - when `finalize` returns invalid JSON, Analyze now persists raw finalize attempts under `projects/<projectId>/.tmp/media-analyze/finalize-attempts/<assetId>/` and automatically retries with larger VLM token budgets before failing the run
  - finalize retry currently uses token budgets `512 -> 768 -> 1152` (x1.5 each round, rounded up), and the prompt now explicitly caps `decision_reasons` to a short list to reduce truncation pressure
  - `coarse-scan` now runs as asset-level dynamic concurrency: each active asset uses at most one coarse keyframe `ffmpeg`, while multiple assets may progress in parallel based on free-memory limits
  - `audio-analysis` now runs as a two-queue asset pipeline: local audio health / routing work and ASR work have separate dynamic concurrency controls
  - for assets with `protectionAudio`, Analyze now performs dual lightweight health checks first, routes to a single chosen ASR source, and promotes that chosen transcript to the formal downstream transcript
  - non-MLX ASR paths (`Windows + CUDA`, `Linux`, `CPU fallback`) now default to `faster-whisper / large-v3` so Chinese-first Analyze gets the higher-accuracy checkpoint plus word-level timestamps; Apple Silicon remains on `mlx-whisper / whisper-large-v3-turbo`
  - Analyze now treats `Whisper` and `VLM` as mutually exclusive residents during the ASR/finalize handoff; entering `VLM` must unload `Whisper` first instead of keeping both models hot
  - on transformers-backed VLM paths (`Windows + CUDA`, `Linux`, `CPU fallback`), the default local/current model is now `models/Qwen3_5-9B` / `Qwen/Qwen3.5-9B`; the MLX path remains on `Qwen3-VL-4B-Instruct-8bit` until a dedicated MLX-packaged Qwen3.5 artifact is adopted
- Analyze durable resume caches are stage-local internals:
  - `analysis/prepared-assets/` stores coarse prepared inputs, not finalized visual semantics
  - `analysis/audio-checkpoints/` stores selected-transcript, audio-health, and protection-routing intermediate state
- Analyze now distinguishes tight focus windows from edit-friendly bounds:
  - coarse reports keep `interestingWindows[].startMs/endMs` as focus/evidence windows
  - edit-ready bounds travel alongside them as `interestingWindows[].editStartMs/editEndMs`
  - persisted `store/spans.json` keeps `sourceInMs/sourceOutMs` plus wider `editSourceInMs/editSourceOutMs`
- analyze now formalizes material-side semantics on each span:
  - `materialPatterns[]`
  - `grounding`
- drive / aerial spans can now carry `speedCandidate` metadata (for example `2x / 5x / 10x` suggestions); rough-cut timeline may auto-consume it for silent montage beats, while explicit `beat.actions.speed` still overrides the default
- a `beat` can now optionally carry explicit `utterances[]` with head / middle / tail pauses, so subtitles only occupy voiced islands while video can continue underneath
- outline / script now prefer Analyze-provided edit bounds instead of re-centering every span by default; legacy spans without edit bounds still fall back to conservative trimming
- explicit acceleration now flows through `beat.actions.speed` -> timeline clip `speed` -> NLE export, but only `drive / aerial` clips may consume it; acceleration is for expression and de-duplication, not for meeting a duration target
- silent `drive / aerial` beats with `speedCandidate` now default to `2x` in rough cut unless the script explicitly requests another speed
- when a beat preserves source speech, Kairos now snaps the selected window to transcript-driven speech islands and keeps subtitle timing aligned to those source boundaries
- source-speech clip boundaries should match the filtered spoken transcript window by default instead of carrying fixed extra silence
- rough-cut timeline placement now keeps effective source windows by default instead of fitting clips against `beat.targetDurationMs`; photos default to `1s` silent holds unless the script explicitly asks for a longer `holdMs`
- when the same asset contributes both source-speech and silent `drive / aerial` material, source-speech owns the overlapping source window and silent montage may only use the non-overlapping remainder
- when the same `drive / aerial` asset is reused by later silent montage beats, the later beat should only keep source remainder that has not already been consumed earlier in the rough cut
- chronology guard 与 selection / beat 排序当前也必须统一读取 `media/chronology.json` 的 `sortCapturedAt`，不再允许 timeline 私自回退到原始 `asset.capturedAt`
- for styles whose existing main axis resolves to time / route progression, timeline placement now treats chronology as a formal guardrail instead of a soft preference:
  - adjacent beats should keep non-decreasing `capturedAt`
  - multi-selection beats should default to chronological order internally
  - if a safe in-band reorder still cannot restore order, timeline generation now throws instead of silently exporting a wrong sequence
- timeline / draft output spec is project-configurable through `config/runtime.json` and now defaults to `3840x2160 @ 30fps`
- when a beat does not use source speech, Kairos will mark selected video clips to mute their embedded audio during NLE export; clip/selection references now prefer `spanId`
- the official Analyze monitor now exposes structured pipeline cards for `coarse-scan`, `audio-analysis`, and `fine-scan` instead of pretending the first two stages are single-asset serial work
- Jianying export now uses the vendored local `pyJianYingDraft` CLI, not an external Jianying MCP/server
- Jianying draft export is guarded by strict safety rules:
  - drafts are created in project-local staging under `projects/<projectId>/adapters/jianying-staging/`
  - a successful staging draft is then copied into the configured Jianying draft root
  - both the staging directory and the final draft directory must be brand-new
  - existing draft directories must never be overwritten or deleted
  - modifying an existing draft requires explicit target verification first
- Jianying export also normalizes retimed clip placement for `pyJianYingDraft` compatibility, so backend microsecond rounding does not mutate the formal `timeline/current.json`

## Change Discipline

For any requirement, behavior, workflow, protocol, or official entry change, Kairos now follows one mandatory order:

1. enter `Plan` mode first, or produce a structured plan and confirm it if the host does not expose explicit Plan mode
2. update the relevant design docs before implementation
3. implement the change
4. review and sync the impacted design docs, rules, and skills before closing the task

If the change affects official user paths, monitoring, or workflow entry points, also update:

- `README.md`
- `AGENTS.md`
- `designs/current-solution-summary.md`
- `designs/architecture.md`

## Key Docs

- `AGENTS.md` — root bootstrap for agents; indexes mandatory rules, skills, and official runtime entry points
- `designs/current-solution-summary.md` — quickest entry for the current official solution
- `designs/architecture.md` — architecture context plus current-vs-historical notes
- `designs/project-structure.md` — current project storage layout and migration notes
- `.ai/skills/` — operational workflow skills for ingest, analyze, script, timeline, and export
