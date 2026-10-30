#!/bin/bash
# 运营Bot WeCom bridge supervisor (backup copy — secrets via env, not .env files).
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
cd "$D"

for v in WECOM_BOT_ID WECOM_BOT_SECRET; do
  if [ -z "${!v:-}" ]; then echo "$v not set" >&2; exit 1; fi
done
# Optional: WECOM_FORWARD_URL, WECOM_FORWARD_KEY (Bearer … or raw key), WECOM_HTTP_PORT (default 8789)
export WECOM_HTTP_PORT="${WECOM_HTTP_PORT:-8789}"

exec 9>"$D/run.lock"
if ! flock -n 9; then echo "already running (pid $(cat supervisor.pid 2>/dev/null || echo '?'))"; exit 0; fi
echo $$ > supervisor.pid
trap 'kill $CHILD 2>/dev/null || true; rm -f supervisor.pid bridge.pid; exit 0' TERM INT
echo "$(date -Is) [supervisor] starting yunying bridge on port $WECOM_HTTP_PORT" >> bridge.log
while true; do
  nohup node bridge.mjs >> bridge.stdout.log 2>&1 &
  CHILD=$!; echo $CHILD > bridge.pid
  wait $CHILD || true
  echo "$(date -Is) [supervisor] bridge exited, restarting in 5s" >> bridge.log
  sleep 5
done
