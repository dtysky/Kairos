# Resolve Color Host

Kairos uses this vendored backend as the fixed same-machine Resolve host.

Expected local layout:

- `vendor/resolve-color-host/resolve-color-host.py`
- `vendor/resolve-color-host/.venv/...`
- `<workspaceRoot>/config/default.drx`

The official Kairos `/color` path now assumes this backend directly and no longer reads
project-level Resolve Python/runtime overrides from `config/runtime.json`.

Clip repair cold-start / legacy rebuild uses only workspace `config/default.drx`. That
DRX must be exported from Resolve with a clip graph that applies as:

`Gyro -> Dehaze -> User1 -> User2 -> NR`

The host validates the applied grade before accepting it. If the DRX file is missing or
does not match the five-node contract, `prepare_root` fails instead of silently accepting
the wrong repair layout.
