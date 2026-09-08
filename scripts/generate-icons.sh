#!/usr/bin/env bash
# Render the homescreen/PWA icons from the site's favicon - no dependencies
# beyond macOS's qlmanage (Quick Look renders SVG). Run after changing
# src/lib/assets/favicon.svg:
#
#   scripts/generate-icons.sh [background-color]
#
# Writes static/icon-192.png, static/icon-512.png, static/apple-touch-icon.png
# (180): full-bleed squares (iOS masks its own corners) with the favicon glyph
# on a solid background at ~62% of the canvas. The favicon's prefers-color-scheme
# rules don't apply in a rasterizer, so its LIGHT colors are what you get -
# pick the background to match.
set -euo pipefail
cd "$(dirname "$0")/.."
BG="${1:-#ffffff}"
FAVICON=src/lib/assets/favicon.svg
[ -f "$FAVICON" ] || { echo "no $FAVICON" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# Nest the favicon (any viewBox) into a square canvas via <svg> inside <svg>;
# the inner element scales to the 62% box and centers itself.
inner="$(sed -e 's/<?xml[^>]*>//' "$FAVICON")"
cat > "$tmp/icon.svg" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="$BG"/>
  <svg x="97" y="97" width="318" height="318">$inner</svg>
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
