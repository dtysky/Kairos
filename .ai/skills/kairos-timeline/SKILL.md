---
name: kairos-timeline
description: >-
  Helper for the optional `timeline.generate` Edit Flow capability. Use when a
  confirmed Flow Plan declares deterministic Resolve rough-cut generation or
  when validating the KTEP/manifest audit in `timeline/current.json`.
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
- `material-slots.json` is the only formal structured recall and rough-cut treatment source. Every chosen span must have numeric `{audio, speed}` treatment.
- Place clips deterministically by FW/slot/chosenSpanIds order; routes use only recalled chosen spans, never whole-route expansion.
- Only `drive / aerial` spans may use `speed > 1`; photos are `audio=-100, speed=1` and use timeline photo duration rules.
- Resolve rough-cut timeline creation is the success criterion. `timeline/current.json` is only the KTEP/manifest audit and must not be written as a KTEP-only fallback when Resolve is unavailable.
- For `audio <= -100`, prefer video-only append or an equivalent no-audible-audio operation. For non-zero dB gain, block unless the Resolve host live-probes `TimelineItem.GetProperty()` and verifies a writable property; do not guess `Volume`.

## Expected Inputs

- Confirmed Flow Plan and the concrete `timeline.generate` step
- `edits/<editId>/planning/edit-framework.md`
- `edits/<editId>/script/material-slots.json`
- `store/assets.json`, fresh `store/spans.json`, confirmed `media/chronology.json`

## Output Contract

The audit output is:

```text
edits/<editId>/timeline/current.json
```

The user-visible output must be the Resolve rough-cut timeline created or updated by the host. `resolve.lock_rough_cut` only reviews and locks that existing Resolve timeline; it does not create it.
