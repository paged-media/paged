#!/usr/bin/env bash
# Ask PowerPoint where every top-level shape of every slide is (ADR 705):
# position, size and rotation in points, shape type, and for text frames the
# autofit mode, word wrap and the first run's EFFECTIVE font size (after
# PowerPoint's own shrink-on-overflow). Prints JSON on stdout.
#
#   bash scripts/ppt-geometry-probe.sh <in.pptx> > deck.ppt.json
#
# Same automation rules as ppt-export-probe.sh: stage in PowerPoint's own
# container, address the presentation by name, never trust a return value
# without the artifact (here: the slide count must match the deck).
set -euo pipefail
IN="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
STAGE="$HOME/Library/Containers/com.microsoft.Powerpoint/Data/Documents/paged-probe"
mkdir -p "$STAGE"
NAME="$(basename "$IN")"
cp "$IN" "$STAGE/$NAME"
TSV="$(mktemp "$STAGE/geom.XXXXXX")"
# AppleScript traps met writing this: inside `tell PowerPoint`, `tab` and
# `out` are PowerPoint constants (assigning to them fails with -10003), and
# `repeat with sh in shapes` yields references that fail property reads —
# index the shapes instead.
osascript <<OSA >"$TSV"
set T to ASCII character 9
set NL to ASCII character 10
with timeout of 1800 seconds
tell application "Microsoft PowerPoint"
  open POSIX file "$STAGE/$NAME"
  delay 2
  set p to presentation "$NAME"
  set acc to "deck" & T & (count of slides of p) & T & (version as string) & NL
  repeat with si from 1 to count of slides of p
    set s to slide si of p
    repeat with i from 1 to count of shapes of s
      set sh to shape i of s
      set ln to "shape" & T & si & T & i & T & (name of sh) & T & (left position of sh as string) & T & (top of sh as string) & T & (width of sh as string) & T & (height of sh as string) & T & (rotation of sh as string) & T & (shape type of sh as string)
      try
        if has text frame of sh then
          set tf to text frame of sh
          set ln to ln & T & (auto size of tf as string) & T & (word wrap of tf as string)
          try
            set ln to ln & T & (font size of font of text range of tf as string) & T & (count of paragraphs of text range of tf)
          end try
        end if
      end try
      set acc to acc & ln & NL
    end repeat
  end repeat
  close p saving no
  return acc
end tell
end timeout
OSA
python3 - "$TSV" "$NAME" <<'PY'
import json, sys
num = lambda s: round(float(s.replace(",", ".")), 3)
deck, slides = None, {}
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    f = line.rstrip("\n").split("\t")
    if f[0] == "deck":
        deck = {"slides": int(f[1]), "powerpoint": f[2]}
    elif f[0] == "shape":
        sh = {"index": int(f[2]), "name": f[3], "left": num(f[4]), "top": num(f[5]),
              "width": num(f[6]), "height": num(f[7]), "rotation": num(f[8]), "type": f[9].replace("shape type ", "")}
        if len(f) > 11:
            sh["autosize"] = f[10]
            sh["word_wrap"] = f[11]
        if len(f) > 13:
            sh["first_run_size_pt"] = num(f[12])
            sh["paragraphs"] = int(f[13])
        slides.setdefault(int(f[1]), []).append(sh)
if deck is None:
    sys.exit("PowerPoint returned nothing (judge by the artifact)")
if deck["slides"] != len(slides) and len(slides) < deck["slides"]:
    print(f"warning: {deck['slides']} slides, {len(slides)} with shapes", file=sys.stderr)
deck["file"] = sys.argv[2]
deck["shapes"] = {str(k): v for k, v in sorted(slides.items())}
print(json.dumps(deck, indent=1, ensure_ascii=False))
PY
rm -f "$TSV"
