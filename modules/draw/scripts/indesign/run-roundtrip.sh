#!/usr/bin/env bash
# Ask Adobe InDesign what it SEES in one IDML file that paged.draw
# authored, and record the answer. InDesign is the oracle for the IDML
# round trip the way Illustrator is for draw's path operations
# (scripts/illustrator/).
#
#   bash scripts/indesign/run-roundtrip.sh <in.idml> <out.json>
#
#   bash scripts/indesign/run-roundtrip.sh \
#     packages/draw-bundle/test/fixtures/roundtrip/pen-open.idml \
#     packages/draw-bundle/test/fixtures/roundtrip/pen-open.indesign.json
#
# Maintainer-only (macOS + InDesign). CI never runs this: it replays the
# committed fixture through `packages/draw-bundle/test/roundtrip/*.spec.ts`.
#
# What it does, in order -- each step exists because of a trap, see the
# README beside this file:
#   1. asks macOS (WITHOUT prompting) whether this shell may control
#      InDesign at all, and stops with the answer in words when it may not;
#   2. pings InDesign with a one-line script under a short timeout -- an
#      unanswered consent prompt and a modal dialog both look like a silent
#      hang, and a 60 s ping is cheaper than a 10 min one;
#   3. copies the IDML into a staging directory and hands InDesign the
#      reader as TEXT (lib/read-document.jsx, with the paths prepended as
#      globals), so InDesign reads exactly one file it was given and the
#      reader's own text never has to be readable by the app;
#   4. the reader opens the IDML (no window, NEVER_INTERACT), measures every
#      page item, records unresolved fonts / links and overset stories,
#      exports a PDF of the page and InDesign's OWN IDML export, then closes
#      the document unsaved and returns a JSON string;
#   5. pings again -- a reader that left a modal open would leave InDesign
#      unable to answer;
#   6. reads the STACKING ORDER out of InDesign's own export (the DOM's
#      `pageItems` is grouped by kind, not stacked), judges the ARTIFACT
#      (lib/write-fixture.mjs), never the exit code, and only then writes
#      <out.json> with provenance: app, version, locale, the reader's
#      sha256, the IDML's sha256, date.
#
# Environment:
#   INDESIGN_APP               application name   (default "Adobe InDesign 2025")
#   INDESIGN_BUNDLE_ID         default com.adobe.InDesign
#   PAGED_RT_PDF               where the PDF goes (default: <stage>/<name>.pdf)
#   PAGED_RT_REEXPORT          also KEEP InDesign's own IDML export here (the
#                              re-import fixtures; it is always made)
#   PAGED_PROBE_PING_TIMEOUT   seconds to wait for the ping   (default 60)
#   PAGED_PROBE_TIMEOUT        seconds to wait for the reader (default 600)
#   PAGED_PROBE_STAGE          staging directory (default: a mktemp dir, KEPT,
#                              because it holds the PDF; its path is printed)
#
# Exit codes: 0 recorded · 2 usage · 3 InDesign did not answer ·
#             4 InDesign answered with something that is not a recording.
set -euo pipefail

die() {
  local code="$1"
  shift
  printf '\nrun-roundtrip: FAILED — %s\n' "$1" >&2
  shift
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  exit "$code"
}

[ $# -eq 2 ] || die 2 "usage: run-roundtrip.sh <in.idml> <out.json>"
[ "$(uname -s)" = "Darwin" ] || die 2 "this drives Adobe InDesign through osascript; macOS only"
[ -f "$1" ] || die 2 "no such IDML: $1"
command -v osascript >/dev/null || die 2 "osascript not found"
command -v node >/dev/null || die 2 "node not found (the reply is judged with it)"
command -v unzip >/dev/null || die 2 "unzip not found (the label keys are read with it)"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IN="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
mkdir -p "$(dirname "$2")"
OUT="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
READER="$ROOT/scripts/indesign/lib/read-document.jsx"
WRITER="$ROOT/scripts/indesign/lib/write-fixture.mjs"
[ -f "$READER" ] || die 2 "missing $READER"
[ -f "$WRITER" ] || die 2 "missing $WRITER"

APP="${INDESIGN_APP:-Adobe InDesign 2025}"
BUNDLE_ID="${INDESIGN_BUNDLE_ID:-com.adobe.InDesign}"
PING_TIMEOUT="${PAGED_PROBE_PING_TIMEOUT:-60}"
RUN_TIMEOUT="${PAGED_PROBE_TIMEOUT:-600}"

# ExtendScript sources stay 7-bit: the text crosses AppleScript and an
# Apple event on its way in. Checked BEFORE the app is touched.
n="$(LC_ALL=C tr -d '\11\12\15\40-\176' <"$READER" | wc -c | tr -d ' ')"
[ "$n" -eq 0 ] ||
  die 2 "$n non-ASCII byte(s) in $READER" "Use plain ASCII in ExtendScript sources, comments included."

if [ -n "${PAGED_PROBE_STAGE:-}" ]; then
  STAGE="$PAGED_PROBE_STAGE"
  mkdir -p "$STAGE"
else
  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/paged-indesign-roundtrip.XXXXXX")"
fi
NAME="$(basename "$IN" .idml)"
IDML="$STAGE/$NAME.idml"
SRC="$STAGE/$NAME.combined.jsx"
RAW="$STAGE/$NAME.raw.json"
ERR="$STAGE/$NAME.osascript.err"
PDF="${PAGED_RT_PDF:-$STAGE/$NAME.pdf}"
EXPORT="$STAGE/$NAME.indesign-export.idml"
ZORDER="$STAGE/$NAME.zorder.xml"
REEXPORT="${PAGED_RT_REEXPORT:-}"
if [ -n "$REEXPORT" ]; then
  mkdir -p "$(dirname "$REEXPORT")"
  REEXPORT="$(cd "$(dirname "$REEXPORT")" && pwd)/$(basename "$REEXPORT")"
fi
case "$IDML$PDF$EXPORT" in
  *\"* | *\\*) die 2 "paths may not contain a double quote or a backslash" ;;
esac
cp "$IN" "$IDML"
rm -f "$PDF" "$EXPORT" "$ZORDER"

# InDesign can answer a KEYED label (`extractLabel(key)`) but cannot list
# the keys an item carries, so the keys are read from the file itself.
# (`grep` finding no key is the common case, not a failure.)
KEYS_JSON="$({ unzip -p "$IDML" 'Spreads/*.xml' 2>/dev/null || true; } |
  { grep -o 'KeyValuePair Key="[^"]*"' || true; } | sed 's/^KeyValuePair Key="//; s/"$//' | sort -u |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.split("\n").filter(Boolean))))')"

# --- 0. the script InDesign will be handed ---------------------------------
{
  printf 'var PAGED_RT_IDML = "%s";\n' "$IDML"
  printf 'var PAGED_RT_PDF = "%s";\n' "$PDF"
  printf 'var PAGED_RT_EXPORT = "%s";\n' "$EXPORT"
  printf 'var PAGED_RT_LABEL_KEYS = %s;\n' "$KEYS_JSON"
  cat "$READER"
} >"$SRC"

# --- 1. may this shell control InDesign at all? -----------------------------
# macOS gates Apple events per (controlling app, target app). Asked WITHOUT
# prompting; the answer is an OSStatus:
#      0  allowed          -1744  not decided yet (macOS would prompt)
#  -1743  denied            -600  InDesign is not running
consent_status() {
  osascript -l JavaScript - "$BUNDLE_ID" 2>/dev/null <<'JXA' || echo unknown
ObjC.import('Foundation');
ObjC.import('CoreServices');
ObjC.bindFunction('AEDeterminePermissionToAutomateTarget',
  ['int', ['void *', 'unsigned int', 'unsigned int', 'bool']]);
function run(argv) {
  var d = $.NSAppleEventDescriptor.descriptorWithBundleIdentifier(argv[0]);
  return String($.AEDeterminePermissionToAutomateTarget(d.aeDesc, 0x2a2a2a2a, 0x2a2a2a2a, false));
}
JXA
}

CONSENT_HELP=(
  "macOS decides per controlling app whether it may send Apple events to"
  "InDesign. The controlling app is the one that owns this shell (Terminal,"
  "an IDE, an agent host). Grant it: answer the system prompt that names"
  "InDesign with \"Allow\", or System Settings > Privacy & Security >"
  "Automation > <that app> > $APP. Then re-run this command."
)

echo "run-roundtrip: $NAME -> $OUT"
# `open -g` is LaunchServices (no consent needed) and does not steal focus.
if [ "$(consent_status)" = "-600" ]; then
  open -g -b "$BUNDLE_ID" 2>"$ERR" || die 3 "could not launch $APP" "$(cat "$ERR")"
  for _ in $(seq 1 90); do
    [ "$(consent_status)" != "-600" ] && break
    sleep 2
  done
fi
STATUS="$(consent_status)"
case "$STATUS" in
  0) ;;
  -1743) die 3 "macOS has DENIED this shell permission to control InDesign (-1743)" "${CONSENT_HELP[@]}" ;;
  -1744)
    echo "run-roundtrip: macOS has not yet been asked whether this shell may control"
    echo "               InDesign (-1744). A system prompt appears NOW and must be"
    echo "               answered with \"Allow\" within ${PING_TIMEOUT}s."
    ;;
  -600) die 3 "$APP ($BUNDLE_ID) did not come up within 180 s" ;;
  *) die 3 "could not determine the automation consent state ($STATUS)" "${CONSENT_HELP[@]}" ;;
esac

# `do script` is spelled by its raw event code: InDesign's terminology is
# DYNAMIC, and where AppleScript cannot fetch it while compiling (a
# sandboxed shell) `do script ... language javascript` does not compile
# although `get version` answers. The raw form needs no terminology (core
# tools/indesign-export/run-export.sh measured this).
ping_app() {
  osascript 2>"$ERR" <<OSA
with timeout of $PING_TIMEOUT seconds
    tell application "$APP"
        «event K2  dosc» "$1" given «class doLg»:«constant ****JSLg»
    end tell
end timeout
OSA
}

explain_no_answer() {
  local err
  err="$(cat "$ERR" 2>/dev/null || true)"
  case "$err" in
    *-1743*) die 3 "macOS refused the Apple event to InDesign (-1743, not permitted)" "$err" "${CONSENT_HELP[@]}" ;;
    *-1712*) die 3 "InDesign did not answer within ${PING_TIMEOUT}s (-1712 timeout)" "$err" \
      "It is most likely showing a MODAL dialog (first-run screen, missing fonts," \
      "crash recovery, a script alert). Dismiss it in the app and re-run." \
      "Do not SIGKILL it: a killed Adobe app comes back with a recovery dialog." ;;
    *) die 3 "InDesign did not answer \"$1\"" "$err" ;;
  esac
}

VERSION="$(ping_app "app.version")" || explain_no_answer "app.version"
[ -n "$VERSION" ] || die 3 "InDesign answered the version ping with nothing"
DOCS_BEFORE="$(ping_app "String(app.documents.length)")" || explain_no_answer "app.documents.length"
echo "run-roundtrip: InDesign $VERSION answers; $DOCS_BEFORE document(s) open"

# --- 3/4. run the reader ----------------------------------------------------
rc=0
osascript - "$SRC" >"$RAW" 2>"$ERR" <<OSA || rc=$?
on run argv
    set src to read (POSIX file (item 1 of argv)) as «class utf8»
    with timeout of $RUN_TIMEOUT seconds
        tell application "$APP"
            return «event K2  dosc» src given «class doLg»:«constant ****JSLg»
        end tell
    end timeout
end run
OSA
if [ "$rc" -ne 0 ]; then
  die 3 "the reader did not return (osascript exit $rc)" "$(cat "$ERR")" \
    "InDesign may be showing a dialog the reader could not suppress, or the" \
    "script raised before it could return JSON. Staging kept: $STAGE"
fi

# --- 5. still answering, with nothing left open? ----------------------------
DOCS_AFTER="$(ping_app "String(app.documents.length)")" ||
  die 3 "InDesign stopped answering AFTER the reader — it has very likely left a modal dialog open" \
    "$(cat "$ERR")" "Dismiss it in the app. Staging kept: $STAGE"
[ "$DOCS_AFTER" = "$DOCS_BEFORE" ] ||
  die 4 "the reader left documents open: $DOCS_BEFORE before, $DOCS_AFTER after" \
    "Close the document(s) in InDesign WITHOUT saving. Staging kept: $STAGE"

# --- 6. the stacking order, then judge the artifact and write the fixture ---
[ -s "$EXPORT" ] || die 4 "InDesign wrote no IDML export to $EXPORT" "Staging kept: $STAGE"
unzip -p "$EXPORT" 'Spreads/*.xml' >"$ZORDER" 2>"$ERR" ||
  die 4 "InDesign's own IDML export has no readable spread" "$(cat "$ERR")" "Staging kept: $STAGE"
SHA="$(shasum -a 256 <"$READER" | cut -d' ' -f1)"
IDML_SHA="$(shasum -a 256 <"$IN" | cut -d' ' -f1)"
node "$WRITER" \
  "$RAW" "$OUT" "$NAME" "${READER#"$ROOT"/}" "$SHA" "${IN#"$ROOT"/}" "$IDML_SHA" \
  "$(sw_vers -productVersion)" "$PDF" "$ZORDER" ||
  die 4 "InDesign's reply was refused; nothing was written to $OUT" "Raw reply kept: $RAW"
[ -z "$REEXPORT" ] || cp "$EXPORT" "$REEXPORT"

echo "run-roundtrip: PDF for the visual check: $PDF"
[ -z "$REEXPORT" ] || echo "run-roundtrip: InDesign's own IDML export: $REEXPORT"
echo "==> $OUT"
