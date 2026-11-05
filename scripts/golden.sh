#!/usr/bin/env bash
# Cross-binary golden suite (internal/projects/golden_test.go): the Rust
# herdr-projects 0.2.35 and the Go read model print the same views on
# generated roots. Finds the Rust binary in HP_RUST_BIN, else the installed
# herdr plugin; skips with a message when there is no 0.2.35 binary.
# HP_RUST_BIN_OLD (optional) adds a version-difference report.
set -euo pipefail
want="0.2.35"
bin="${HP_RUST_BIN:-}"
if [ -z "$bin" ]; then
  for c in "$HOME"/.config/herdr/plugins/*/herdr-projects-*/target/release/herdr-projects; do
    [ -x "$c" ] && bin="$c" && break
  done
fi
if [ -z "$bin" ] || [ ! -x "$bin" ]; then
  echo "golden: SKIPPED: no herdr-projects binary (set HP_RUST_BIN to a $want build)"
  exit 0
fi
version="$("$bin" --version 2>/dev/null || true)"
case "$version" in
  "herdr-projects $want"*) ;;
  *) echo "golden: SKIPPED: $bin is \"$version\", not $want (set HP_RUST_BIN to a $want build)"; exit 0 ;;
esac
echo "golden: $version"
HP_RUST_BIN="$bin" exec go test ./internal/projects/ -run 'TestGolden$' -count=1 -v "$@" | grep -E '^(---|ok|FAIL|PASS)|golden:|differs|line [0-9]|  (rust|go|old|new):'
