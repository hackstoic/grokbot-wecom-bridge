#!/bin/bash
# Stop WeCom bridge supervisor and child (this directory only).
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"; cd "$D"

stopped=0
if [ -f supervisor.pid ]; then
  spid=$(cat supervisor.pid)
  if kill -0 "$spid" 2>/dev/null; then
    kill "$spid" 2>/dev/null || true
    stopped=1
  fi
  rm -f supervisor.pid
fi
if [ -f bridge.pid ]; then
  bpid=$(cat bridge.pid)
  if kill -0 "$bpid" 2>/dev/null; then
    # Confirm cwd before kill — never touch other bots' bridges
    cwd=$(readlink "/proc/$bpid/cwd" 2>/dev/null || true)
    if [ "$cwd" = "$D" ]; then
      kill "$bpid" 2>/dev/null || true
      stopped=1
    else
      echo "warning: bridge.pid=$bpid cwd=$cwd — refusing to kill" >&2
    fi
  fi
  rm -f bridge.pid
fi
# Fallback: kill only node bridge.mjs whose cwd is this directory
for p in $(pgrep -f '[n]ode bridge.mjs' || true); do
  cwd=$(readlink "/proc/$p/cwd" 2>/dev/null || true)
  if [ "$cwd" = "$D" ]; then
    kill "$p" 2>/dev/null || true
    stopped=1
  fi
done
sleep 1
# Final check
left=0
for p in $(pgrep -f '[n]ode bridge.mjs' || true); do
  cwd=$(readlink "/proc/$p/cwd" 2>/dev/null || true)
  if [ "$cwd" = "$D" ]; then
    left=1
    kill -9 "$p" 2>/dev/null || true
  fi
done
sleep 1
left=0
for p in $(pgrep -f '[n]ode bridge.mjs' || true); do
  cwd=$(readlink "/proc/$p/cwd" 2>/dev/null || true)
  if [ "$cwd" = "$D" ]; then
    left=1
  fi
done
if [ "$left" -eq 1 ]; then
  echo "warning: bridge process still present" >&2
  exit 1
fi
echo "stopped"
exit 0
