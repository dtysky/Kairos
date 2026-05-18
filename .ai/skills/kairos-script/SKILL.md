---
name: kairos-script
description: >-
  Legacy helper for the optional `script.generate` Edit Flow capability. Use
  only when a confirmed Flow Plan explicitly includes `script.generate`, or
  when reviewing old script artifacts.
---

# Kairos: Optional Script Capability

`kairos-script` is no longer a phase entrypoint. New edit work starts in `/edit`
with `kairos-edit-flow`; this skill only documents how to handle the optional
`script.generate` capability when the confirmed Flow Plan asks for a pre-cut
text / beat draft.

## Hard Rules

- Do not route new work through `/script`, a `script` Supervisor job, or a fixed `Script -> Timeline` chain.
- Do not require `edits/<editId>/script/current.json` before `timeline.generate`.
- Run `script.generate` only if the confirmed `edits/<editId>/planning/flow-plan.json` contains that capability and the edit-rule hash still matches.
- Read only Flow Plan declared inputs and the selected capability packet; code must not keyword-parse edit-rule markdown.
- Preserve the step's `outputRefs`; if the step writes `edits/<editId>/script/current.json`, that file remains a capability output, not a global workflow gate.
- If a style layer is required by `flow-plan.json.styleUsage`, require a selected `layered-v1` profile before execution.
- If a writer/reviewer runner fails, write the capability run failure immediately rather than leaving stale pending state.

## Expected Inputs

- Fresh `store/spans.json` plus `store/spans.meta.json` with `status=fresh`
- Confirmed Chronology V2 at `media/chronology.json`
- Confirmed Flow Plan at `edits/<editId>/planning/flow-plan.json`
- The specific `script.generate` step with declared `inputRefs` and `outputRefs`
- Optional reviewed planning artifacts or style layers only when declared by the step

## Output Contract

When the step writes a script document, keep the on-disk shape as bare
`IKtepScript[]`. If an agent transport returns `{ "segments": [...] }`, unwrap it
inside the stage runner before persistence.

`beat-writer`-style logic may edit expression fields such as `text`,
`utterances`, `notes`, `muteSource`, and `preserveNatSound`. Recall facts such as
`audioSelections`, `visualSelections`, and `linkedSpanIds` must come from the
declared predecessor outputs and should not be silently invented or dropped.
