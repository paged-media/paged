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

# Ask InDesign what applying a condition set does; see condition-sets-probe.jsx.
# Writes condition-sets-probe.json (and InDesign's own IDML of the document
# to the second argument, default a temporary file). Takes the InDesign GUI
# for a few seconds; take the shared lock first:
#
#   until mkdir /tmp/paged-indesign.lock 2>/dev/null; do sleep 15; done
#   bash tools/indesign-export/condition-sets-probe.sh
#   rmdir /tmp/paged-indesign.lock
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/condition-sets-probe.json}"
RESAVE="${2:-$(mktemp -t paged-condition-sets).idml}"
APP="${INDESIGN_APP:-Adobe InDesign 2025}"
SHIM="$(mktemp -t paged-condition-sets-shim).jsx"
trap 'rm -f "$SHIM"' EXIT
cat > "$SHIM" <<JSX
var PROBE_OUT = "$OUT";
var PROBE_RESAVE = "$RESAVE";
\$.evalFile(File("$HERE/condition-sets-probe.jsx"));
JSX
# The raw `do script` event code: see run-export.sh for why.
osascript <<OSA
with timeout of 300 seconds
    tell application "$APP"
        «event K2  dosc» (POSIX file "$SHIM") given «class doLg»:«constant ****JSLg»
    end tell
end timeout
OSA
echo "==> $OUT (InDesign's IDML: $RESAVE)"
