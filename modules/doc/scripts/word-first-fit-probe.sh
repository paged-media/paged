#!/usr/bin/env bash
# Ask Word how it breaks lines and how tall a line with a picture is (engine
# ADR 1016, doc ADR 617). Builds docx_conformance::first_fit_docx(), has Word
# save it as PDF (through word-pagination-probe.sh, which owns the Office
# automation traps) and prints the cases with every line Word set: its words
# with their boxes (pt from the page's top-left).
#
#   bash scripts/word-first-fit-probe.sh <out-dir> > docx-conformance/fixtures/first-fit.word.json
#
# The engine's own copy of the answer is
# engine/core/crates/paged-text/tests/fixtures/first-fit.word.json (the same
# file; copy it there when it changes).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mkdir -p "$1" && cd "$1" && pwd)"
cd "$ROOT"
cargo run -q -p docx-conformance --bin dump-fixture -- "$OUT/first-fit.docx" first-fit
cargo run -q -p docx-conformance --bin dump-fixture -- "$OUT/first-fit.cases.json" first-fit-cases
bash scripts/word-pagination-probe.sh "$OUT/first-fit.docx" "$OUT/first-fit.pdf" >&2
FONTS="$(pdffonts "$OUT/first-fit.pdf" | awk 'NR>2 {sub(/^[A-Z]+\+/, "", $1); print $1}' | sort -u | tr '\n' ' ')"
pdftotext -bbox "$OUT/first-fit.pdf" "$OUT/first-fit.bbox.html"
python3 - "$OUT/first-fit.bbox.html" "$OUT/first-fit.cases.json" "$FONTS" <<'PY'
import html as H, json, re, sys
page_html = open(sys.argv[1]).read()
cases = json.load(open(sys.argv[2]))
labels = {c["label"] for c in cases}
paras, cur = [], None
for pno, m in enumerate(re.finditer(r'<page width="[\d.]+" height="[\d.]+">(.*?)</page>', page_html, re.S), 1):
    lines = []
    for x0, y0, x1, y1, t in re.findall(
        r'xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</word>', m.group(1)
    ):
        w = {"t": H.unescape(t), "x0": float(x0), "y0": float(y0), "x1": float(x1), "y1": float(y1)}
        if lines and abs(lines[-1][-1]["y1"] - w["y1"]) < 0.5 and w["x0"] > lines[-1][-1]["x0"]:
            lines[-1].append(w)
        else:
            lines.append([w])
    for ws in lines:
        line = {
            "page": pno,
            "top_pt": min(w["y0"] for w in ws),
            "bottom_pt": max(w["y1"] for w in ws),
            "words": [{"t": w["t"], "x0": round(w["x0"], 2), "x1": round(w["x1"], 2)} for w in ws],
        }
        line["top_pt"], line["bottom_pt"] = round(line["top_pt"], 2), round(line["bottom_pt"], 2)
        first = ws[0]["t"]
        # A paragraph starts with its label, its label + "a" (the picture
        # cases) or, for L02, its label glued to the long word.
        label = next((l for l in labels if first in (l, l + "a") or (l == "L02" and first.startswith(l))), None)
        if label is not None:
            cur = {"label": label, "lines": []}
            paras.append(cur)
        cur["lines"].append(line)
by_label = {p["label"]: p["lines"] for p in paras}
for c in cases:
    c["word_lines"] = by_label.get(c["label"])
print(json.dumps({
    "fixture": "docx_conformance::first_fit_docx()",
    "produced_by": "scripts/word-first-fit-probe.sh (Microsoft Word 16, PDF export, macOS)",
    "fonts_in_pdf": sys.argv[3].strip(),
    "char_pt": 1229 / 2048 * 10,
    "method": "pdftotext -bbox: words grouped into lines by baseline; a paragraph's lines run from the line starting with its label to the next label. word_lines is null where a label was not found.",
    "cases": cases,
}, indent=1, ensure_ascii=False))
PY
