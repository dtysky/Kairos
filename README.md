# Kairos

> *καιρός — the decisive moment.*

AI-powered post-production toolkit for travel filmmakers.

From raw footage and GPS tracks to color, script, and story — Kairos finds the moments that matter and weaves them into the film they were meant to be.

> *Pharos lights the way. Kairos seizes the moment.*

## Current Shape

Kairos currently runs as a `Node.js core + Agent skills` workflow around a formal `KTEP` timeline protocol and a project store rooted at `projects/<projectId>/`.

Current stable pipeline:

- `Pharos -> ingest -> analyze -> script -> timeline -> export`
- subtitles support two formal paths:
  - narration path from `beat.text`
  - source-speech path from `slice.transcriptSegments`
- a `beat` can now optionally carry explicit `utterances[]` with head / middle / tail pauses, so subtitles only occupy voiced islands while video can continue underneath
- timeline / draft output spec is project-configurable through `config/runtime.json` and now defaults to `3840x2160 @ 30fps`
- when a beat does not use source speech, Kairos will mark selected video clips to mute their embedded audio during NLE export
- Jianying export now uses the vendored local `pyJianYingDraft` CLI, not an external Jianying MCP/server
- Jianying draft export is guarded by strict safety rules:
  - export target must be a brand-new draft directory
  - existing draft directories must never be overwritten or deleted
  - modifying an existing draft requires explicit target verification first

## Key Docs

- `designs/current-solution-summary.md` — quickest entry for the current official solution
- `designs/architecture.md` — architecture context plus current-vs-historical notes
- `designs/project-structure.md` — current project storage layout and migration notes
- `.ai/skills/` — operational workflow skills for ingest, analyze, script, timeline, and export
