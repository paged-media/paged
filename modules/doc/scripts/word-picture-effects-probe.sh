#!/usr/bin/env bash
# Ask Word what it makes of the pictures' DrawingML looks (doc ADR 618):
# writes picture_effects_docx() and the edited save the conformance test
# makes (docx-conformance/tests/it/picture_effects.rs), has Word open both
# and save each as PDF (through word-pagination-probe.sh, which owns the
# Office automation traps: a repair prompt shows up as a hang and no PDF),
# and has Word save the fixture again as .docx. Prints, as JSON, per
# picture (by wp:docPr/@id) the a:blip and pic:spPr Word itself wrote: the
# look as Word read it.
#
#   bash scripts/word-picture-effects-probe.sh <out-dir> > docx-conformance/fixtures/picture-effects.word.json
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mkdir -p "$1" && cd "$1" && pwd)"
cd "$ROOT"
cargo run -q -p docx-conformance --bin dump-fixture -- "$OUT/picture-effects.docx" picture-effects
PICTURE_EFFECTS_EDITED_OUT="$OUT/picture-effects-edited.docx" \
  cargo test -q -p docx-conformance --test it picture_effects::pictures_with_a_look_save_back >&2
for f in picture-effects picture-effects-edited; do
  bash scripts/word-pagination-probe.sh "$OUT/$f.docx" "$OUT/$f.pdf" >&2
done
# Word's own save of the fixture, staged in its container like the PDF.
STAGE="$HOME/Library/Containers/com.microsoft.Word/Data/Documents/paged-probe"
NAME="picture-effects.docx"
SAVED="$STAGE/picture-effects-word.docx"
rm -f "$SAVED"
osascript <<OSA || true
with timeout of 300 seconds
    tell application "Microsoft Word"
        activate
        delay 3
        open POSIX file "$STAGE/$NAME"
        delay 2
        set d to document "$NAME"
        save as d file name "$SAVED" file format format document
        close document "picture-effects-word.docx" saving no
    end tell
end timeout
OSA
for i in $(seq 1 60); do [ -s "$SAVED" ] && break; sleep 2; done
[ -s "$SAVED" ] || { echo "Word wrote no .docx (judge by the artifact)" >&2; exit 1; }
cp "$SAVED" "$OUT/picture-effects-word.docx"
WORD_VERSION="$(defaults read "/Applications/Microsoft Word.app/Contents/Info.plist" CFBundleShortVersionString)"
python3 - "$OUT" "$WORD_VERSION" <<'PY'
import json, re, subprocess, sys, zipfile, datetime
out, version = sys.argv[1], sys.argv[2]
xml = zipfile.ZipFile(f"{out}/picture-effects-word.docx").read("word/document.xml").decode()
pictures = {}
for m in re.finditer(r"<wp:(inline|anchor)\b.*?</wp:\1>", xml, re.S):
    d = m.group(0)
    pid = re.search(r'<wp:docPr [^>]*\bid="(\d+)"', d).group(1)
    blip = re.search(r"<a:blip\b.*?(?:/>|</a:blip>)", d, re.S)
    sp = re.search(r"<pic:spPr\b.*?(?:/>|</pic:spPr>)", d, re.S)
    pictures[pid] = {
        "blip": blip.group(0) if blip else None,
        "spPr": sp.group(0) if sp else None,
    }
pages = {}
for f in ("picture-effects", "picture-effects-edited"):
    info = subprocess.run(["pdfinfo", f"{out}/{f}.pdf"], capture_output=True, text=True).stdout
    pages[f] = int(re.search(r"Pages:\s+(\d+)", info).group(1))
json.dump({
    "source": "scripts/word-picture-effects-probe.sh: Microsoft Word opened picture_effects_docx() and the edited save-back of docx-conformance/tests/it/picture_effects.rs and saved each as PDF (neither showed a repair prompt: a prompt hangs the probe and leaves no PDF; `pages` is each PDF's page count), then saved the fixture again as .docx; `pictures` holds, per wp:docPr/@id, the a:blip and pic:spPr Word wrote, namespace prefixes as Word writes them (a:, pic:, r:).",
    "date": datetime.date.today().isoformat(),
    "word": f"Microsoft Word for Mac {version}",
    "pages": pages,
    "pictures": pictures,
}, sys.stdout, indent=1, ensure_ascii=False)
print()
PY
