#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-start}"
PROGRESS_DIR="${KAIROS_PROGRESS_DIR:-}"
SERVER_KEY="${KAIROS_PROGRESS_KEY:-kairos-progress}"
PORT="${KAIROS_PROGRESS_PORT:-8940}"
OPEN_BROWSER="${KAIROS_PROGRESS_OPEN:-true}"
TAIL_LINES="${KAIROS_PROGRESS_TAIL:-80}"

if [[ -z "$PROGRESS_DIR" ]]; then
  echo "ERROR: KAIROS_PROGRESS_DIR is required." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
VIEWER_TEMPLATE="$SCRIPT_DIR/style-analysis-progress-viewer.html"
VIEWER_ROOT="$PROGRESS_DIR"
INDEX_PATH="$VIEWER_ROOT/index.html"
SAFE_SERVER_KEY="$(printf '%s' "$SERVER_KEY" | sed 's/[^A-Za-z0-9._-]/-/g')"
RUN_ROOT="$REPO_ROOT/.tmp/run/$SAFE_SERVER_KEY"
PID_FILE="$RUN_ROOT/server.pid"
STDOUT_LOG="$RUN_ROOT/stdout.log"
STDERR_LOG="$RUN_ROOT/stderr.log"
META_FILE="$RUN_ROOT/server.json"

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
    echo "$SAFE_SERVER_KEY is not running."
    return
  fi
  kill "$pid" 2>/dev/null || true
  sleep 0.5
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE" "$META_FILE"
  echo "Stopped $SAFE_SERVER_KEY ($pid)."
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
  "name": "$SAFE_SERVER_KEY",
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

  echo "Started $SAFE_SERVER_KEY on http://127.0.0.1:$PORT/"
}

do_status() {
  local pid
  pid="$(get_tracked_pid 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    echo "$SAFE_SERVER_KEY is not running."
    return
  fi
  cat "$META_FILE" 2>/dev/null || echo "{ \"name\": \"$SAFE_SERVER_KEY\", \"pid\": $pid, \"running\": true }"
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
    echo "  KAIROS_PROGRESS_DIR   Progress directory containing progress.json" >&2
    echo "  KAIROS_PROGRESS_KEY   Process/run key (default: kairos-progress)" >&2
    echo "  KAIROS_PROGRESS_PORT  Server port (default: 8940)" >&2
    echo "  KAIROS_PROGRESS_OPEN  Open browser on start (default: true)" >&2
    exit 1
    ;;
esac
