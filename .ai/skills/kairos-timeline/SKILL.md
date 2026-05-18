---
name: kairos-timeline
description: >-
  Helper for the optional `timeline.generate` Edit Flow capability. Use when a
  confirmed Flow Plan declares KTEP timeline generation or when validating a
  `timeline/current.json` output.
---

# Kairos: Optional Timeline Capability

`kairos-timeline` is no longer a standalone phase after Script. New work reaches
timeline generation through `/edit`: a confirmed Flow Plan declares
`timeline.generate`, its `inputRefs`, its `outputRefs`, and any human gate.

## Hard Rules

- Do not require `edits/<editId>/script/current.json`; consume only the Flow Plan declared predecessor outputs.
- Do not run `timeline.generate` when the Flow Plan is missing, unconfirmed, stale, or lacks this capability.
- Validate fresh spans and confirmed Chronology V2 before placement.
- Preserve chronological guardrails from `media/chronology.json.sortCapturedAt`; do not fall back to raw `asset.capturedAt`.
- If internal segment-cut review artifacts are required by the step, block instead of silently falling back to raw beat assembly.
- `timeline/current.json` may remain the KTEP output file name, but it is a capability output, not proof of a fixed Timeline stage.

## Expected Inputs

- Confirmed Flow Plan and the concrete `timeline.generate` step
- Step `inputRefs`, such as reviewed planning markdown, material recall JSON, optional script output, or KTEP draft fragments
- `store/assets.json`, fresh `store/spans.json`, confirmed `media/chronology.json`, and relevant asset reports when the step needs placement facts

## Output Contract

The primary timeline output is usually:

```text
edits/<editId>/timeline/current.json
```

Internal helper outputs may include:

- `edits/<editId>/timeline/rough-cut-base.json`
- `edits/<editId>/timeline/segment-cuts/<segmentId>.json`
- `edits/<editId>/timeline/reviews/<segmentId>.json`
- `edits/<editId>/timeline/agent-pipeline.json`

These remain implementation details of `timeline.generate` unless the Flow Plan
declares them as step outputs or downstream inputs.
