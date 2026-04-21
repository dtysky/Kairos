# Resolve Color Host

Kairos uses this vendored backend as the fixed same-machine Resolve host.

Expected local layout:

- `vendor/resolve-color-host/resolve-color-host.py`
- `vendor/resolve-color-host/.venv/...`

The official Kairos `/color` path now assumes this backend directly and no longer reads
project-level Resolve Python/runtime overrides from `config/runtime.json`.
