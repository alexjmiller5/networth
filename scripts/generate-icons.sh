#!/usr/bin/env bash
# Render the homescreen/PWA icons from the site's favicon - no dependencies
# beyond macOS's qlmanage (Quick Look renders SVG). Run after changing
# src/lib/assets/favicon.svg:
#
#   scripts/generate-icons.sh [background-color] [glyph-scale]
#
# Writes static/icon-192.png, static/icon-512.png, static/apple-touch-icon.png
# (180): full-bleed squares (iOS masks its own corners) with the favicon on a
# solid background, scaled to `glyph-scale` of the canvas (default 0.62, for a
# bare glyph that needs breathing room). A favicon that is already a square
# tile wants `1` plus the tile's own color as the background, so the corners
# the tile rounds off blend instead of showing a white sliver.
#
# qlmanage rasterizes in DARK appearance, so a favicon whose colors flip under
# `prefers-color-scheme: dark` renders its dark-mode palette here - usually
# invisible against a light background. Keep the favicon's colors unconditional.
set -euo pipefail
cd "$(dirname "$0")/.."
BG="${1:-#ffffff}"
SCALE="${2:-0.62}"
FAVICON=src/lib/assets/favicon.svg
[ -f "$FAVICON" ] || { echo "no $FAVICON" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# Nest the favicon (any viewBox) into a square canvas via <svg> inside <svg>;
# the inner element scales to the box and centers itself.
box=$(awk -v s="$SCALE" 'BEGIN{printf "%d", 512 * s}')
off=$(awk -v b="$box" 'BEGIN{printf "%d", (512 - b) / 2}')
inner="$(sed -e 's/<?xml[^>]*>//' "$FAVICON")"
cat > "$tmp/icon.svg" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="$BG"/>
  <svg x="$off" y="$off" width="$box" height="$box">$inner</svg>
</svg>
SVG

for size in 512 192 180; do
  qlmanage -t -s "$size" -o "$tmp" "$tmp/icon.svg" >/dev/null 2>&1
  case $size in
    180) out=static/apple-touch-icon.png ;;
    *) out=static/icon-$size.png ;;
  esac
  mv "$tmp/icon.svg.png" "$out"
  echo "wrote $out ($(sips -g pixelWidth "$out" | awk '/pixelWidth/{print $2}')px)"
done
