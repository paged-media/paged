#!/usr/bin/env bash
# Record PowerPoint's answers for every corpus deck (ADR 705).
#
#   bash scripts/ppt-record-corpus.sh [corpus-root]
#
# The corpus decks are third-party files, so their recordings live with them
# in the PRIVATE corpus repository, never here:
#   <corpus>/pptx/packs/<pack>/oracle/primary.ppt.pdf    PowerPoint's PDF
#   <corpus>/pptx/packs/<pack>/oracle/primary.ppt.json   per-shape geometry
#   <corpus>/pptx/packs/<pack>/oracle/provenance.json    PowerPoint version, fonts in the PDF, date
# Tests rasterise the PDF themselves (pdftoppm), so no PNGs are stored.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORPUS="${1:-${PAGED_CORPUS:-$ROOT/../../corpus}}"
CORPUS="$(cd "$CORPUS" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for deck in "$CORPUS"/pptx/packs/*/primary.pptx; do
  pack="$(basename "$(dirname "$deck")")"
  out="$(dirname "$deck")/oracle"
  mkdir -p "$out"
  echo "== $pack"
  bash "$ROOT/scripts/ppt-export-probe.sh" "$deck" "$TMP/$pack" 48 >/dev/null
  cp "$TMP/$pack/primary.pdf" "$out/primary.ppt.pdf"
  bash "$ROOT/scripts/ppt-geometry-probe.sh" "$deck" > "$out/primary.ppt.json"
  python3 - "$out" "$(pdffonts "$out/primary.ppt.pdf" | awk 'NR>2 {sub(/^[A-Z]+\+/, "", $1); print $1}' | sort -u | tr '\n' ',')" <<'PY'
import datetime, json, sys
out, fonts = sys.argv[1], [f for f in sys.argv[2].split(",") if f]
g = json.load(open(f"{out}/primary.ppt.json"))
json.dump({
    "oracle": "Microsoft PowerPoint " + g["powerpoint"],
    "recorded": datetime.date.today().isoformat(),
    "slides": g["slides"],
    "fonts_in_pdf": fonts,
    "by": "plugin-slide/scripts/ppt-record-corpus.sh",
}, open(f"{out}/provenance.json", "w"), indent=1)
PY
  echo "   $(python3 -c "import json;d=json.load(open('$out/provenance.json'));print(d['slides'],'slides; fonts:',', '.join(d['fonts_in_pdf']))")"
done
