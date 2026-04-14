# Kairos Agent Bootstrap

This file is the root bootstrap entry for any agent working in this repository.

It does not replace the actual rules, design docs, or skills. Its job is to make sure they are discoverable and read in a stable order.

## Read Order

Read these before doing substantial work:

1. `README.md`
2. `designs/current-solution-summary.md`
3. `designs/architecture.md`
4. every file under `.ai/rules/`
5. the relevant skill file(s) under `.ai/skills/`

Direct links:

1. [README.md](./README.md)
2. [designs/current-solution-summary.md](./designs/current-solution-summary.md)
3. [designs/architecture.md](./designs/architecture.md)
4. [`.ai/rules/`](./.ai/rules/)
5. [`.ai/skills/`](./.ai/skills/)

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

Operational lesson that must not be forgotten:

- `scripts/kairos-supervisor.* start` starts `Supervisor + React console`, but does not start ML and does not auto-resume old jobs
- `projects/<projectId>/.tmp/media-analyze/progress.json` is durable progress cache, not proof that a live analyze job is running
- `<workspaceRoot>/.tmp/style-analysis/<category>/progress.json` is also durable progress cache, not proof that a live style-analysis job is running
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
- Do not treat stale progress displays as proof that formal processing is alive.
- Do not silently use legacy monitor paths for new work when `Supervisor + React console` is the official entry.
- Treat workspace style-analysis as a formal deterministic prep job before Agent style synthesis, not as a UI-only placeholder.
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
  - root-level device drift via `config/ingest-roots.json` `clockOffsetMs`
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
  - the final `script/current.json` is agent-authored unless a newer design doc says otherwise
- Treat rough-cut script/timeline defaults as evidence-first:
  - videos with usable source speech should stay source-speech unless the script explicitly sets `muteSource=true`
  - photo-only beats should default to `1s` silent holds with no subtitles unless the script explicitly sets `holdMs`
  - `targetDurationMs` remains optional and advisory-only for rough cut; do not use it as the default driver for trimming or expanding effective source material
  - rough-cut recall should stay high-recall by default: keep valid spans unless they are empty, clearly bad, or near-duplicate
  - silent `drive / aerial` beats may auto-consume `speedCandidate` at `2x`; explicit `actions.speed` still overrides the default
  - source-speech beats should prefer transcript-driven speech islands, keeping only short pauses instead of long silent gaps
- Reusable style assets are workspace-scoped by default:
  - `config/styles/`
  - `config/style-sources.json`
  - `analysis/reference-transcripts/`
  - `analysis/style-references/`
  - `config/style-sources.json` is the only structured style index; `config/styles/*.md` only hold profile content
- When in doubt about phase routing, start from [`.ai/skills/kairos-workflow/SKILL.md`](./.ai/skills/kairos-workflow/SKILL.md) and then move to the concrete phase skill.
- When the task touches `Pharos`, treat `../Pharos/designs` as the upstream protocol source of truth and verify its current combined hash before relying on memory.
