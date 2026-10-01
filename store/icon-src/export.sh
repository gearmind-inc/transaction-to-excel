#!/usr/bin/env bash
# Export the 16/48/128 extension icons and the Chrome Web Store promo tile.
#
# Needs Node.js project dependencies (including @playwright/test), the Chromium
# browser already installed in node_modules/.cache/ms-playwright, and ImageMagick 7.
# Run from the repository root: bash store/icon-src/export.sh
# Temporary render files are removed when the script exits; TMPDIR can direct them elsewhere.
set -euo pipefail

SRC=store/icon-src
ICONS=icons
PROMO=store/promo
TMP="$(mktemp -d "${TMPDIR:-/tmp}/transaction-to-excel-icons.XXXXXXXX")"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$ICONS" "$PROMO"

# Render the SVG document at a high device scale, preserving transparency.
render() {
  local source="$1" width="$2" height="$3" scale="$4" output="$5"
  PLAYWRIGHT_BROWSERS_PATH="$(pwd)/node_modules/.cache/ms-playwright" node --input-type=module - "$source" "$width" "$height" "$scale" "$output" <<'NODE'
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [source, width, height, scale, output] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: Number(width), height: Number(height) },
    deviceScaleFactor: Number(scale),
  });
  await page.goto(pathToFileURL(resolve(source)).href);
  await page.screenshot({ path: output, omitBackground: true });
} finally {
  await browser.close();
}
NODE
}

# Each SVG is rendered at its own viewBox size times an integer device scale, then
# shrunk with -scale (plain box averaging over whole pixel blocks). Shapes drawn on the
# target pixel grid therefore stay sharp instead of being smeared by a resampling filter.
render "$SRC/icon.svg" 128 128 8 "$TMP/icon128-large.png"
magick "$TMP/icon128-large.png" -scale 128x128 -strip -define png:color-type=6 "$ICONS/icon128.png"

render "$SRC/icon.svg" 128 128 6 "$TMP/icon48-large.png"
magick "$TMP/icon48-large.png" -scale 48x48 -strip -define png:color-type=6 "$ICONS/icon48.png"

render "$SRC/icon16.svg" 16 16 16 "$TMP/icon16-large.png"
magick "$TMP/icon16-large.png" -scale 16x16 -strip -define png:color-type=6 "$ICONS/icon16.png"

render "$SRC/promo-small.svg" 440 280 2 "$TMP/promo-large.png"
magick "$TMP/promo-large.png" -scale 440x280 -background "#eaf0fa" -flatten -alpha off -strip "$PROMO/small-440x280.png"

echo "Exported PNG assets:"
for file in "$ICONS/icon16.png" "$ICONS/icon48.png" "$ICONS/icon128.png" "$PROMO/small-440x280.png"; do
  magick identify -format '  %f %wx%h %[channels]\n' "$file"
done
