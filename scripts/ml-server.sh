#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-status}"
HOST="${KAIROS_ML_HOST:-127.0.0.1}"
PORT="${KAIROS_ML_PORT:-8910}"
TAIL_LINES="${KAIROS_ML_TAIL:-80}"
PYTHON_PATH="${KAIROS_ML_PYTHON:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
ML_SERVER_ROOT="$REPO_ROOT/ml-server"
RUN_ROOT="$REPO_ROOT/.tmp/run/kairos-ml"
PID_FILE="$RUN_ROOT/server.pid"
META_FILE="$RUN_ROOT/server.json"
STDOUT_LOG="$RUN_ROOT/stdout.log"
STDERR_LOG="$RUN_ROOT/stderr.log"
EXPECTED_MARKER="kairos_ml.main:app"

ensure_run_root() {
  mkdir -p "$RUN_ROOT"
}

resolve_python() {
  if [[ -n "$PYTHON_PATH" ]]; then
    echo "$PYTHON_PATH"
    return
  fi

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

  echo "ERROR: Cannot find Python. Set KAIROS_ML_PYTHON or create .venv-ml." >&2
  exit 1
}

is_server_process() {
  local pid="$1"
  if ! kill -0 "$pid" 2>/dev/null; then
    return 1
  fi
  local cmdline
  cmdline="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  [[ "$cmdline" == *"$EXPECTED_MARKER"* ]]
}

get_tracked_pid() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi
  local pid
  pid="$(cat "$PID_FILE" | tr -d '[:space:]')"
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

find_all_server_pids() {
  pgrep -f "$EXPECTED_MARKER" 2>/dev/null || true
}

health_check() {
  curl -s --max-time 3 "http://${HOST}:${PORT}/health" 2>/dev/null || true
}

write_metadata() {
  local pid="$1"
  local python="$2"
  echo "$pid" > "$PID_FILE"
  cat > "$META_FILE" <<JSONEOF
{
  "name": "kairos-ml",
  "pid": $pid,
  "host": "$HOST",
  "port": $PORT,
  "pythonPath": "$python",
  "workingDirectory": "$ML_SERVER_ROOT",
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "stdoutPath": "$STDOUT_LOG",
  "stderrPath": "$STDERR_LOG"
}
JSONEOF
}

do_stop() {
  local stopped=0

  local tracked_pid
  tracked_pid="$(get_tracked_pid 2>/dev/null || true)"
  local all_pids
  all_pids="$(find_all_server_pids)"

  local pids_to_kill=""
  if [[ -n "$tracked_pid" ]]; then
    pids_to_kill="$tracked_pid"
  fi
  for p in $all_pids; do
    if [[ " $pids_to_kill " != *" $p "* ]]; then
      pids_to_kill="$pids_to_kill $p"
    fi
  done

  pids_to_kill="$(echo "$pids_to_kill" | xargs)"
  if [[ -z "$pids_to_kill" ]]; then
    rm -f "$PID_FILE" "$META_FILE"
    echo "kairos-ml is not running."
    return
  fi

  for p in $pids_to_kill; do
    kill "$p" 2>/dev/null || true
    stopped=$((stopped + 1))
  done

  sleep 1
  for p in $pids_to_kill; do
    kill -9 "$p" 2>/dev/null || true
  done

  rm -f "$PID_FILE" "$META_FILE"
  echo "Stopped $stopped kairos-ml instance(s): $pids_to_kill"
}

do_start() {
  ensure_run_root
  local python
  python="$(resolve_python)"

  if [[ ! -d "$ML_SERVER_ROOT" ]]; then
    echo "ERROR: Cannot find ml-server directory: $ML_SERVER_ROOT" >&2
    exit 1
  fi

  do_stop > /dev/null 2>&1 || true
  rm -f "$STDOUT_LOG" "$STDERR_LOG"

  cd "$ML_SERVER_ROOT"
  nohup "$python" -m uvicorn kairos_ml.main:app \
    --host "$HOST" --port "$PORT" \
    > "$STDOUT_LOG" 2> "$STDERR_LOG" &
  local server_pid=$!
  cd "$REPO_ROOT"

  write_metadata "$server_pid" "$python"

  local health=""
  for i in $(seq 1 60); do
    sleep 1
    if ! kill -0 "$server_pid" 2>/dev/null; then
      break
    fi
    health="$(health_check)"
    if [[ -n "$health" ]]; then
      break
    fi
  done

  if [[ -z "$health" ]]; then
    echo "ERROR: kairos-ml failed to become healthy on ${HOST}:${PORT}" >&2
    if [[ -f "$STDERR_LOG" ]]; then
      echo "=== last ${TAIL_LINES} lines of stderr ===" >&2
      tail -n "$TAIL_LINES" "$STDERR_LOG" >&2
    fi
    exit 1
  fi

  local device
  device="$(echo "$health" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("device","unknown"))' 2>/dev/null || echo 'unknown')"
  echo "Started kairos-ml (PID $server_pid) on ${HOST}:${PORT} with device=$device"
}

do_status() {
  local pid
  pid="$(get_tracked_pid 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    echo "kairos-ml is not running."
    return
  fi

  local health
  health="$(health_check)"
  echo "kairos-ml is running (PID $pid) on ${HOST}:${PORT}"
  if [[ -n "$health" ]]; then
    echo "Health: $health"
  else
    echo "Health: unreachable"
  fi
}

do_logs() {
  ensure_run_root
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
    exit 1
    ;;
esac
