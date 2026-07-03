# Resolve Color Host

Kairos uses this vendored backend as the fixed same-machine Resolve host.

Before changing this backend, read the local DaVinci Resolve scripting documentation:

- `../../.ai/knowledge/davinci-resolve-scripting.md`

Then verify version-sensitive API methods against the installed Resolve scripting
`README.txt` for the target machine.

Expected local layout:

- `vendor/resolve-color-host/resolve-color-host.py`
- `vendor/resolve-color-host/.venv/...`
- `<workspaceRoot>/config/default.drt` (preferred when present)
- optional explicit external DRX path (manual diagnostics only; no default repo fallback)

The official Kairos `/color` path now assumes this backend directly and no longer reads
project-level Resolve Python/runtime overrides from `config/runtime.json`.

Clip repair cold-start / legacy rebuild prefers workspace DRT donors because a clean DRT
imported into Resolve can preserve Gyroflow's current file auto-load behavior. Horizontal
clips use `config/default.drt`; Sony/ZV-E1 portrait clips map ffprobe and Gyroflow
orientation conventions separately. ffprobe source `rotation=90` is Gyroflow `270`
and uses `config/gyroflow-portrait--90.drt`; ffprobe source `rotation=-90/270` is
Gyroflow `90` and uses `config/gyroflow-portrait-90.drt`.
When the orchestrator detects a missing or stale portrait DRT hash in an existing prepared
root, it reruns only the affected chunk and resets each stale portrait clip graph before
reapplying the orientation DRT. The completion sync carries the current DRT hash back into
the clip snapshot.
The Kairos orchestrator blocks bulk prepare before Resolve mutation when the default
`config/default.drt` is missing for default / horizontal / unknown-direction clips. Missing
portrait orientation DRTs remain a clip-level degradation path: those clips continue with
timeline transform and a disabled Gyro node, and the host marks them as pending orientation
initialization. Each DRT template must apply as:

`Gyro -> Dehaze -> User1 -> User2 -> NR`

The host validates the applied grade before accepting it. If the selected DRT template
does not match the five-node contract, `prepare_root` fails instead of silently accepting
the wrong repair layout. The repo no longer carries `config/default.drx`; any DRX use must
be an explicit external/manual diagnostic path and is not used as a large-batch fallback.

On canonical reruns, the host preserves the existing clip grade, user zone, and
user-toggled Dehaze/NR state, but it still reasserts node 1 from `gyroEligible` because
Gyro is a technical repair decision. This is only a node enabled-state request. A clean
DRT donor may trigger Gyroflow's own current-file loading during render. Portrait clips are
also rotated and scaled with timeline item `RotationAngle / ZoomX / ZoomY / ZoomGang / Pan / Tilt`
so individual renders are horizontal, including extra fill zoom for horizontal-encoded portrait clips where
Gyroflow/DRT otherwise leaves a smaller landscape image centered in the output frame. DRX-based experiments must not be reported as source-specific Gyroflow load unless live evidence
confirms it.
