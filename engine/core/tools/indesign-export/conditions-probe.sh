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

# Ask InDesign which conditional text it shows; see conditions-probe.jsx.
# Writes <stem>.conditions.json beside the IDML (or to the second argument).
# Takes the InDesign GUI for a few seconds; take the shared lock first:
#
#   until mkdir /tmp/paged-indesign.lock 2>/dev/null; do sleep 15; done
#   bash tools/indesign-export/conditions-probe.sh corpus/generated/conditions.idml
#   rmdir /tmp/paged-indesign.lock
#
# PROBE_TOGGLE=true flips every condition's visibility and back after the
# open and reports again; PROBE_EXPORT_IDML=<path> / PROBE_EXPORT_PDF=<path>
# write InDesign's own IDML / PDF of the final state.
set -euo pipefail
IDML="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
OUT="${2:-${IDML%.idml}.conditions.json}"
APP="${INDESIGN_APP:-Adobe InDesign 2025}"
JSX="$(cd "$(dirname "$0")" && pwd)/conditions-probe.jsx"
SHIM="$(mktemp -t paged-conditions-probe-shim).jsx"
trap 'rm -f "$SHIM"' EXIT
cat > "$SHIM" <<JSX
var PROBE_IDML = "$IDML";
var PROBE_OUT = "$OUT";
var PROBE_TOGGLE = "${PROBE_TOGGLE:-false}";
var PROBE_EXPORT_IDML = "${PROBE_EXPORT_IDML:-}";
var PROBE_EXPORT_PDF = "${PROBE_EXPORT_PDF:-}";
\$.evalFile(File("$JSX"));
JSX
# The raw `do script` event code: see run-export.sh for why.
osascript <<OSA
with timeout of 900 seconds
    tell application "$APP"
        «event K2  dosc» (POSIX file "$SHIM") given «class doLg»:«constant ****JSLg»
    end tell
end timeout
OSA
echo "==> $OUT"
