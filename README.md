# Kairos

> *καιρός — the decisive moment.*

AI-powered post-production toolkit for travel filmmakers.

From raw footage and GPS tracks to color, script, and story — Kairos finds the moments that matter and weaves them into the film they were meant to be.

> *Pharos lights the way. Kairos seizes the moment.*

## Current Shape

Kairos currently runs as a `Node.js core + Agent skills` workflow around a formal `KTEP` timeline protocol and a project store rooted at `projects/<projectId>/`.

Current stable pipeline:

- `Pharos -> ingest -> analyze -> script -> timeline -> export`
- official local runtime / monitor entry is `Supervisor + React console (apps/kairos-console/)`
  - `http://127.0.0.1:8940/analyze` is the official Analyze monitor route
  - `http://127.0.0.1:8940/style` is the official workspace-level Style monitor route
  - `scripts/kairos-progress.*` and `scripts/style-analysis-progress-viewer.html` are legacy compatibility helpers, not the official path for new capability work
- reusable style assets now live at workspace scope, not project scope:
  - `config/styles/` stores the shared style library
  - `config/style-sources.json` stores the shared style-source manifest
  - `analysis/reference-transcripts/` and `analysis/style-references/` store shared style-analysis outputs
- project script work now references a workspace style category instead of owning its own `config/styles/`
- the `/script` console page now acts as deterministic script preparation:
  - user first selects a workspace `styleCategory` in `/script`; that selection auto-saves
  - agent then generates the initial `script-brief`
  - user reviews and manually saves the brief in `/script`
  - the console now surfaces these handoffs with persistent workflow prompts and explicit hana modal confirmations instead of relying on low-contrast inline copy
  - `/script` validates `store/slices.json`, the selected workspace `styleCategory`, and the matching style profile
  - `/script` refreshes deterministic prep outputs such as `analysis/material-digest.json`
  - the final `script/current.json` remains agent-authored
  - if the reviewed brief was already user-edited and a fresh initial draft is needed, overwrite permission is granted explicitly from `/script` instead of silent agent overwrite
- subtitles support two formal paths:
  - narration path from `beat.text`
  - source-speech path from `slice.transcriptSegments`
- Analyze now distinguishes tight focus windows from edit-friendly bounds:
  - coarse reports keep `interestingWindows[].startMs/endMs` as focus/evidence windows
  - edit-ready bounds travel alongside them as `interestingWindows[].editStartMs/editEndMs`
  - persisted `store/slices.json` keeps backward-compatible `sourceInMs/sourceOutMs` plus wider `editSourceInMs/editSourceOutMs`
- drive slices can now carry `speedCandidate` metadata (for example `2x / 5x / 10x` suggestions), but final retiming stays an explicit downstream decision
- a `beat` can now optionally carry explicit `utterances[]` with head / middle / tail pauses, so subtitles only occupy voiced islands while video can continue underneath
- outline / script now prefer Analyze-provided edit bounds instead of re-centering every slice by default; legacy slices without edit bounds still fall back to conservative trimming
- explicit acceleration now flows through `beat.actions.speed` -> timeline clip `speed` -> NLE export, but only `drive / aerial` clips may consume it; placement also fits clips against `beat.targetDurationMs` instead of drifting with raw source duration
- when a beat preserves source speech, Kairos now snaps the selected window outward to full `transcriptSegments` boundaries and will extend the beat if needed so the spoken sentence finishes cleanly
- timeline / draft output spec is project-configurable through `config/runtime.json` and now defaults to `3840x2160 @ 30fps`
- when a beat does not use source speech, Kairos will mark selected video clips to mute their embedded audio during NLE export
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
