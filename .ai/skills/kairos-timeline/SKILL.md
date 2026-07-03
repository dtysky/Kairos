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
- `material-slots.json` is the only formal structured recall and rough-cut treatment source. `chosenSpanIds` is the selection truth; `treatments` is a sparse override map where missing span entries, `audio`, or `speed` resolve to `{audio:0,speed:1}`. Default audible normal-speed spans do not need a treatment entry. Generation and merge prompts must request integer `speed` values from `1` through `5`; downstream readers normalize decimal or over-limit raw values into that range instead of treating them as a planning failure.
- Place clips deterministically by FW/slot/chosenSpanIds order; routes use only recalled chosen spans, never whole-route expansion.
- For selected audible speech/mixed non-photo clips, `timeline.generate` must expand the Resolve source window by default handles (`240ms` head, `720ms` tail, clamped to asset duration) before append. The companion source-speech SRT still maps transcriptSegments to their true times inside the wider clip; do not stretch subtitle cues across the handle padding.
- `speed > 1` may remain in `material-slots.json` as a requested treatment, but current Resolve rough-cut creation ignores it and records it as pending. Photos are `audio=-100, speed=1`; their default still duration is `1000ms` unless the edit rule / confirmed Flow Plan or runtime `timelineStillDurationMs` explicitly overrides it. The Resolve host validates the actual still duration after append and blocks on mismatch.
- Resolve rough-cut timeline creation is the success criterion. `.tmp/edit-flow/<editId>/timeline/current.json` is only the local temporary KTEP/manifest audit and must not be written as a KTEP-only fallback when Resolve is unavailable.
- On every successful `timeline.generate`, also write a companion source-speech SRT at `.tmp/edit-flow/<editId>/timeline/current.srt` for manual Resolve import. The SRT is derived only from selected, audible source-speech spans in the generated timeline: prefer `span.transcriptSegments`, map source segment times into timeline time, clip cues to the actual timeline clip bounds, and fall back to one cue from `span.transcript` only when no segment timings exist. Cue text must strip terminal `。` / `.` periods, including before closing quotes/brackets, while preserving `？`, `！`, and internal punctuation.
- `timeline.generate` run records in `edits/<editId>/runs/current.json` must stay summary-only. Do not inline the KTEP document, Resolve clip list, source subtitle text, or `hostSummary.clips`; keep full clip-level audit in `.tmp/edit-flow/<editId>/timeline/current.json` and source subtitle text in `.tmp/edit-flow/<editId>/timeline/current.srt`.
- After a successful Resolve timeline write, attempt a project-level `${projectBrief.name} [Edit]` DRP snapshot. All editIds share `edits/resolve-project-map.json` and `edits/resolve-projects/<safe-project-key>/`; latest is named `${Resolve项目名}.drp`. Color DRP latest copies use the same named-file rule under `color/resolve-projects/<safe-project-name>/`. Snapshot failure is a warning and must not roll back the generated timeline.
- Create Resolve rough cuts with native Resolve APIs only, currently `MediaPool.AppendToTimeline`; do not use FCPXML for rough-cut creation. The Resolve target timeline fps and playback fps must both match `timelineFps` before any `recordFrame` placement; if Resolve locks a stale generated rough-cut timeline at another fps, recreate that target timeline rather than continuing with wrong placement math. Do not apply `speed > 1` until a verified native API path exists. For every video append, the host must validate actual source start/end against KTEP within two source frames. For `audio <= -100` video clips, keep the linked audio item and disable it; photos may have no audio item. Set Resolve clip colors as formal batch markers and validate them with `GetClipColor()`: ordinary audible video items and their linked audio item(s) use `Orange`, photo video items use `Blue`, timelapse video items use `Purple`; if a timelapse clip is audible, its video item stays `Purple` and its linked audio item(s) use `Orange`. Also create/reuse Resolve Color Groups `Kairos Photos` and `Kairos Timelapse`, assigning photo/timelapse video items to them for Color-page batch effects. For non-zero dB gain, block unless the Resolve host live-probes `TimelineItem.GetProperty()` and verifies a writable property; do not guess `Volume`.

## Expected Inputs

- Confirmed Flow Plan and the concrete `timeline.generate` step
- `edits/<editId>/planning/edit-framework.md`
- `edits/<editId>/script/material-slots.json`
- `store/assets.json`, fresh `store/spans.json`, confirmed `media/chronology.json`

## Output Contract

The audit output is:

```text
.tmp/edit-flow/<editId>/timeline/current.json
.tmp/edit-flow/<editId>/timeline/current.srt
```

The user-visible outputs are the Resolve rough-cut timeline created or updated by the host and the companion SRT for manual Resolve import. `resolve.lock_rough_cut` only reviews and locks that existing Resolve timeline; it does not create it.
