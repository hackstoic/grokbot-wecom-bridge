#!/bin/bash
# 产研Bot WeCom bridge supervisor (backup copy — secrets via env only).
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
cd "$D"

if [ -z "${WECOM_BOT_ID:-}" ]; then
  echo "WECOM_BOT_ID is not set. Refusing to start." >&2
  exit 1
fi
if [ -z "${WECOM_BOT_SECRET:-}" ]; then
  echo "WECOM_BOT_SECRET is not set. Refusing to start." >&2
  exit 1
fi
if [ -n "${WECOM_FORWARD_URL:-}" ] && [ -z "${WECOM_FORWARD_KEY:-}" ]; then
  echo "WECOM_FORWARD_URL set but WECOM_FORWARD_KEY missing. Refusing to start." >&2
  exit 1
fi

exec 9>"$D/run.lock"
if ! flock -n 9; then
  echo "already running (pid $(cat supervisor.pid 2>/dev/null || echo '?'))"
  exit 0
fi

echo $$ > supervisor.pid
trap 'kill $CHILD 2>/dev/null || true; rm -f supervisor.pid bridge.pid; exit 0' TERM INT

{
  echo "$(date -Is) [supervisor] starting"
  echo "  bot_id_set=yes secret_set=yes"
  echo "  forward_url_set=$([ -n "${WECOM_FORWARD_URL:-}" ] && echo yes || echo no)"
  echo "  forward_key_set=$([ -n "${WECOM_FORWARD_KEY:-}" ] && echo yes || echo no)"
} >> bridge.log

while true; do
  nohup node bridge.mjs >> bridge.stdout.log 2>&1 &
  CHILD=$!
  echo $CHILD > bridge.pid
  echo "$(date -Is) [supervisor] bridge pid=$CHILD" >> bridge.log
  wait $CHILD || true
  code=$?
  echo "$(date -Is) [supervisor] bridge exited code=$code, restarting in 5s" >> bridge.log
  sleep 5
done
