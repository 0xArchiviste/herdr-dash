#!/usr/bin/env bash
# Retake the README screenshots from the demo (`make screenshots`): PNGs and
# an animated hero.webp in docs/screenshots/. ffmpeg, if installed, shrinks
# the PNGs to 256-color palettes and encodes the WebP.
set -euo pipefail
cd "$(dirname "$0")/.."
out=docs/screenshots
addr=127.0.0.1:${DEMO_SHOTS_PORT:-8793}
demo/run.sh "$addr" >/dev/null 2>&1 &
pid=$!
trap 'kill $pid' EXIT
until curl -fs "http://$addr/api/state" >/dev/null; do sleep 0.2; done
node e2e/demo-shots.mjs "http://$addr" "$out"
command -v ffmpeg >/dev/null || { echo "no ffmpeg: PNGs left as is, no hero.webp"; exit 0; }
for f in "$out"/*.png; do
  ffmpeg -loglevel error -y -i "$f" -vf "split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none" "$f.tmp.png"
  mv "$f.tmp.png" "$f"
done
# Skip the layout settling at the start; 12 fps, 960 px wide.
ffmpeg -loglevel error -y -ss 5.5 -i "$out/hero.webm" -vf "fps=12,scale=960:-1:flags=lanczos" \
  -c:v libwebp_anim -lossless 0 -q:v 70 -compression_level 6 -loop 0 "$out/hero.webp"
rm -f "$out/hero.webm"
ls -l "$out"
