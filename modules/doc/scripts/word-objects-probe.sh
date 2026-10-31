#!/usr/bin/env bash
# Ask Word how it lays out the W4a documents (doc ADR 614): floating
# pictures, text boxes, a nested table, table borders and alignment, and
# hyphenation in three languages. Writes each fixture, has Word save it as
# PDF (through word-pagination-probe.sh, which owns the Office automation
# traps), and prints per page the pictures Word draws (their box, pt from
# the page's top-left) and the text lines (their box and text): the JSON
# docx-conformance/fixtures/objects-*.word.json records.
#
#   bash scripts/word-objects-probe.sh <out-dir> [fixture …]
#
# A fixture is one of objects-floats, objects-text-boxes,
# objects-nested-tables, objects-table-look, objects-languages (all when
# none is named), or W4b's w4b-scripts, w4b-controls (doc ADRs 614, 620).
# Needs Microsoft Word (macOS) and poppler.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mkdir -p "$1" && cd "$1" && pwd)"
shift
NAMES=("$@")
[ ${#NAMES[@]} -eq 0 ] && NAMES=(objects-floats objects-text-boxes objects-nested-tables objects-table-look objects-languages)
cd "$ROOT"
for n in "${NAMES[@]}"; do
  cargo run -q -p docx-conformance --bin dump-fixture -- "$OUT/$n.docx" "$n"
  bash scripts/word-pagination-probe.sh "$OUT/$n.docx" "$OUT/$n.pdf" >&2
  pdftohtml -xml -zoom 1 -q -nodrm -fontfullname "$OUT/$n.pdf" "$OUT/$n" >/dev/null
  python3 - "$OUT/$n.xml" > "$OUT/$n.word.json" <<'PY'
import json, re, sys
xml = open(sys.argv[1], encoding="utf-8", errors="replace").read()
pages = []
for attrs, body in re.findall(r'<page ([^>]*)>(.*?)</page>', xml, re.S):
    num = lambda k, a: float(re.search(k + r'="([-\d.]+)"', a).group(1))
    # pdftohtml's units are the PDF's at 72 dpi: points.
    images = [
        {"top": num("top", a), "left": num("left", a),
         "width": num("width", a), "height": num("height", a)}
        for a in re.findall(r'<image ([^>]*)/?>', body)
    ]
    lines = []
    for a, t in re.findall(r'<text ([^>]*)>(.*?)</text>', body, re.S):
        text = re.sub(r'<[^>]+>', '', t)
        text = (text.replace('&amp;', '&').replace('&lt;', '<')
                .replace('&gt;', '>').replace('&quot;', '"').replace('&#39;', "'"))
        lines.append({"top": num("top", a), "left": num("left", a),
                      "width": num("width", a), "height": num("height", a),
                      "text": text})
    lines.sort(key=lambda l: (round(l["top"]), l["left"]))
    pages.append({"width": num("width", attrs), "height": num("height", attrs),
                  "images": images, "lines": lines})
print(json.dumps({"pages": pages}, indent=1, ensure_ascii=False))
PY
  echo "==> $OUT/$n.word.json" >&2
done
