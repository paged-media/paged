#!/usr/bin/env bash
# Ask Adobe Illustrator what the right answer to ONE path operation is,
# and record it. Illustrator is the oracle for paged.draw's vector ops the
# way InDesign is for IDML and Word is for DOCX.
#
#   bash scripts/illustrator/run-probe.sh <probe.jsx> <out.json>
#
#   bash scripts/illustrator/run-probe.sh \
#     scripts/illustrator/probes/offset-path.jsx \
#     packages/draw-bundle/test/fixtures/oracle/offset-path.illustrator.json
#
# Maintainer-only (macOS + Illustrator). CI never runs this: it replays the
# committed fixture through `packages/draw-bundle/test/oracle/*.spec.ts`.
#
# What it does, in order — each step exists because of a trap, see the
# README beside this file:
#   1. asks macOS (without prompting) whether this shell may control
#      Illustrator at all, and says so in words when it may not;
#   2. brings Illustrator up and PINGS it with a one-line script under a
#      short timeout — an unanswered consent prompt and a modal dialog both
#      look like a silent hang, and a 60 s ping is cheaper than a 10 min one;
#   3. hands Illustrator the probe as TEXT (lib/probe-lib.jsx + the probe,
#      read by AppleScript, not by Illustrator — so no staging directory has
#      to be readable by the app) and captures the JSON string it returns;
#   4. judges the ARTIFACT, never the exit code: the JSON must parse, name
#      the probe, carry cases, carry no `error`, and report as many open
#      documents after as before (the scratch document was closed unsaved);
#   5. pings again — a script that left a modal dialog open would leave
#      Illustrator unable to answer;
#   6. only then writes <out.json>, with provenance: app, version, build,
#      locale, script + its sha256, date, units.
#
# Environment:
#   ILLUSTRATOR_APP            application name (default "Adobe Illustrator")
#   ILLUSTRATOR_BUNDLE_ID      default com.adobe.illustrator
#   PAGED_PROBE_PING_TIMEOUT   seconds to wait for the ping   (default 60)
#   PAGED_PROBE_TIMEOUT        seconds to wait for the probe  (default 600)
#   PAGED_PROBE_STAGE          where the concatenated script and the raw
#                              reply are kept (default: a mktemp dir, removed
#                              on success, KEPT on failure for diagnosis)
#
# Exit codes: 0 recorded · 2 usage · 3 Illustrator did not answer ·
#             4 Illustrator answered with something that is not a recording.
set -euo pipefail

die() {
  local code="$1"
  shift
  printf '\nrun-probe: FAILED — %s\n' "$1" >&2
  shift
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  exit "$code"
}

[ $# -eq 2 ] || die 2 "usage: run-probe.sh <probe.jsx> <out.json>"
[ "$(uname -s)" = "Darwin" ] || die 2 "this drives Adobe Illustrator through osascript; macOS only"
[ -f "$1" ] || die 2 "no such probe: $1"
command -v osascript >/dev/null || die 2 "osascript not found"
command -v node >/dev/null || die 2 "node not found (the reply is validated with it)"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROBE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
mkdir -p "$(dirname "$2")"
OUT="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
LIB="$ROOT/scripts/illustrator/lib/probe-lib.jsx"
[ -f "$LIB" ] || die 2 "missing $LIB"
WRITER="$ROOT/scripts/illustrator/lib/write-fixture.mjs"
[ -f "$WRITER" ] || die 2 "missing $WRITER"

APP="${ILLUSTRATOR_APP:-Adobe Illustrator}"
BUNDLE_ID="${ILLUSTRATOR_BUNDLE_ID:-com.adobe.illustrator}"
PING_TIMEOUT="${PAGED_PROBE_PING_TIMEOUT:-60}"
RUN_TIMEOUT="${PAGED_PROBE_TIMEOUT:-600}"

# ExtendScript sources stay 7-bit: the text crosses AppleScript and an
# Apple event on its way in, and an encoding surprise there would surface
# as a syntax error inside Illustrator with no line to point at. Checked
# BEFORE the app is touched: a probe that cannot be sent should not cost a
# launch.
for f in "$LIB" "$PROBE"; do
  n="$(LC_ALL=C tr -d '\11\12\15\40-\176' <"$f" | wc -c | tr -d ' ')"
  [ "$n" -eq 0 ] ||
    die 2 "$n non-ASCII byte(s) in $f" "Use plain ASCII in ExtendScript sources, comments included."
done

if [ -n "${PAGED_PROBE_STAGE:-}" ]; then
  STAGE="$PAGED_PROBE_STAGE"
  mkdir -p "$STAGE"
  OWN_STAGE=0
else
  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/paged-illustrator-probe.XXXXXX")"
  OWN_STAGE=1
fi
NAME="$(basename "$PROBE" .jsx)"
SRC="$STAGE/$NAME.combined.jsx"
RAW="$STAGE/$NAME.raw.json"
ERR="$STAGE/$NAME.osascript.err"

# --- 0. the script Illustrator will be handed --------------------------------
{
  cat "$LIB"
  printf '\n'
  cat "$PROBE"
} >"$SRC"

# --- 1. may this shell control Illustrator at all? --------------------------
# macOS gates Apple events per (controlling app, target app). The controlling
# app is whatever owns this shell — Terminal, an IDE, an agent host — and a
# grant for InDesign or Word says nothing about Illustrator. The question is
# asked WITHOUT prompting; the answer is an OSStatus:
#      0  allowed          -1744  not decided yet (macOS will prompt)
#  -1743  denied            -600  Illustrator is not running
consent_status() {
  osascript -l JavaScript - "$BUNDLE_ID" 2>/dev/null <<'JXA' || echo unknown
ObjC.import('Foundation');
ObjC.import('CoreServices');
ObjC.bindFunction('AEDeterminePermissionToAutomateTarget',
  ['int', ['void *', 'unsigned int', 'unsigned int', 'bool']]);
function run(argv) {
  var d = $.NSAppleEventDescriptor.descriptorWithBundleIdentifier(argv[0]);
  // typeWildCard ('****') for both event class and id; askUserIfNeeded = false
  return String($.AEDeterminePermissionToAutomateTarget(d.aeDesc, 0x2a2a2a2a, 0x2a2a2a2a, false));
}
JXA
}

CONSENT_HELP=(
  "macOS decides per controlling app whether it may send Apple events to"
  "Illustrator. The controlling app is the one that owns this shell (Terminal,"
  "an IDE, an agent host)."
  "Grant it: answer the system prompt that names Illustrator with \"Allow\","
  "or System Settings > Privacy & Security > Automation > <that app> >"
  "Adobe Illustrator. Then re-run this command."
)

# --- 2. bring Illustrator up and ping it ------------------------------------
echo "run-probe: $NAME -> $OUT"
# `activate` goes through LaunchServices and needs no consent. It also puts
# Illustrator in front: menu commands act on the frontmost document window.
osascript -e "tell application \"$APP\" to activate" >/dev/null 2>"$ERR" ||
  die 3 "could not launch \"$APP\"" "$(cat "$ERR")"

# A freshly launched app can be `activate`d long before it handles events.
for _ in $(seq 1 90); do
  [ "$(consent_status)" != "-600" ] && break
  sleep 2
done

STATUS="$(consent_status)"
case "$STATUS" in
  0) ;;
  -1743) die 3 "macOS has DENIED this shell permission to control Illustrator (-1743)" "${CONSENT_HELP[@]}" ;;
  -1744)
    echo "run-probe: macOS has not yet been asked whether this shell may control"
    echo "           Illustrator (-1744). A system prompt appears NOW and must be"
    echo "           answered with \"Allow\" within ${PING_TIMEOUT}s."
    ;;
  -600) die 3 "\"$APP\" ($BUNDLE_ID) did not come up within 180 s" ;;
  *) echo "run-probe: could not determine the automation consent state ($STATUS); trying anyway" ;;
esac

ping_app() {
  # Prints the reply; fails when Illustrator does not answer in time.
  osascript 2>"$ERR" <<OSA
with timeout of $PING_TIMEOUT seconds
    tell application "$APP"
        do javascript "$1"
    end tell
end timeout
OSA
}

explain_no_answer() {
  local err
  err="$(cat "$ERR" 2>/dev/null || true)"
  case "$err" in
    *-1743*) die 3 "macOS refused the Apple event to Illustrator (-1743, not permitted)" "$err" "${CONSENT_HELP[@]}" ;;
    *-1712*)
      if [ "$(consent_status)" != "0" ]; then
        die 3 "Illustrator did not answer within ${PING_TIMEOUT}s: the macOS consent prompt was not answered (-1712 timeout, consent state $(consent_status))" \
          "$err" "${CONSENT_HELP[@]}"
      fi
      die 3 "Illustrator did not answer within ${PING_TIMEOUT}s although this shell may control it (-1712 timeout)" \
        "$err" \
        "It is most likely showing a MODAL dialog (first-run tour, missing fonts," \
        "crash recovery, a script alert). Dismiss it in the app and re-run." \
        "Do not SIGKILL it: a killed Adobe app comes back with a recovery dialog."
      ;;
    *) die 3 "Illustrator did not answer \"$1\"" "$err" ;;
  esac
}

VERSION="$(ping_app "app.version")" || explain_no_answer "app.version"
[ -n "$VERSION" ] || die 3 "Illustrator answered the version ping with nothing"
DOCS_BEFORE="$(ping_app "String(app.documents.length)")" || explain_no_answer "app.documents.length"
echo "run-probe: Illustrator $VERSION answers; $DOCS_BEFORE document(s) open"

# --- 3. run the probe -------------------------------------------------------
# The library is PREPENDED (above) and the whole text is handed over as a
# string. `do javascript file ...` would make Illustrator open the path
# itself; with text the app never needs to read the staging directory.
rc=0
osascript - "$SRC" >"$RAW" 2>"$ERR" <<OSA || rc=$?
on run argv
    set src to read (POSIX file (item 1 of argv)) as «class utf8»
    with timeout of $RUN_TIMEOUT seconds
        tell application "$APP"
            return do javascript src
        end tell
    end timeout
end run
OSA
if [ "$rc" -ne 0 ]; then
  die 3 "the probe did not return (osascript exit $rc)" "$(cat "$ERR")" \
    "Illustrator may be showing a dialog the probe could not suppress, or the" \
    "script raised before it could return JSON. Staging kept: $STAGE"
fi

# --- 5. is Illustrator still answering, with nothing left open? -------------
DOCS_AFTER="$(ping_app "String(app.documents.length)")" ||
  die 3 "Illustrator stopped answering AFTER the probe — it has very likely left a modal dialog open" \
    "$(cat "$ERR")" "Dismiss it in the app. Staging kept: $STAGE"
[ "$DOCS_AFTER" = "$DOCS_BEFORE" ] ||
  die 4 "the probe left documents open: $DOCS_BEFORE before, $DOCS_AFTER after" \
    "Close the scratch document(s) in Illustrator WITHOUT saving. Staging kept: $STAGE"

# --- 4 + 6. judge the artifact, then write the fixture ----------------------
SHA="$(cat "$SRC" | shasum -a 256 | cut -d' ' -f1)"
node "$WRITER" \
  "$RAW" "$OUT" "$NAME" "${PROBE#"$ROOT"/}" "$SHA" "$(sw_vers -productVersion)" ||
  die 4 "Illustrator's reply was refused; nothing was written to $OUT" \
    "Raw reply kept: $RAW"

[ "$OWN_STAGE" -eq 1 ] && rm -rf "$STAGE"
echo "==> $OUT"
