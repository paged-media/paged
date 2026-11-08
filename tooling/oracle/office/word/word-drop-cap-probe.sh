#!/usr/bin/env bash
# Ask Word how it lays out a drop cap (doc ADR 624): builds
# docx_conformance::drop_cap_docx(), has Word save it as PDF (through
# word-pagination-probe.sh, which owns the Office automation traps) and
# measures page 1: each text line's x and top, and the ink box of each cap
# glyph (pdftoppm at 300 dpi; needs python3 with PIL and numpy).
#
#   bash tooling/oracle/office/word/word-drop-cap-probe.sh <out-dir> [existing-word.pdf]
#
# Prints the JSON of fixtures/drop-cap.word.json. With a PDF Word already made
# the Word step is skipped.
set -euo pipefail
ORACLE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$ORACLE/../../../../modules/doc" && pwd)"
OUT="$(mkdir -p "$1" && cd "$1" && pwd)"
cd "$ROOT"
if [ $# -ge 2 ]; then
  cp "$2" "$OUT/drop-cap.pdf"
else
  cargo run -q -p docx-conformance --bin dump-fixture -- "$OUT/drop-cap.docx" drop-cap
  bash "$ORACLE/word-pagination-probe.sh" "$OUT/drop-cap.docx" "$OUT/drop-cap.pdf"
fi
pdftotext -bbox "$OUT/drop-cap.pdf" "$OUT/drop-cap.bbox.html"
pdftoppm -r 300 -png -f 1 -l 1 "$OUT/drop-cap.pdf" "$OUT/drop-cap-300"
python3 - "$OUT/drop-cap.bbox.html" "$OUT"/drop-cap-300*.png <<'PY'
import json, re, sys
import numpy as np
from PIL import Image
words = [(float(a), float(b), float(c), float(d), t) for a, b, c, d, t in re.findall(
    r'xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</word>',
    open(sys.argv[1]).read())]
im = np.array(Image.open(sys.argv[2]).convert("L"))
S = 300 / 72
def ink(x0, y0, x1, y1):
    sub = im[int(y0 * S):int(y1 * S), int(x0 * S):int(x1 * S)] < 128
    ys, xs = np.where(sub.any(1))[0], np.where(sub.any(0))[0]
    return [round(x0 + xs[0] / S, 2), round(y0 + ys[0] / S, 2),
            round(x0 + (xs[-1] + 1) / S, 2), round(y0 + (ys[-1] + 1) / S, 2)]
# A cap is a word taller than a text line (the bbox height is the font size).
lines = {}
caps = []
for x0, y0, x1, y1, t in words:
    if y1 - y0 > 20:
        caps.append({"text": t, "x0": x0, "x1": x1, "size_pt": round(y1 - y0, 2),
                     "ink": ink(x0 - 0.5, y0, x1, y1)})
    else:
        lines.setdefault(round(y0, 1), []).append((x0, t))
rows = [{"top_pt": y, "x0": round(min(w[0] for w in ws), 2),
         "text": " ".join(t for _, t in sorted(ws))[:40]} for y, ws in sorted(lines.items())]
print(json.dumps({
    "fixture": "docx_conformance::drop_cap_docx()",
    "produced_by": "tooling/oracle/office/word/word-drop-cap-probe.sh (Microsoft Word 16, PDF export, macOS)",
    "measured": "2026-11-02",
    "method": "page 1 (US Letter, 72 pt margins): line x and top from pdftotext -bbox; the cap's ink box from a 300 dpi raster. Calibri 11 pt; the fixture's styles omit pPrDefault, and Word lays its own defaults (8 pt after, 1.158 line: pitch 15.52 pt)",
    "caps": caps,
    "lines": rows,
}, indent=1))
PY
