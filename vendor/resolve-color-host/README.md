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
- `<workspaceRoot>/config/default.drx`

The official Kairos `/color` path now assumes this backend directly and no longer reads
project-level Resolve Python/runtime overrides from `config/runtime.json`.

Clip repair cold-start / legacy rebuild prefers workspace `config/default.drt` when it
exists, because a clean DRT donor imported into Resolve can preserve Gyroflow's current
file auto-load behavior. If no DRT exists, the host falls back to `config/default.drx` for
layout seeding only. The template must apply as:

`Gyro -> Dehaze -> User1 -> User2 -> NR`

The host validates the applied grade before accepting it. If the selected template is
missing or does not match the five-node contract, `prepare_root` fails instead of silently
accepting the wrong repair layout.

On canonical reruns, the host preserves the existing clip grade, user zone, and
user-toggled Dehaze/NR state, but it still reasserts node 1 from `gyroEligible` because
Gyro is a technical repair decision. This is only a node enabled-state request. A clean
DRT donor may trigger Gyroflow's own current-file loading during render; a DRX fallback
must not be reported as source-specific Gyroflow load unless live evidence confirms it.
