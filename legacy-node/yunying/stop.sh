#!/bin/bash
# Stop WeCom bridge supervisor and child (this directory only).
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
cd "$D"

if [ -f supervisor.pid ]; then
  spid=$(cat supervisor.pid 2>/dev/null || true)
  if [ -n "${spid:-}" ] && kill -0 "$spid" 2>/dev/null; then
    kill "$spid" 2>/dev/null || true
  fi
  rm -f supervisor.pid
fi
if [ -f bridge.pid ]; then
  bpid=$(cat bridge.pid 2>/dev/null || true)
  if [ -n "${bpid:-}" ] && kill -0 "$bpid" 2>/dev/null; then
    cwd=$(readlink "/proc/$bpid/cwd" 2>/dev/null || true)
    if [ "$cwd" = "$D" ]; then
      kill "$bpid" 2>/dev/null || true
    else
      echo "warning: bridge.pid=$bpid cwd=$cwd — refusing to kill" >&2
    fi
  fi
  rm -f bridge.pid
fi
for p in $(pgrep -f '[n]ode bridge.mjs' || true); do
  cwd=$(readlink "/proc/$p/cwd" 2>/dev/null || true)
  if [ "$cwd" = "$D" ]; then
    kill "$p" 2>/dev/null || true
  fi
done
sleep 1
for p in $(pgrep -f '[n]ode bridge.mjs' || true); do
  cwd=$(readlink "/proc/$p/cwd" 2>/dev/null || true)
  if [ "$cwd" = "$D" ]; then
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
  echo "warning: bridge process still present in $D" >&2
  exit 1
fi
echo "stopped"
exit 0
