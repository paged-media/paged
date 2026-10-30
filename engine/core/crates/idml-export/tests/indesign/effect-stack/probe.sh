#!/usr/bin/env bash
# Ask InDesign 2025 what it makes of an effect stack the engine wrote
# (engine ADR 1008). Takes the InDesign GUI for a few seconds.
#
#   bash crates/idml-export/tests/indesign/effect-stack/probe.sh <scratch dir>
#
# 1. base.jsx makes base.idml in InDesign: a rectangle with a drop shadow,
#    an inner glow and a satin;
# 2. the ignored `indesign_effect_stack::write_probe` test gives it a
#    custom stack through the model (satin first, the inner glow switched
#    off, a Gaussian blur and an outline stroke added) and writes out.idml
#    with this crate's writer;
# 3. verify.jsx opens out.idml, saves it as .indd, reopens, and records
#    what InDesign applies and what the item's label holds in verify.json
#    (+ out-resaved.idml, InDesign's own export).
# Copy verify.json and out-resaved.idml over
# tests/fixtures/indesign-2025-effect-stack/ to re-record.
set -euo pipefail
OUT="$(mkdir -p "$1" && cd "$1" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${INDESIGN_APP:-Adobe InDesign 2025}"
run_jsx () {
    local shim
    shim="$(mktemp -t paged-effect-stack-probe).jsx"
    printf 'var PAGED_OUT_DIR = "%s";\n$.evalFile(File("%s"));\n' "$OUT" "$1" > "$shim"
    # `do script` by its raw event code (compiles without InDesign's
    # dynamic terminology; see core tools/indesign-export/run-export.sh).
    osascript <<OSA
with timeout of 300 seconds
    tell application "$APP"
        «event K2  dosc» (POSIX file "$shim") given «class doLg»:«constant ****JSLg»
    end tell
end timeout
OSA
    rm -f "$shim"
}
run_jsx "$HERE/base.jsx"
PAGED_INDESIGN_PROBE="$OUT" cargo test -p idml-export --test it -- --ignored --nocapture indesign_effect_stack::
run_jsx "$HERE/verify.jsx"
echo "==> $OUT/verify.json"
