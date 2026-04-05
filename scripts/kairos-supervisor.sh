#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-status}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "$REPO_ROOT"
node "dist/supervisor/cli.js" "$ACTION"
