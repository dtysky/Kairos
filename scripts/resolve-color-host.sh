#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
BACKEND_ROOT="$REPO_ROOT/vendor/resolve-color-host"
PYTHON_PATH="$BACKEND_ROOT/.venv/bin/python"
HOST_SCRIPT="$BACKEND_ROOT/resolve-color-host.py"

if [[ ! -f "$HOST_SCRIPT" ]]; then
  echo "ERROR: Cannot find Resolve color host script at '$HOST_SCRIPT'." >&2
  echo "Expected fixed vendored backend root: '$BACKEND_ROOT'." >&2
  exit 1
fi

if [[ ! -x "$PYTHON_PATH" ]]; then
  echo "ERROR: Cannot find Resolve backend Python at '$PYTHON_PATH'." >&2
  echo "Create the fixed vendored backend venv under '$BACKEND_ROOT/.venv' first." >&2
  exit 1
fi

exec "$PYTHON_PATH" "$HOST_SCRIPT" "$@"
