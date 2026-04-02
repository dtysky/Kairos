#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
DEFAULT_PYTHON="$REPO_ROOT/vendor/pyJianYingDraft/.venv/bin/python"
PYTHON_PATH="${KAIROS_JIANYING_PYTHON:-$DEFAULT_PYTHON}"

if [[ ! -x "$PYTHON_PATH" ]]; then
  echo "ERROR: Cannot find Jianying Python at '$PYTHON_PATH'." >&2
  echo "Create 'vendor/pyJianYingDraft/.venv' first or set KAIROS_JIANYING_PYTHON." >&2
  exit 1
fi

exec "$PYTHON_PATH" "$SCRIPT_DIR/jianying-export.py" "$@"
