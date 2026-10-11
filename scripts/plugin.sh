#!/bin/sh
# herdr plugin entrypoint: start | stop | status | open | startup
set -eu
root=${HERDR_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}
cfg=${HERDR_PLUGIN_CONFIG_DIR:-$HOME/.config/herdr-dash}
state=${HERDR_PLUGIN_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr-dash}
mkdir -p "$state"
[ -f "$cfg/env" ] && { set -a; . "$cfg/env"; set +a; }
addr=${HERDR_DASH_ADDR:-127.0.0.1:8791}
url="http://$(echo "$addr" | sed 's/^0\.0\.0\.0:/127.0.0.1:/')/"
pidf="$state/herdr-dash.pid"
bin="$root/bin/herdr-dash"
[ -x "$bin" ] || bin=$(command -v herdr-dash || true)

up() { curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null; }

start() {
  if up; then echo "herdr dash already answering at $url"; return 0; fi
  [ -n "$bin" ] || { echo "herdr-dash binary not found; run: go build -o bin/herdr-dash . in $root" >&2; exit 1; }
  # shellcheck disable=SC2086
  nohup "$bin" --addr "$addr" ${HERDR_DASH_ARGS:-} >>"$state/herdr-dash.log" 2>&1 &
  echo $! >"$pidf"
  i=0; while [ $i -lt 20 ]; do up && { echo "herdr dash started at $url"; return 0; }; i=$((i+1)); sleep 0.25; done
  echo "herdr dash started (pid $(cat "$pidf")), not answering yet; log: $state/herdr-dash.log"
}

case "${1:-status}" in
  start) start ;;
  startup) [ -f "$cfg/autostart" ] && start >/dev/null 2>&1 || true ;;
  stop)
    if [ -f "$pidf" ] && kill "$(cat "$pidf")" 2>/dev/null; then rm -f "$pidf"; echo "herdr dash stopped"
    else echo "no herdr dash started by this plugin (a systemd service may run it: systemctl --user stop herdr-dash)"; fi ;;
  status) if up; then echo "herdr dash up at $url"; else echo "herdr dash not running ($url)"; fi ;;
  open)
    up || start
    for o in xdg-open open wslview; do command -v $o >/dev/null 2>&1 && { $o "$url" >/dev/null 2>&1 & exit 0; }; done
    echo "$url" ;;
  *) echo "usage: plugin.sh start|stop|status|open|startup" >&2; exit 2 ;;
esac
