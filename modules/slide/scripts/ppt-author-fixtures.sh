#!/usr/bin/env bash
# Author the feature fixtures IN PowerPoint and record its answers (ADR 705).
#
#   bash scripts/ppt-author-fixtures.sh [name ...]     (default: every script)
#
# Each scripts/fixtures/<name>.applescript builds a deck through PowerPoint's
# own scripting dictionary and saves it, so every fixture is a file
# PowerPoint wrote. Then the deck is recorded like a corpus deck. Outputs
# (licence-clear: we authored them) go to slide-conformance/fixtures/:
#   <name>.pptx, <name>.ppt.pdf, <name>.ppt.json, <name>.provenance.json
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/slide-conformance/fixtures"
STAGE="$HOME/Library/Containers/com.microsoft.Powerpoint/Data/Documents/paged-probe"
mkdir -p "$OUT" "$STAGE"
names=("$@")
if [ ${#names[@]} -eq 0 ]; then
  for f in "$ROOT"/scripts/fixtures/*.applescript; do
    n="$(basename "$f" .applescript)"
    [ "$n" = resave ] || names+=("$n")
  done
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for name in "${names[@]}"; do
  echo "== $name"
  rm -f "$STAGE/$name.pptx"
  osascript "$ROOT/scripts/fixtures/$name.applescript" "$STAGE/$name.pptx" || true
  [ -s "$STAGE/$name.pptx" ] || { echo "PowerPoint wrote no $name.pptx (judge by the artifact)" >&2; exit 1; }
  # What PowerPoint's dictionary cannot author (tables, table styles) a seed
  # script writes into PowerPoint's deck; PowerPoint then re-saves it.
  if [ -f "$ROOT/scripts/fixtures/$name.seed.py" ]; then
    python3 "$ROOT/scripts/fixtures/$name.seed.py" "$STAGE/$name.pptx" "$STAGE/$name.seed.pptx"
    rm -f "$STAGE/$name.pptx"
    osascript "$ROOT/scripts/fixtures/resave.applescript" "$STAGE/$name.seed.pptx" "$STAGE/$name.pptx" || true
    [ -s "$STAGE/$name.pptx" ] || { echo "PowerPoint did not re-save $name" >&2; exit 1; }
  fi
  cp "$STAGE/$name.pptx" "$OUT/$name.pptx"
  bash "$ROOT/scripts/ppt-export-probe.sh" "$OUT/$name.pptx" "$TMP/$name" 48 >/dev/null
  cp "$TMP/$name/$name.pdf" "$OUT/$name.ppt.pdf"
  bash "$ROOT/scripts/ppt-geometry-probe.sh" "$OUT/$name.pptx" > "$OUT/$name.ppt.json"
  python3 - "$OUT" "$name" "$(pdffonts "$OUT/$name.ppt.pdf" | awk 'NR>2 {sub(/^[A-Z]+\+/, "", $1); print $1}' | sort -u | tr '\n' ',')" <<'PY'
import datetime, json, sys
out, name, fonts = sys.argv[1], sys.argv[2], [f for f in sys.argv[3].split(",") if f]
g = json.load(open(f"{out}/{name}.ppt.json"))
json.dump({"oracle": "Microsoft PowerPoint " + g["powerpoint"], "recorded": datetime.date.today().isoformat(),
           "authored_by": f"scripts/fixtures/{name}.applescript", "slides": g["slides"], "fonts_in_pdf": fonts},
          open(f"{out}/{name}.provenance.json", "w"), indent=1)
print(f"   {g['slides']} slides; fonts: {', '.join(fonts)}")
PY
done
