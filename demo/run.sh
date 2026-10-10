#!/usr/bin/env bash
# Run herdr-dash on the fictional demo data (`make demo`). Every command it
# runs is a stand-in from demo/bin, first on PATH, so nothing real is read
# or changed. Usage: demo/run.sh [ADDR] [herdr-dash flags...]
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
addr="${1:-127.0.0.1:8792}"
[ $# -gt 0 ] && shift
# Fresh transcript times: the coordinators look busy right now.
touch "$D"/claude/*/*.jsonl
export PATH="$D/bin:$PATH"
cd "$D"
exec ../bin/herdr-dash --addr "$addr" --root root --herdr-projects herdr-projects \
  --herdr herdr --gh gh --claude-dir claude --codex-dir codex --poll 2s "$@"
