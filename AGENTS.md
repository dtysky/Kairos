# Kairos Agent Bootstrap

This file is the root bootstrap entry for any agent working in this repository.

It does not replace the actual rules, design docs, or skills. Its job is to make sure they are discoverable and read in a stable order.

## Read Order

Read these before doing substantial work:

1. `README.md`
2. `designs/current-solution-summary.md`
3. `designs/architecture.md`
4. every file under `.ai/rules/`
5. if the task touches DaVinci Resolve scripting, `/color`, Resolve export, DRX/DRT, LUT automation, Resolve render jobs, Resolve groups, color node graphs, or the vendored Resolve host, read `.ai/knowledge/davinci-resolve-scripting.md`
6. the relevant skill file(s) under `.ai/skills/`

Direct links:

1. [README.md](./README.md)
2. [designs/current-solution-summary.md](./designs/current-solution-summary.md)
3. [designs/architecture.md](./designs/architecture.md)
4. [`.ai/rules/`](./.ai/rules/)
5. [`.ai/knowledge/davinci-resolve-scripting.md`](./.ai/knowledge/davinci-resolve-scripting.md)
6. [`.ai/skills/`](./.ai/skills/)

If the task changes requirements, behavior, interfaces, workflow, monitoring, or official entry points, follow the change discipline in [`.ai/rules/change-management-discipline.mdc`](./.ai/rules/change-management-discipline.mdc):

1. enter Plan mode, or produce a structured plan and get confirmation if explicit Plan mode is unavailable
2. update the relevant design docs first
3. implement the change
4. review and sync impacted docs, rules, and skills before finishing

If the task touches `Pharos`, first follow [`.ai/rules/pharos-protocol-sync.mdc`](./.ai/rules/pharos-protocol-sync.mdc):

1. run `node scripts/pharos-protocol-hash.mjs`
2. compare against `.ai/pharos-protocol-baseline.json`
3. if hash changed, re-read `../Pharos/designs/` before planning or implementing

## Official Runtime Entry

The current official local runtime and monitor path is:

- `Supervisor + React console (apps/kairos-console/)`
- Analyze monitor route: `http://127.0.0.1:8940/analyze`
- Style monitor route: `http://127.0.0.1:8940/style` (workspace-level style library / style-analysis monitor)
- Color route: `http://127.0.0.1:8940/color` (independent DaVinci color render-preset/action/runtime surface backed by the same-machine vendored Resolve backend)

Operational lesson that must not be forgotten:

- `scripts/kairos-supervisor.* start` starts `Supervisor + React console`, but does not start ML and does not auto-resume old jobs
- 只要改动影响正式本地运行入口、Supervisor API、`/analyze`、`/style`、`/color` 或 `apps/kairos-console/`，验证必须同时跑：
  - 根仓 `pnpm build`
  - `npm --prefix apps/kairos-console run build`
- 不要把根仓 `pnpm build` 误当成已经覆盖 React console 产物；前端 bundle 需要单独 build
- `projects/<projectId>/.tmp/media-analyze/progress.json` is durable progress cache, not proof that a live analyze job is running
- `<workspaceRoot>/.tmp/style-analysis/<category>/progress.json` is also durable progress cache, not proof that a live style-analysis job is running
- `/color` now auto-checks Resolve host preflight on entry and caches it in `color/current.json`; host diagnostics should not wait until an action is clicked
- `/style` should resolve one category of truth per monitor view; do not mix default-category metadata with another category's latest job/progress
- `/style` should surface current video context plus `keyframes / vlm / queue` runtime detail when progress data provides it
- Kairos-managed top-level jobs must end with `ML stopped`, including success, failure, stop, and interrupt paths
- if a page looks active but GPU / ML is idle, verify:
  - there is a live `running analyze` job in `Supervisor`
  - `progress.json` timestamps are still moving
  - GPU / ML activity matches the reported phase

## Mandatory Rules

Read every file in [`.ai/rules/`](./.ai/rules/). Current repository rules are:

- [`.ai/rules/blocking-missing-inputs.mdc`](./.ai/rules/blocking-missing-inputs.mdc) — stop and ask the user when a required user-specified input is missing or unreadable
- [`.ai/rules/change-management-discipline.mdc`](./.ai/rules/change-management-discipline.mdc) — any workflow or behavior change must go through plan -> docs -> implement -> sync
- [`.ai/rules/davinci-resolve-scripting-docs.mdc`](./.ai/rules/davinci-resolve-scripting-docs.mdc) — DaVinci Resolve scripting tasks must use the local Resolve scripting documentation before implementation
- [`.ai/rules/draft-target-verification.mdc`](./.ai/rules/draft-target-verification.mdc) — verify the exact existing draft / project target before modifying it
- [`.ai/rules/export-path-safety.mdc`](./.ai/rules/export-path-safety.mdc) — never overwrite or clear an existing export target
- [`.ai/rules/master-workflow-user-guidance.mdc`](./.ai/rules/master-workflow-user-guidance.mdc) — explain Kairos as one workflow and route users through the correct phase
- [`.ai/rules/pharos-protocol-sync.mdc`](./.ai/rules/pharos-protocol-sync.mdc) — any Pharos-related work must start with sibling protocol hash verification
- [`.ai/rules/runtime-service-truth.mdc`](./.ai/rules/runtime-service-truth.mdc) — official runtime truth for Supervisor, ML, live jobs, and durable progress caches
- [`.ai/rules/script-skill-enforcement.mdc`](./.ai/rules/script-skill-enforcement.mdc) — always read and use `kairos-script` before script-generation work
- [`.ai/rules/windows-shell-environment.mdc`](./.ai/rules/windows-shell-environment.mdc) — on Windows, prefer native PowerShell unless the user explicitly wants WSL or a Linux-only step is required

## Skills Index

Read the relevant `SKILL.md` before phase-specific work. Current skills are:

- [`.ai/skills/deploy-kairos/SKILL.md`](./.ai/skills/deploy-kairos/SKILL.md) — deployment, fresh-machine setup, cross-device environment bring-up
- [`.ai/skills/kairos-analyze/SKILL.md`](./.ai/skills/kairos-analyze/SKILL.md) — analyze phase, coarse reports, fine-scan, monitor semantics
- [`.ai/skills/kairos-export/SKILL.md`](./.ai/skills/kairos-export/SKILL.md) — export router
- [`.ai/skills/kairos-export-jianying/SKILL.md`](./.ai/skills/kairos-export-jianying/SKILL.md) — Jianying draft export and subtitle output
- [`.ai/skills/kairos-export-resolve/SKILL.md`](./.ai/skills/kairos-export-resolve/SKILL.md) — DaVinci Resolve export
- [`.ai/skills/kairos-ingest/SKILL.md`](./.ai/skills/kairos-ingest/SKILL.md) — media ingest and project asset inventory
- [`.ai/skills/kairos-project-init/SKILL.md`](./.ai/skills/kairos-project-init/SKILL.md) — project initialization and environment rehydration
- [`.ai/skills/kairos-script/SKILL.md`](./.ai/skills/kairos-script/SKILL.md) — script and narration generation
- [`.ai/skills/kairos-style-analysis/SKILL.md`](./.ai/skills/kairos-style-analysis/SKILL.md) — style analysis from reference works
- [`.ai/skills/kairos-timeline/SKILL.md`](./.ai/skills/kairos-timeline/SKILL.md) — KTEP timeline assembly
- [`.ai/skills/kairos-workflow/SKILL.md`](./.ai/skills/kairos-workflow/SKILL.md) — full Kairos workflow orchestration

## Practical Defaults

- Prefer Windows PowerShell in this repository unless the user explicitly asks for WSL or the step is Linux-only.
- Treat `projects/<projectId>/pharos/` as a project-local fixed inbox: project init should create it, and Console-side project config loading should repair it if it is missing before asking the user to place trip mirrors.
- Treat `config/project-brief.json` as the single structured truth for root config; `project-brief.md` is only the human-readable mirror.
- Treat `project-brief` path mappings as the formal place to declare both current media roots and optional `原始路径`.
- Treat `/ingest-gps` `素材 Root` as the formal structured editor for those path mappings; normal user operation should not be routed back to hand-editing Markdown.
- Treat nested `rawPath/rawLocalPath` as a formal ingest exclusion boundary: the mainflow should scan the current media directory, but must not recurse into the raw subtree when it lives inside that directory.
- Treat `/color` as root-discovery-first: roots with `rawPath` should auto-appear with derived blockers/status, and Resolve naming should remain convention-derived and read-only.
- Treat `.ai/knowledge/davinci-resolve-scripting.md` as the local working DaVinci Resolve scripting documentation; any DaVinci Resolve scripting, `/color`, Resolve export, DRX/DRT, LUT automation, render job, group, node graph, or vendored host task must read it and then verify version-sensitive methods against the installed Resolve `README.txt`.
- Treat `/color` main root cards as a two-path UI: user-facing fields are `当前素材路径` and `原始素材路径`; derived Resolve naming belongs in advanced/debug display, not the primary form.
- Treat `/color` as a dashboard-style surface: `Root 摘要 -> 当前 Root Hero -> 所有 Root 常驻可编辑配置 -> Groups -> 次级诊断/归档`.
- Treat `/color` user-editable parameters as always-visible controls in the main flow for every root on the same page; collapsed sections must remain read-only diagnostics/archive only.
- Treat current `color` job support as the formal action dispatcher:
  - `prepare_root`
  - `sync_groups`
  - `execute_root`
  - `validate_batch`
  - `promote_batch`
  - `prepare_all_roots`
  - `export_all_roots`
- Treat `prepare_root` as the formal Resolve-side sync step: it must mirror `rawLocalPath` into root bins, ensure the root grading timeline has executable clips, set that timeline to the root dominant `(width, height, fps)` spec, auto-sync any missing workspace-managed LUTs for the current root into the device Resolve default LUT directory, create or reuse Resolve Groups from `logProfile + lowlight`, preserve same-clip repair grades across reruns via `CopyGrades`, and normalize every executable video clip to the canonical repair layout.
- Treat `/color` project-level orchestration as deterministic and agent-free:
  - `prepare_all_roots` runs `prepare_root` sequentially for all enabled color roots in formal priority order
  - `export_all_roots` runs `execute_root -> validate_batch -> promote_batch` sequentially for all enabled color roots in formal priority order
  - project-level color actions continue other roots after a per-root failure, but the whole job is still failed if any root fails
- Treat Resolve as the formal Group truth for color: users may keep adjusting Groups inside Resolve, and `/color` should only mirror them back via `sync_groups`; synced non-empty Groups become `ready` directly, with no extra `/color` confirm step.
- Treat root grading timeline as the formal export truth for color: render preset is root-scoped, while batch is only the execution/retry grain and may optionally carry `clipKeys[]` for subset reruns.
- Treat Resolve Groups as diagnostic/sync truth only after `sync_groups`; they no longer decide render preset, batch ownership, or execution order.
- Treat Resolve grading truth as layered:
  - `Group Post-Clip` is the formal creative truth
  - `Clip` is the formal repair/local-exception layer
  - `/color` mirrors status for those layers; it does not become the primary creative parameter editor
- Treat `lowlight` as a first-frame creative classification, not a metadata fallback or noise-only diagnosis.
- Treat `gyro` as clip-level repair truth only; it must not participate in auto-grouping.
- Treat `gyroEligible` as the final clip-level Gyro enable decision: first match the current installed Gyroflow/OFX supported device set, then require device-appropriate motion metadata; same-name `.gyroflow` projects may also enable Gyro. DJI `dvtm_*` telemetry alone is not enough to enable Gyro and must not be used to guess log profile.
- Treat repair preservation as Resolve `CopyGrades`-based for the same clip across reruns, and treat vendored clean donor `DRT` timelines as a host implementation detail for establishing the canonical repair layout when a clip has no existing repair.
- Treat the canonical clip repair layout as:
  - every executable video clip uses `Gyro -> Dehaze -> User1 -> User2 -> NR`
  - `Gyro` is always reserved at node 1; every `prepare_root` must reassert node 1 from the final clip Gyro enable decision, so `gyroEligible=true` requests enabled / `ready-to-load` and `gyroEligible=false` requests disabled (`seeded-disabled`)
  - `ready-to-load` means the Gyroflow OFX shell exists and Kairos requested the correct node enabled state; it does not prove Gyroflow's source-specific `Load for current file` button has executed
  - `Dehaze` is always reserved at node 2 and defaults disabled
  - `User1 / User2` are the minimum user zone, default enabled; users may add more user nodes only between `Dehaze` and `NR`
  - `NR` is always the reserved tail node for video clips, default disabled, and only user-toggled inside Resolve
  - `lowlight` remains a creative/grouping label and status hint; it does not auto-enable `Dehaze` or `NR`
- Treat non-canonical old clip graphs as `legacy-layout`: this round allows one destructive rebuild from workspace `config/default.drt` when present, otherwise `config/default.drx`; rerunning `prepare_root` on canonical clips must preserve the existing clip grade, user zone state, and user-toggled Dehaze/NR state while still reasserting the Gyro node from the final `gyroEligible` decision; nodes appended after `NR` intentionally make the graph legacy.
- Prefer `config/default.drt` over `config/default.drx` for clip repair seeding when available: a clean DRT donor path has been live-verified to trigger Gyroflow source loading on render, while DRX is only a layout fallback unless live evidence proves load.
- Treat `color/current.json.hostPreflight` as formal cached host truth for `/color`; blocked/degraded host state should surface before the user starts a color action.
- Treat `prepare_root / sync_groups / execute_root / prepare_all_roots / export_all_roots` as preflight-guarded actions: if Resolve host is blocked or the current render preset is unsupported, fail before Resolve-side mutation.
- Treat `color/batches/<batchId>/plan.json|manifest.json|validation.json|promote.json` as the read-only source for `/color` archive sections; do not duplicate batch history back into config or ad-hoc UI state.
- Treat `promote_batch` as a confirm-before-run action from `/color`: validation pass alone is not enough to overwrite managed outputs in the current media root.
- Treat same-machine vendored Resolve backend (`vendor/resolve-color-host/` + fixed `.venv`) as the current formal color execution path; do not route color automation back through MCP wording or design assumptions.
- Treat root-level color config as minimal and project-scoped: the only user-maintained long-term fields are `root.color.renderPreset`, `root.color.colorSpaceProfile`, and optional `root.color.transformPresetKey` on `config/project-brief.json` mappings; naming and group structure are derived or host-owned, not user config.
- Treat `root.color.renderPreset.bitrateKbps` (`kb/s`) as the only formal target bitrate field for `/color`; do not read or persist old bitrate alias fields.
- Treat `color.colorSpaceProfile` as a technical-input key, not a creative look or full gamut/primaries descriptor.
- Treat clip profile truth priority as `source metadata > XML > root.color.colorSpaceProfile fallback`; unresolved DJI private metadata must remain `unknown`, not guessed `dlog-m`.
- Treat workspace `config/color-transform-presets.json` as the formal `profile -> { deviceFamily/default -> Resolve LUT path }` mapping, and `config/luts/` as the formal optional workspace LUT asset root for same-path copy-missing sync.
- Treat current default technical transform application as Group Pre-Clip LUT automation only:
  - `root.color.transformPresetKey` overrides workspace profile/device mapping and is interpreted as a direct Resolve LUT path
  - only referenced LUTs for the current root may be synced
  - LUT sync policy is copy-missing-only into the Resolve default LUT directory when the same relative path exists under `config/luts/`
  - existing non-empty user grades must not be overwritten by Kairos default transforms
- Treat `color/current.json`, `color/groups/<rootId>.json`, and `color/batches/<batchId>/...` as system-maintained runtime/archive truth, not user config.
- Treat `color/groups/<rootId>.json` as the formal snapshot for both group creative state (`logProfile / lowlight / postClipCreativeStatus`) and clip repair state (`gyroEligible / gyroflowStatus / dehazeStatus / nrStatus / clipRepairStatus / layoutStatus`).
- Do not treat stale progress displays as proof that formal processing is alive.
- Do not silently use legacy monitor paths for new work when `Supervisor + React console` is the official entry.
- Treat workspace style-analysis as a formal deterministic prep job before Agent style synthesis, not as a UI-only placeholder.
- Treat final workspace style synthesis as a clean-context subagent chain:
  - deterministic prep writes `analysis/style-references/<category>/agent-summary.json`
  - `style-profile-synthesizer` writes `style-draft.json`
  - `style-profile-reviewer` writes `style-review.json`
  - reviewer blockers are a hard gate before `config/styles/{category}.md`
  - formal stage execution must use a host packet runner / real subagent chain; external `ILlmClient` fallback is not allowed on the official path
- Treat the end state of every Kairos-managed top-level flow as `ML stopped`.
- Treat video Analyze as a staged pipeline whose formal semantic decision happens in `finalize`:
  - with audio: `coarse-scan -> audio-analysis -> finalize -> deferred scene detect(if needed)`
  - without audio: `coarse-scan -> finalize -> deferred scene detect(if needed)`
  - `coarse-scan` prepares keyframes, `hasAudioTrack`, and source context; it does not own the formal video `visualSummary`
- Treat `coarse-scan` and `audio-analysis` as asset-level concurrent stages:
  - `coarse-scan` may advance multiple assets in parallel, but each active asset should use at most one coarse keyframe `ffmpeg`
  - `audio-analysis` now means dual health-check routing plus a single chosen ASR source for assets with `protectionAudio`
- Treat `analysis/prepared-assets/` and `analysis/audio-checkpoints/` as durable Analyze resume caches, not canonical downstream inputs.
- Treat project-local chronology as a formal shared truth:
  - `media/chronology.json` `sortCapturedAt` is the ordering truth for Script prep and Timeline placement
  - `sortCapturedAt` should resolve in this order: asset-level `capturedAtOverride` -> `asset.capturedAt + ingestRoot.clockOffsetMs` -> raw `asset.capturedAt`
  - changing a root-level clock offset in `/ingest-gps` means chronology truth changed; refresh chronology before trusting downstream ordering
- Treat `/ingest-gps` as the formal UI for both layers of time repair:
  - root-level device drift via `config/project-brief.json` mapping `clockOffsetMs`
  - asset-level exceptions via `captureTimeOverrides`
- Treat `/script` as a preparation surface by default:
  - `/script` first auto-saves the selected style category
  - changing `styleCategory` invalidates the previous script run immediately and should clear stale script artifacts before asking Agent to start over
  - Agent drafts `script/material-overview.md` and the initial `script-brief`
  - user reviews and manually saves the brief in `/script`
  - Console / Supervisor then prepare deterministic script inputs
    - `script/material-overview.facts.json`
    - `script/material-overview.md`
    - `script/segment-plan.json`
  - `script/material-slots.json`
  - `analysis/material-bundles.json`
  - Script Agent work now runs as a clean-context staged pipeline:
    - `script/spatial-story.json` + `script/spatial-story.md`
    - `script/agent-contract.json`
  - `script/agent-packets/<stage>.json`
  - `script/reviews/<stage>.json`
  - `script/agent-pipeline.json`
  - each script stage packet is the only formal subagent context; do not append hidden history or duplicate `previousDraft` / `revisionBrief` outside the packet
  - formal script stage execution must use a host packet runner / real clean-context subagent chain; external `ILlmClient` fallback is not allowed on the official path
  - first-attempt stage packets should stay lean; prior drafts belong on retry paths, not the initial call
  - the final `script/current.json` is still the only formal script artifact consumed downstream unless a newer design doc says otherwise
  - the on-disk `script/current.json` shape is always bare `IKtepScript[]`; transport wrappers such as `{ "segments": [...] }` must be unwrapped inside the stage runner before persist, never by ad-hoc main-agent repair
  - each script subagent must have a distinct identity prompt and may only read its own packet, not the main thread history
  - the main agent may orchestrate packets, user handoff, and reviewer gates, but must not silently replace missing script subagents or collapse the reviewer chain; if formal subagent execution is unavailable, stop and explain first
  - `script-current` is one formal `beat-writer` pass per attempt; do not pre-run a second full-script writer pass just to make a base draft
  - if a script writer or reviewer call fails, `script/agent-pipeline.json` must record the real failure state immediately instead of leaving stale `pending` / old-stage truth
  - outline prep should filter obvious device-command / noisy-ASR source-speech anchors and merge adjacent non-speech evidence spans before handing off to `beat-writer`
  - `buildMaterialSlotsDocument()` is now the only formal writer of `script/material-slots.json`; `route-slot-planner` is no longer allowed to rewrite `chosenSpanIds`
  - `material-slots` remains high-recall by default: process evidence, key event progression, usable source speech, and chronology anchors should stay unless they are empty, clearly bad, or near-duplicate
  - `beat-writer` may only author expression-layer fields such as `text`, `utterances`, `notes`, `muteSource`, and `preserveNatSound`; recall facts such as `audioSelections`, `visualSelections`, and `linkedSpanIds` remain locked from deterministic prep / outline
- Treat rough-cut script/timeline defaults as evidence-first:
  - videos with usable source speech should stay source-speech unless the script explicitly sets `muteSource=true`
  - photo-only beats should default to `1s` silent holds with no subtitles unless the script explicitly sets `holdMs`
  - `targetDurationMs` remains optional and advisory-only for rough cut; do not use it as the default driver for trimming or expanding effective source material
  - style / arrangement signals should constrain order, stage completeness, material roles, and forbidden zones; they should not imply default total duration or per-segment budgets
  - rough-cut recall should stay high-recall by default: keep valid spans unless they are empty, clearly bad, or near-duplicate
  - silent `drive / aerial` beats may auto-consume `speedCandidate` at `2x`; explicit `actions.speed` still overrides the default
  - source-speech beats now use `audioSelections[]` for preserved audio truth and `visualSelections[]` for companion visuals; do not collapse them back into one `selections[]`
  - source-speech audio units should merge adjacent spoken gaps `<= 3000ms` unless a strong sentence boundary blocks the merge
  - merged source-speech units should keep `120ms` head breathing and `180ms` tail breathing inside valid source bounds
  - source-speech placement stays on one serial video track plus one independent `dialogue` audio track; `nat` remains for protection/ambient fallback only
  - source-speech subtitles should follow merged audio units, then split by short clauses instead of raw ASR fragment boundaries
  - audible `dialogue` / `nat` clips should normalize toward `-16 LUFS` by clip gain during export/orchestration, not by rewriting source media
  - Timeline now has one formal internal review stage before `timeline/current.json`:
    - deterministic prep writes `timeline/rough-cut-base.json`
    - `segment-cut-refiner` writes `timeline/segment-cuts/<segmentId>.json`
    - `segment-cut-reviewer` writes `timeline/reviews/<segmentId>.json`
    - pipeline state writes `timeline/agent-pipeline.json`
  - `segment-cut-refiner` may only work within its own segment: split/merge/reorder beats, tune windows inside candidate bounds, refine source-speech handling, and override `drive / aerial` speed
  - `segment-cut-reviewer` blockers are a hard gate before formal timeline assembly; official Timeline must not silently fall back to raw beat assembly when reviewed segment-cut artifacts are missing or failed
- Reusable style assets are workspace-scoped by default:
  - `config/styles/`
  - `config/style-sources.json`
  - `analysis/reference-transcripts/`
  - `analysis/style-references/`
  - `config/style-sources.json` is the only structured style index; `config/styles/*.md` only hold profile content
- When in doubt about phase routing, start from [`.ai/skills/kairos-workflow/SKILL.md`](./.ai/skills/kairos-workflow/SKILL.md) and then move to the concrete phase skill.
- When the task touches `Pharos`, treat `../Pharos/designs` as the upstream protocol source of truth and verify its current combined hash before relying on memory.
