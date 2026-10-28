#!/usr/bin/env bash
# Ask Word how it lays out structure_docx() (doc ADRs 611 / 612): which
# header and footer each page shows, where the footnotes stand, what the
# fields print and where the endnote goes. Writes the fixture, has Word save
# it as PDF (through word-pagination-probe.sh, which owns the Office
# automation traps) and prints per page the text Word draws in the header
# band (above the 54 pt top margin), the body and the footer band (below
# the bottom margin): the JSON docx-conformance/fixtures/structure.word.json
# records.
#
#   bash scripts/word-structure-probe.sh <out-dir>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mkdir -p "$1" && cd "$1" && pwd)"
cd "$ROOT"
cargo run -q -p docx-conformance --bin dump-fixture -- "$OUT/structure.docx" structure
bash scripts/word-pagination-probe.sh "$OUT/structure.docx" "$OUT/structure.pdf" >&2
pdftotext -bbox "$OUT/structure.pdf" "$OUT/structure.bbox.html"
python3 - "$OUT" <<'PY'
import json, re, sys
out = sys.argv[1]
html = open(f"{out}/structure.bbox.html").read()
pages = []
for page in re.findall(r'<page[^>]*>(.*?)</page>', html, re.S):
    bands = {"header": [], "body": [], "footer": []}
    for x0, y0, t in re.findall(
        r'xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="[\d.]+">([^<]*)</word>', page
    ):
        y = float(y0)
        band = "header" if y < 54 else "footer" if y > 288 - 54 else "body"
        bands[band].append((round(y, 1), float(x0), t))
    pages.append({k: " ".join(t for _, _, t in sorted(v)) for k, v in bands.items()})
print(json.dumps({"pages": pages}, indent=1, ensure_ascii=False))
PY
