#!/usr/bin/env bash
# Ask PowerPoint how it renders a deck (ADR 705): open it in Microsoft
# PowerPoint and save it as PDF. Per-slide PNGs are rasterised from that PDF
# (pdftoppm, fixed DPI) so the oracle images do not depend on PowerPoint's
# export-resolution preference.
#
#   bash scripts/ppt-export-probe.sh <in.pptx> <out-dir> [dpi]
#
# Writes <out-dir>/<name>.pdf and <out-dir>/<name>-NN.png.
#
# Office automation traps (shared with the Word probes): PowerPoint can only
# be relied on to read and write inside its OWN sandbox container, so the deck
# is staged there; the presentation is addressed BY NAME (never "active
# presentation"); quit gracefully; judge success by the PDF, never by
# AppleScript's return value.
set -euo pipefail
IN="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
OUT="$(mkdir -p "$2" && cd "$2" && pwd)"
DPI="${3:-96}"
STAGE="$HOME/Library/Containers/com.microsoft.Powerpoint/Data/Documents/paged-probe"
mkdir -p "$STAGE"
NAME="$(basename "$IN")"
STEM="${NAME%.pptx}"
cp "$IN" "$STAGE/$NAME"
PDF="$STAGE/$STEM.pdf"
rm -f "$PDF"
osascript <<OSA || true
with timeout of 900 seconds
    tell application "Microsoft PowerPoint"
        activate
        delay 2
        open POSIX file "$STAGE/$NAME"
        delay 3
        set p to presentation "$NAME"
        save p in POSIX file "$PDF" as save as PDF
        close p saving no
    end tell
end timeout
OSA
prev=-1
for _ in $(seq 1 120); do
  size=$(stat -f %z "$PDF" 2>/dev/null || echo 0)
  [ "$size" -gt 0 ] && [ "$size" = "$prev" ] && break
  prev=$size; sleep 2
done
pdfinfo "$PDF" >/dev/null 2>&1 || { echo "PowerPoint produced no PDF (judge by the artifact)" >&2; exit 1; }
cp "$PDF" "$OUT/$STEM.pdf"
rm -f "$OUT/$STEM"-*.png
pdftoppm -r "$DPI" -png "$OUT/$STEM.pdf" "$OUT/$STEM"
echo "==> $OUT/$STEM.pdf ($(pdfinfo "$OUT/$STEM.pdf" | awk '/^Pages:/ {print $2}') pages, $(ls "$OUT/$STEM"-*.png | wc -l | tr -d ' ') PNGs at ${DPI} dpi)"
