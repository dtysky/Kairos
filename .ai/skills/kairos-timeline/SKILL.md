---
name: kairos-timeline
description: >-
  Helper for the optional `timeline.generate` Edit Flow capability. Use when a
  confirmed Flow Plan declares deterministic Resolve rough-cut generation or
  when validating the temporary KTEP/manifest audit in `.tmp/edit-flow/<editId>/timeline/current.json`.
---

# Kairos: Optional Timeline Capability

`kairos-timeline` is no longer a standalone phase after Script. New work reaches
timeline generation through `/edit`: a confirmed Flow Plan declares
`timeline.generate`, its `inputRefs`, its `outputRefs`, and any human gate.

## Hard Rules

- Do not require `edits/<editId>/script/current.json` or `edits/<editId>/script/segment-plan.json`.
- Consume only `edit-framework.md + material-slots.json + store/spans.json + store/assets.json + confirmed media/chronology.json`.
- Do not run `timeline.generate` when the Flow Plan is missing, unconfirmed, stale, or lacks this capability.
- Validate fresh spans and confirmed Chronology V2 before placement.
- Resolve Media Pool is the rough-cut media archive truth. Run `resolve.media_sync` first to sync the project-global `Kairos Project Media` bin by chronology event title; `timeline.generate` must select existing single-file MediaPoolItems and must not clear/reimport the namespace. Resolve timelines live in the `Kairos Timelines` bin. Photo sync must not let Resolve collapse numbered JPGs into image sequences.
- `material-slots.json` is the only formal structured recall and rough-cut treatment source. Every chosen span must have numeric `{audio, speed}` treatment.
- Place clips deterministically by FW/slot/chosenSpanIds order; routes use only recalled chosen spans, never whole-route expansion.
- `speed > 1` may remain in `material-slots.json` as a requested treatment, but current Resolve rough-cut creation ignores it and records it as pending. Photos are `audio=-100, speed=1` and require `timelineStillDurationMs` to match the user's Resolve still-image preference; the host validates the actual still duration after append.
- Resolve rough-cut timeline creation is the success criterion. `.tmp/edit-flow/<editId>/timeline/current.json` is only the local temporary KTEP/manifest audit and must not be written as a KTEP-only fallback when Resolve is unavailable.
- Create Resolve rough cuts with native Resolve APIs only, currently `MediaPool.AppendToTimeline`; do not use FCPXML for rough-cut creation. The Resolve target timeline fps must match `timelineFps` before any `recordFrame` placement; if Resolve locks a stale generated rough-cut timeline at another fps, recreate that target timeline rather than continuing with wrong placement math. Do not apply `speed > 1` until a verified native API path exists. For every video append, the host must validate actual source start/end against KTEP within two source frames. For `audio <= -100` video clips, keep the linked audio item and disable it; photos may have no audio item. For non-zero dB gain, block unless the Resolve host live-probes `TimelineItem.GetProperty()` and verifies a writable property; do not guess `Volume`.

## Expected Inputs

- Confirmed Flow Plan and the concrete `timeline.generate` step
- `edits/<editId>/planning/edit-framework.md`
- `edits/<editId>/script/material-slots.json`
- `store/assets.json`, fresh `store/spans.json`, confirmed `media/chronology.json`

## Output Contract

The audit output is:

```text
.tmp/edit-flow/<editId>/timeline/current.json
```

The user-visible output must be the Resolve rough-cut timeline created or updated by the host. `resolve.lock_rough_cut` only reviews and locks that existing Resolve timeline; it does not create it.
