#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-start}"
CATEGORY_SLUG="${KAIROS_SA_CATEGORY:-personal-serious-works}"
PORT="${KAIROS_SA_PORT:-8940}"
OPEN_BROWSER="${KAIROS_SA_OPEN:-true}"
TAIL_LINES="${KAIROS_SA_TAIL:-80}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
VIEWER_TEMPLATE="$SCRIPT_DIR/style-analysis-progress-viewer.html"
VIEWER_ROOT="$REPO_ROOT/.tmp/style-analysis/$CATEGORY_SLUG"
INDEX_PATH="$VIEWER_ROOT/index.html"
RUN_ROOT="$REPO_ROOT/.tmp/run/style-analysis-progress-$CATEGORY_SLUG"
PID_FILE="$RUN_ROOT/server.pid"
STDOUT_LOG="$RUN_ROOT/stdout.log"
STDERR_LOG="$RUN_ROOT/stderr.log"
META_FILE="$RUN_ROOT/server.json"
SERVER_NAME="style-analysis-progress-$CATEGORY_SLUG"

ensure_dirs() {
  mkdir -p "$VIEWER_ROOT" "$RUN_ROOT"
}

resolve_python() {
  local venv_python="$REPO_ROOT/.venv-ml/bin/python"
  if [[ -x "$venv_python" ]]; then
    echo "$venv_python"
    return
  fi
  local sys_python
  sys_python="$(command -v python3 2>/dev/null || true)"
  if [[ -n "$sys_python" ]]; then
    echo "$sys_python"
    return
  fi
  echo "ERROR: Cannot find Python runtime for progress viewer." >&2
  exit 1
}

sync_viewer_files() {
  ensure_dirs
  cp "$VIEWER_TEMPLATE" "$INDEX_PATH"
}

is_server_process() {
  local pid="$1"
  if ! kill -0 "$pid" 2>/dev/null; then
    return 1
  fi
  local cmdline
  cmdline="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  [[ "$cmdline" == *"http.server"* && "$cmdline" == *"$PORT"* ]]
}

get_tracked_pid() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi
  local pid
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  if [[ -z "$pid" ]]; then
    return 1
  fi
  if is_server_process "$pid"; then
    echo "$pid"
    return 0
  fi
  rm -f "$PID_FILE" "$META_FILE"
  return 1
}

do_stop() {
  local pid
  pid="$(get_tracked_pid 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    rm -f "$PID_FILE" "$META_FILE"
    echo "$SERVER_NAME is not running."
    return
  fi
  kill "$pid" 2>/dev/null || true
  sleep 0.5
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE" "$META_FILE"
  echo "Stopped $SERVER_NAME ($pid)."
}

do_start() {
  sync_viewer_files
  do_stop > /dev/null 2>&1 || true
  rm -f "$STDOUT_LOG" "$STDERR_LOG"

  local python
  python="$(resolve_python)"

  cd "$VIEWER_ROOT"
  nohup "$python" -m http.server "$PORT" --bind 127.0.0.1 \
    > "$STDOUT_LOG" 2> "$STDERR_LOG" &
  local server_pid=$!
  cd "$REPO_ROOT"

  echo "$server_pid" > "$PID_FILE"
  cat > "$META_FILE" <<JSONEOF
{
  "name": "$SERVER_NAME",
  "pid": $server_pid,
  "port": $PORT,
  "viewerRoot": "$VIEWER_ROOT",
  "url": "http://127.0.0.1:$PORT/",
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSONEOF

  if [[ "$OPEN_BROWSER" == "true" ]]; then
    if command -v open &>/dev/null; then
      open "http://127.0.0.1:$PORT/"
    elif command -v xdg-open &>/dev/null; then
      xdg-open "http://127.0.0.1:$PORT/"
    fi
  fi

  echo "Started $SERVER_NAME on http://127.0.0.1:$PORT/"
}

do_status() {
  local pid
  pid="$(get_tracked_pid 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    echo "$SERVER_NAME is not running."
    return
  fi
  cat "$META_FILE" 2>/dev/null || echo "{ \"name\": \"$SERVER_NAME\", \"pid\": $pid, \"running\": true }"
}

do_logs() {
  ensure_dirs
  if [[ -f "$STDOUT_LOG" ]]; then
    echo "=== stdout ==="
    tail -n "$TAIL_LINES" "$STDOUT_LOG"
  fi
  if [[ -f "$STDERR_LOG" ]]; then
    echo "=== stderr ==="
    tail -n "$TAIL_LINES" "$STDERR_LOG"
  fi
}

case "$ACTION" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop > /dev/null 2>&1 || true; do_start ;;
  status)  do_status ;;
  logs)    do_logs ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}" >&2
    echo "Environment variables:" >&2
    echo "  KAIROS_SA_CATEGORY  Category slug (default: personal-serious-works)" >&2
    echo "  KAIROS_SA_PORT      Server port (default: 8940)" >&2
    echo "  KAIROS_SA_OPEN      Open browser on start (default: true)" >&2
    exit 1
    ;;
esac
