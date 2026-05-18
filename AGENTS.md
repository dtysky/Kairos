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
3. if hash changed, treat it as a mandatory protocol-sync task first: re-read current `../Pharos/designs/`, sync Kairos docs/rules/skills/code impact, run `node scripts/pharos-protocol-hash.mjs --write-baseline`, then verify `node scripts/pharos-protocol-hash.mjs --check` before ordinary Pharos work continues

## Official Runtime Entry

The current official local runtime and monitor path is:

- `Supervisor + React console (apps/kairos-console/)`
- Analyze monitor route: `http://127.0.0.1:8940/analyze`
- Style monitor route: `http://127.0.0.1:8940/style` (workspace-level style library / style-analysis monitor)
- Edit Flow route: `http://127.0.0.1:8940/edit` (剪辑规则驱动的原子能力流；Chronology 之后的正式剪辑入口)
- Color route: `http://127.0.0.1:8940/color` (independent DaVinci color render-preset/action/runtime surface backed by the same-machine vendored Resolve backend)

Operational lesson that must not be forgotten:

- `scripts/kairos-supervisor.* start` starts `Supervisor + React console`, but does not start ML and does not auto-resume old jobs
- 只要改动影响正式本地运行入口、Supervisor API、`/analyze`、`/style`、`/color` 或 `apps/kairos-console/`，验证必须同时跑：
  - 根仓 `pnpm build`
  - `npm --prefix apps/kairos-console run build`
- 不要把根仓 `pnpm build` 误当成已经覆盖 React console 产物；前端 bundle 需要单独 build
- `projects/<projectId>/.tmp/media-analyze/progress.json` is durable progress cache, not proof that a live analyze job is running
- Analyze resume derives the first live stage from actual artifacts, not from `progress.json.step`: if coarse reports are complete and only fine-scan work remains, the monitor should enter `fine-scan-prefetch` instead of briefly resetting to `prepare`.
- Analyze fact truth lives in `analysis/asset-reports/*.json`; `store/spans.json` and `media/chronology.json` are downstream indexes explicitly rebuilt from `/chronology`.
- In asset reports, `interestingWindows[]` is the pre-fine-scan plan and `fineScanWindows[]` is the post-fine-scan recognized/dropped window result; existing complete `fineScanWindows` must be reused for span rebuilds instead of rerunning visual analysis.
- Analyze must not append or rebuild spans during coarse/direct, fine-scan, or finalize; Analyze must write usable visual descriptions for keep non-audio material, including `summary` for direct materialization and `fineScanWindows[].visualObservation` for recognized fine-scan windows. `/chronology` `span-rebuild` explicitly rebuilds `store/spans.json` and `store/spans.meta.json` from `store/assets.json + analysis/asset-reports/*.json`; it fails on missing reports or missing `visualObservation`, then uses the local qwen text LM through the ML service to derive Chinese `materialPatterns[]` from each span's `type / semanticKind / transcript / visualObservation` only; LM returns ordered pattern rows and code maps them back to spans by material-time chunk order.
- `materialPatterns[]` remains `string[]`; the LM prompt requests exactly seven tags: four validated leading tags, one LLM-authored `情景故事` slot, then two LLM-authored free tags. The first four are controlled `拍摄视角/构图形态`, extractive `当前环境`, natural observable `天气光线`, and binary `口播语音` (`有口播语音` / `无口播语音`). Entry 1 describes observable capture/composition evidence only; it must not repeat photo/video carrier type or encode edit purpose such as `建场 / 记录 / 成果`. Entries 5-7 come from the LM; code must not invent free tags, rewrite old tags, or apply compatibility mappings. Missing or invalid required slots enter the failed-span list, are retried as a single span after the main chunks, and still fail the rebuild if invalid after retry.
- `/chronology` must surface active `span-rebuild` progress from `.tmp/chronology/progress.json`, including 10-span text-LM chunk progress, failed-list retry progress, warning state, failed/recovered counts, and the `.tmp/chronology/span-rebuild.partial.json` checkpoint for completed materialPatterns and failed spans.
- `span-rebuild` must not write `speedCandidate`, `pharosRefs`, `grounding`, `spatialEvidence`, `location`, `routeRole`, or chronology event fields; speed strategy is a later downstream flow.
- `/chronology` `chronology-build` requires fresh spans, then rebuilds `media/chronology.json` from assets + spans + root time + Pharos context.
- `chronology-build` progress must be phase-specific and live: input load, Pharos/GPS load, asset time index, inputs hash, span spatial row parsing, row sorting, event/route aggregation, GPS reverse-geocode location resolution, gap generation, review-state merge, and final write. Do not show stale `span-rebuild` progress as a running chronology-build.
- `chronology-build` treats Pharos point events as hard route boundaries. Pharos `continuous` only provides route time context / route summary context; its route prose such as `深圳 → 南宁 全程` must never be written to chronology `event.location`, `route.from`, or `route.to`. Ordinary event aggregation is driven by adjacent chronological order, time continuity, and GPS trajectory continuity; reverse-geocode labels, titles, `materialPatterns`, `visualObservation`, and transcript keywords must not decide whether rows merge or become route. `route` is produced only from structured `drive` spans and short-gap companions already inside a route cluster. Ordinary non-Pharos photos are accessory material: they must not seed an `event` or interrupt a route; attach them to route `spanIds` first by time range, then attach remaining photos to the nearest ordinary event by time.
- Chronology V2 route/event place names are GPS reverse-geocode truth: each route resolves start/end GPS from that route's actual `startAt/endAt`, ordinary non-Pharos events resolve a midpoint GPS, and `chronology-build` uses the project `gps/reverse-geocode-cache.json` with cache-first, rate-limited provider calls. Project chronology writes must fail if the reverse-geocode service is unavailable or any route/event GPS anchor cannot be resolved; they must not fall back to asset tags, `materialPatterns`, manual itinerary prose, Pharos continuous prose, or generic English place text. Pharos point event labels stay authoritative; only missing point labels may fall back to actual-window GPS reverse geocode.
- Pharos point events default to `reviewStatus=confirmed` when generated; no-span Pharos gaps remain `pending`.
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
- [`.ai/rules/script-skill-enforcement.mdc`](./.ai/rules/script-skill-enforcement.mdc) — read `kairos-script` only when a confirmed Flow Plan explicitly asks for `script.generate`
- [`.ai/rules/windows-shell-environment.mdc`](./.ai/rules/windows-shell-environment.mdc) — on Windows, prefer native PowerShell unless the user explicitly wants WSL or a Linux-only step is required

## Skills Index

Read the relevant `SKILL.md` before phase-specific work. Current skills are:

- [`.ai/skills/deploy-kairos/SKILL.md`](./.ai/skills/deploy-kairos/SKILL.md) — deployment, fresh-machine setup, cross-device environment bring-up
- [`.ai/skills/kairos-analyze/SKILL.md`](./.ai/skills/kairos-analyze/SKILL.md) — analyze phase, coarse reports, fine-scan, monitor semantics
- [`.ai/skills/kairos-export/SKILL.md`](./.ai/skills/kairos-export/SKILL.md) — export router
- [`.ai/skills/kairos-export-jianying/SKILL.md`](./.ai/skills/kairos-export-jianying/SKILL.md) — Jianying draft export and subtitle output
- [`.ai/skills/kairos-export-resolve/SKILL.md`](./.ai/skills/kairos-export-resolve/SKILL.md) — DaVinci Resolve export
- [`.ai/skills/kairos-ingest/SKILL.md`](./.ai/skills/kairos-ingest/SKILL.md) — media ingest and project asset inventory
- [`.ai/skills/kairos-edit-flow/SKILL.md`](./.ai/skills/kairos-edit-flow/SKILL.md) — edit-rule-driven atomic edit capability flow after Chronology
- [`.ai/skills/kairos-project-init/SKILL.md`](./.ai/skills/kairos-project-init/SKILL.md) — project initialization and environment rehydration
- [`.ai/skills/kairos-script/SKILL.md`](./.ai/skills/kairos-script/SKILL.md) — legacy script/beat helpers only when a confirmed Flow Plan explicitly asks for `script.generate`
- [`.ai/skills/kairos-style-analysis/SKILL.md`](./.ai/skills/kairos-style-analysis/SKILL.md) — style analysis from reference works
- [`.ai/skills/kairos-timeline/SKILL.md`](./.ai/skills/kairos-timeline/SKILL.md) — KTEP timeline assembly helper only when a confirmed Flow Plan explicitly asks for `timeline.generate`
- [`.ai/skills/kairos-workflow/SKILL.md`](./.ai/skills/kairos-workflow/SKILL.md) — full Kairos workflow orchestration

## Practical Defaults

- Prefer Windows PowerShell in this repository unless the user explicitly asks for WSL or the step is Linux-only.
- Treat `projects/<projectId>/pharos/` as a project-local fixed inbox: project init should create it, and Console-side project config loading should repair it if it is missing before asking the user to place trip mirrors.
- Treat `config/project-brief.json` as the single structured truth for root config; `project-brief.md` is only the human-readable mirror.
- Treat `project-brief` path mappings as the only formal place to declare current media roots, optional `原始路径`, and ordered alternates (`备选路径N` / `原始路径N`).
- Treat `/ingest-gps` `素材 Root` as the formal structured editor for those path mappings; normal user operation should not be routed back to hand-editing Markdown.
- Treat `/ingest-gps` as the formal Ingest / GPS refresh control surface: saving config does not scan media, `运行 Ingest` must trigger the Supervisor `ingest` job, and `刷新 GPS 缓存` must trigger `gps-refresh`.
- Treat Ingest / GPS refresh as the formal Pharos parse point: both `运行 Ingest` and `刷新 GPS 缓存` refresh `analysis/pharos-context.json`, which must invalidate by project-local `pharos/` input fingerprint.
- Treat `captureTimePolicy.mode=manual-required` on a root as a hard manual-time gate: matching assets require explicit `正确日期 / 正确时间 / 时区` before Analyze.
- Treat `/analyze` as a consumer of existing assets, GPS caches, and Pharos context, not an implicit ingest runner and not a span/chronology builder; after changing roots, FlightRecord, manual-itinerary, Pharos files, root clock offset, or capture-time overrides, refresh from `/ingest-gps` before trusting Analyze, then return to `/chronology` to rebuild spans/chronology.
- Do not use `device-media-maps.local.json` as a formal config or cache; runtime path resolution must come directly from the readable `project-brief` primary/alternate path candidates.
- Treat nested resolved `rawLocalPath` as a formal ingest exclusion boundary: the mainflow should scan the resolved current media directory, but must not recurse into the resolved raw subtree when it lives inside that directory.
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
  - `prepare_all_roots`
  - `export_all_roots`
- Treat `prepare_root` as the formal Resolve-side sync step: it must mirror `rawLocalPath` into root bins, ensure the root grading timeline has executable clips, set that timeline to the root dominant `(width, height, fps)` spec, auto-sync any missing workspace-managed LUTs for the current root into the device Resolve default LUT directory, create or reuse Resolve Groups from `logProfile + first-match review addon`, preserve same-clip repair grades across reruns via `CopyGrades`, and normalize every executable video clip to the canonical repair layout.
- Treat `/color` project-level orchestration as deterministic and agent-free:
  - `prepare_all_roots` runs `prepare_root` sequentially for all enabled color roots in formal priority order
  - `export_all_roots` runs `execute_root` sequentially for all enabled color roots in formal priority order; each root execution renders, replaces confirmed outputs, repairs metadata, and validates before the next root
  - project-level color actions continue other roots after a per-root failure, but the whole job is still failed if any root fails
- Treat Resolve as the formal Group truth for color: users may keep adjusting Groups inside Resolve, and `/color` should only mirror them back via `sync_groups`; synced non-empty Groups become `ready` directly, with no extra `/color` confirm step.
- Treat root grading timeline as the formal export truth for color: render preset is root-scoped, while batch is only the execution/retry grain and may optionally carry `clipKeys[]` for subset reruns.
- Treat Resolve Groups as diagnostic/sync truth only after `sync_groups`; they no longer decide render preset, batch ownership, or execution order.
- Treat Resolve grading truth as layered:
  - `Group Post-Clip` is the formal creative truth
  - `Clip` is the formal repair/local-exception layer
  - `/color` mirrors status for those layers; it does not become the primary creative parameter editor
- Treat automatic `/color` grouping as `logProfile` first, then exactly one addon within that log bucket by priority: `portrait-review -> lowlight -> colorCastClass -> exposureSceneClass`; never merge the same addon across different log profiles.
- Treat `lowlight` as a clip-midpoint single-frame creative classification, not a metadata fallback or noise-only diagnosis.
- Treat `colorCastClass` as a high-confidence review addon after portrait and lowlight; `neutral / unknown` do not split groups, and weak color-cast continuity smoothing must not promote clips already diagnosed as white-reference underexposed.
- Treat `exposureSceneClass` as a post-technical-transform review addon after portrait, lowlight, and high-confidence color cast; only obvious `high-contrast / overexposed / underexposed` clips split groups, including backlit/silhouette or cabin/window high contrast where the highlight area may be narrow but the luma tail is large, clearly clipped/high-bright overexposure, and white-reference underexposure where snow or other low-saturation high-key areas are compressed gray without a real bright tail. White-reference underexposure remains a single-frame decision and should use white-reference coverage, EV lift-to-target, and predicted post-lift highlight headroom instead of continuity propagation. White-reference underexposure uses `logProfile + white-reference-underexposed` as the Resolve Group addon while keeping `exposureSceneClass=underexposed`; it must not auto-enable `Dehaze / NR`.
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
- Treat ZV-E1 / Sony portrait Gyro as orientation-aware, not unsupported: parse ffprobe `rotate/display matrix`, use `config/default.drt` for horizontal clips, map ffprobe `rotation=90` to Gyroflow `270` / `config/gyroflow-portrait--90.drt`, and map ffprobe `rotation=-90/270` to Gyroflow `90` / `config/gyroflow-portrait-90.drt`; if the needed portrait DRT is missing, keep prepare running, disable auto Gyro for that clip, and mark `pending-orientation-template`.
- Treat portrait clips in `/color` as horizontal-output clips by default: `prepare_root` must set timeline item `RotationAngle / ZoomX / ZoomY / ZoomGang / Pan / Tilt` to rotate and fill the horizontal root timeline, including extra fill zoom for Gyroflow/DRT outputs that otherwise land as a smaller landscape image inside the horizontal frame.
- Treat portrait DRT hash drift as a clip-level reset/reapply trigger: if an existing prepared root has a missing or stale portrait template hash, rerun only the affected chunk, call `ResetAllGrades()` on each stale portrait clip repair graph, then reapply the orientation DRT; final sync must persist the current DRT hash.
- Treat non-canonical old clip graphs as `legacy-layout`: this round allows one destructive rebuild from workspace `config/default.drt` when present; when DRT is missing, bulk `prepare_root` must skip automatic repair seeding and mark clips `pending-template` instead of using `config/default.drx`; rerunning `prepare_root` on canonical clips must preserve the existing clip grade, user zone state, and user-toggled Dehaze/NR state while still reasserting the Gyro node from the final `gyroEligible` decision; nodes appended after `NR` intentionally make the graph legacy.
- Treat `config/default.drt` as the only formal automatic clip repair seed source: a clean DRT donor path has been live-verified to trigger Gyroflow source loading on render, while DRX is retained only for manual diagnostics unless new live evidence proves it safe and source-correct for bulk prepare.
- Treat `color/current.json.hostPreflight` as formal cached host truth for `/color`; blocked/degraded host state should surface before the user starts a color action.
- Treat `prepare_root / sync_groups / execute_root / prepare_all_roots / export_all_roots` as preflight-guarded actions: if Resolve host is blocked or the current render preset is unsupported, fail before Resolve-side mutation.
- Treat `color/batches/<batchId>/plan.json|manifest.json|validation.json` as the read-only source for `/color` archive sections; do not duplicate batch history back into config or ad-hoc UI state.
- Treat `execute_root` as confirmed root output replacement: before Resolve starts, Kairos must generate a final-target overwrite preview and require matching `overwriteConfirmed + overwritePlanHash` when existing outputs will be replaced.
- Treat Resolve color export as direct-root by raw parent directory: for `execute_root`, the host copies the official root grading timeline into temporary render timelines grouped by `rawRelativePath` parent directory, prunes each one to that directory's clips, queues all jobs, calls one render-all, and writes directly to final `localPath/<relativeDir>/sourceStem.ext`.
- Treat Resolve color output naming as strict Source Name: do not set `CustomName` or `UniqueFilenameStyle`; prefix/suffix outputs such as `V1-0001_C1611.ext` are render-setting failures, not filenames Kairos should adapt to.
- Treat `promote_batch` as removed from the formal color export path; a successful `execute_root` has already repaired metadata, validated, and adopted the final outputs.
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
- Treat `color/groups/<rootId>.json` as the formal snapshot for both group creative/review state (`logProfile / orientationStatus / lowlight / colorCastClass / exposureSceneClass / postClipCreativeStatus`) and clip repair state (`gyroEligible / gyroflowStatus / dehazeStatus / nrStatus / clipRepairStatus / layoutStatus`).
- Do not treat stale progress displays as proof that formal processing is alive.
- Do not silently use legacy monitor paths for new work when `Supervisor + React console` is the official entry.
- Treat workspace style-analysis as a formal deterministic prep job before Agent style synthesis, not as a UI-only placeholder.
- Treat final workspace style synthesis as a clean-context subagent chain:
  - deterministic prep writes `analysis/style-references/<category>/agent-summary.json`
  - `style-profile-synthesizer` writes `style-draft.json`
  - `style-profile-reviewer` writes `style-review.json`
  - reviewer blockers are a hard gate before `config/styles/{category}.md`
  - formal stage execution must use a real clean-context Agent/SubAgent chain; external `ILlmClient` is not an official executor
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
  - changing a root-level clock offset in `/ingest-gps` means span/chronology truth changed; rerun `/chronology` span-rebuild and chronology-build before trusting downstream ordering
- Treat `/ingest-gps` as the formal UI for both layers of time repair:
  - root-level device drift via `config/project-brief.json` mapping `clockOffsetMs`
  - root-level manual-required time policy via `config/project-brief.json` mapping `captureTimePolicy`
  - asset-level exceptions via `captureTimeOverrides`
  - after edits, user must explicitly run `运行 Ingest` before those changes update `store/assets.json / gps/derived.json / analysis/pharos-context.json`; then explicitly refresh spans / chronology from `/chronology`
- Treat workspace `剪辑规则` as the formal edit-flow definition after Chronology:
  - `config/edit-rules/*.md` is the human-maintained edit-rule library and the only rule-content source
  - rule categories are discovered by scanning markdown frontmatter / filenames; do not treat `config/edit-rules.json` as rule truth for new work
  - `editRuleCategory` is independent from `styleCategory`
  - `edits/<editId>/planning/flow-plan.json` is the explicit LLM-authored execution plan derived from the selected rule markdown, project context, and the capability registry
  - `/edit` is the formal user-facing surface after `/chronology`; do not route new work through `/script`, a `script` job, or a fixed `Script -> Timeline` chain
  - every edit-flow step must execute only when its confirmed Flow Plan step exists, matches the current edit-rule hash, and its declared `inputRefs` are present
  - code must only parse Flow Plan fields such as `capabilityId`, `inputRefs`, `outputRefs`, `gate`, runner metadata, and `execution`; it must not keyword-parse edit-rule markdown into arrangement heuristics
  - natural-language edit rules may request `SubAgent` work, shard granularity, and threshold packing; Flow Planner must translate that into `step.execution`, including `shardPacking`, and runtime code may only read the confirmed Flow Plan execution field
  - every Edit Flow `sharded-agent` step must carry `codexSubagentProfile={reasoningEffort: "high", forkContext: false, speed: "standard"}`; Codex agents must be spawned directly from the confirmed Flow Plan step with bounded step/shard context and must not fork the current long context
  - `trip.event_table` is an event-level chronology planning step and must declare only `media/chronology.json`; spans and asset reports belong to material archive/recall steps
  - `script.generate` is optional and appears only when the selected剪辑规则 explicitly asks for a pre-cut text/beat draft; it is not a mandatory narration step
  - `timeline.generate` must consume Flow Plan declared predecessor outputs and must not require `edits/<editId>/script/current.json`
  - style analysis output in `config/styles/` is now a `layered-v1` profile with `literary / artistic / editingTechnical` layers; these layers are not formal edit rules by themselves
  - Flow Planner must structure any edit-rule-requested style use into confirmed `flow-plan.json.styleUsage`; code may only inject style layers authorized there and must not keyword-parse edit-rule markdown or legacy style prose
  - if `styleUsage` needs any style layer but `styleCategory` is missing or the selected profile is legacy non-layered, Flow Plan confirmation / edit-flow execution must block and ask the user to choose or regenerate a `layered-v1` profile
- Treat a Kairos project as a shared material workspace that may contain multiple independent Edit Units:
  - shared truth stays at project root: `pharos/`, `store/`, `analysis/`, `media/chronology.json`, `color/`
  - edit-specific truth lives under `edits/<editId>/planning/`, `edits/<editId>/runs/`, and capability-owned output directories such as `timeline/` or `subtitles/`
  - new edit-flow work does not use legacy root-level `script/`, `timeline/`, or `subtitles/` aliases
  - Edit Flow APIs must accept optional `editId`, defaulting to `main`
  - Resolve edit naming is deterministic: Project `${projectBrief.name} [Edit]`, Timeline `${editLabel} [${editId}]`
  - locked first rough cuts persist to `edits/<editId>/timeline/locked-rough-cut.json`
- Treat `/edit` as the formal edit surface:
  - `/edit` selects the edit rule and optional layered style profile, generates/confirms Flow Plan, then runs confirmed steps one by one
  - changing `editRuleCategory` invalidates the existing Flow Plan and step runs; do not infer a migration from old script/timeline artifacts
  - each step writes its own declared outputs and a lightweight run record under `edits/<editId>/runs/<runId>/`
  - Agent-backed Flow Plan / step work must run through direct Agent/SubAgent execution; when that executor is unavailable, the action blocks before writing step outputs or temporary runner artifacts
  - human-gated steps must pause at `awaiting_review` until `/edit` confirms the step
  - do not introduce a required global beat/script intermediate; beat-like, recall, framework, KTEP, subtitle, and Resolve-lock artifacts are capability-owned outputs
  - reusable deterministic helpers, Agent-backed stages, and external scripts should be registered as capability runner implementations rather than hidden inside fixed phase code
  - `timeline/current.json` may remain the KTEP output of `timeline.generate`, but it is not proof that a fixed Timeline phase exists
- Reusable style assets are workspace-scoped by default:
  - `config/styles/`
  - `config/style-sources.json`
  - `analysis/reference-transcripts/`
  - `analysis/style-references/`
  - `config/style-sources.json` is the only structured style index; `config/styles/*.md` only hold profile content
- When in doubt about edit routing after Chronology, start from [`.ai/skills/kairos-edit-flow/SKILL.md`](./.ai/skills/kairos-edit-flow/SKILL.md).
- When the task touches `Pharos`, treat `../Pharos/designs` as the upstream protocol source of truth. A hash mismatch is not just a reminder to reread; it must be resolved by syncing Kairos-side protocol assumptions and refreshing the baseline before continuing ordinary Pharos implementation.
