# Resolve Color Host

Versioned scene preparation consumes current Analyze evidence. It creates real scene Groups with portrait exclusive, seeds the unified seven-node DRT, and configures RCM v2 with explicit per-clip Input Color Space, DWG/Intermediate working space, and Rec.709 Gamma 2.4 output. Group Pre-Clip receives no technical LUT. Existing old technical groups block migration; scene reruns preserve all existing node states. Explicit clipKeys scopes append-only preparation. See [pipeline contract](../../designs/media-version-analysis-color-pipeline.md).

Kairos uses this vendored backend as the fixed same-machine Resolve host.

Before changing this backend, read the local DaVinci Resolve scripting documentation:

- `../../.ai/knowledge/davinci-resolve-scripting.md`

Then verify version-sensitive API methods against the installed Resolve scripting
`README.md` / `DaVinciResolveScript.pyi` / `CHANGELOG.md` (legacy: `README.txt`) for the target machine.

Expected local layout:

- `vendor/resolve-color-host/resolve-color-host.py`
- `vendor/resolve-color-host/resolve_edit_tools.py` (bounded edit maintenance; [contract](../../designs/resolve-edit-tools.md))
- `vendor/resolve-color-host/.venv/...`
- `<workspaceRoot>/config/default.drt` (preferred when present)
- optional explicit external DRX path (manual diagnostics only; no default repo fallback)

The official Kairos `/color` path now assumes this backend directly and no longer reads
project-level Resolve Python/runtime overrides from `config/runtime.json`.

All new clips use `config/default.drt` with the strict seven-node layout:

`Gyroflow -> Dehaze -> User1 -> User2 -> Beauty -> Blemish Removal -> Noise Reduction`

Beauty/Blemish default on only for accepted presenter clips; Dehaze/NR default off.
Existing scene items keep grades in place, including five-node compatibility layouts;
custom layouts block instead of being overwritten. Same-group preparation preserves
manual toggles. Crossing the presenter boundary changes only the two beauty toggles.
Seed hashes describe the donor actually applied, never the latest file merely observed.
Template hash drift does not reset graphs or trigger a prepare chunk.

Horizontal and portrait clips share this donor. Raw rotation independently sets Edit
RotationAngle (+90 -> -90, -90/270 -> +90, native portrait -> 0), preserving existing
fill/framing math and existing manual Inspector transforms. Historical portrait keys
remain audit metadata; their files are no longer production dependencies.

Missing default DRT blocks all directions. Imported donors must pass native seven-node
inspection. Gyroflow eligibility and node presence do not prove source-specific load;
that evidence must be recorded separately. DRX remains manual diagnostics only.
