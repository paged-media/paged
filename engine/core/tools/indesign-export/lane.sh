#!/usr/bin/env bash
#
# This file is part of paged (https://paged.media).
#
# paged is free software: you may redistribute it and/or modify it under the
# terms of the GNU Affero General Public License, version 3, as published by
# the Free Software Foundation, OR under the Paged Media Enterprise License
# (PMEL), a commercial license available from And The Next GmbH. Full
# copyright and license information is available in LICENSE.md, distributed
# with this source code.
#
# paged is distributed in the hope that it will be useful, but WITHOUT ANY
# WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
# FOR A PARTICULAR PURPOSE. See the licenses for details.
#
#  @copyright  Copyright (c) And The Next GmbH
#  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
#
# The InDesign round-trip lane: does InDesign read the engine's IDML export
# the way the engine meant it, and does the engine read InDesign's own
# re-save the way InDesign does? Takes the InDesign GUI while it runs.
#
#   bash tools/indesign-export/lane.sh              # every scenario
#   bash tools/indesign-export/lane.sh bleed locks  # these scenarios
#
# 1. The ignored test `indesign_lane::write_lane_inputs` writes each
#    scenario's export (a gen sample, mutated through the canvas model,
#    written by the IDML writer) to <work>/<scenario>/out.idml, with the
#    digest of those bytes.
# 2. lane.jsx opens each in InDesign and records InDesign's view of it
#    (lib/oracle.jsx), saves and reopens it and records again, and exports
#    InDesign's own resaved.idml.
# 3. indesign-view.json, resaved.idml and input.digest are copied into
#    crates/paged-canvas/tests/fixtures/indesign-lane/<scenario>/, where
#    the test `indesign_lane::recordings_agree_with_indesign` (CI, no
#    InDesign) compares the engine's view of both packages with
#    InDesign's. Commit the recording with the change that needed it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/tools/indesign-export"
APP="${INDESIGN_APP:-Adobe InDesign 2025}"
WORK="$(mktemp -d -t paged-indesign-lane)"
SCENARIOS="$(echo "${*:-}" | tr ' ' ',')"

cd "$ROOT"
PAGED_INDESIGN_LANE="$WORK" PAGED_LANE_SCENARIOS="$SCENARIOS" \
    cargo test -q -p paged-canvas --test it -- --ignored indesign_lane::write_lane_inputs
NAMES="$(ls "$WORK" | paste -sd, -)"
[ -n "$NAMES" ] || { echo "no scenario matched: ${*:-}" >&2; exit 2; }

until mkdir /tmp/paged-indesign.lock 2>/dev/null; do sleep 15; done
trap 'rmdir /tmp/paged-indesign.lock' EXIT
SHIM="$WORK/lane-shim.jsx"
cat > "$SHIM" <<JSX
var LANE_DIR = "$WORK";
var LANE_SCENARIOS = "$NAMES";
var LANE_ORACLE = "$HERE/lib/oracle.jsx";
\$.evalFile(File("$HERE/lane.jsx"));
JSX
# The raw `do script` event code: see run-export.sh for why.
osascript <<OSA
with timeout of 1800 seconds
    tell application "$APP"
        «event K2  dosc» (POSIX file "$SHIM") given «class doLg»:«constant ****JSLg»
    end tell
end timeout
OSA

for n in ${NAMES//,/ }; do
    DEST="$ROOT/crates/paged-canvas/tests/fixtures/indesign-lane/$n"
    mkdir -p "$DEST"
    cp "$WORK/$n/indesign-view.json" "$WORK/$n/resaved.idml" "$WORK/$n/input.digest" "$DEST/"
    echo "==> $DEST"
done
