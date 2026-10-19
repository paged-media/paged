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

# Ask InDesign how a reflected item reads back (see flip-probe.jsx):
# rotation, scales and `absoluteFlip` after Flip Vertical / Horizontal /
# both, on unturned and turned items. Writes the answers to
# tools/indesign-export/flip-probe.json. Opens a scratch document with no
# window and closes it unsaved. It takes the shared lock.
#
#   bash tools/indesign-export/flip-probe.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${INDESIGN_APP:-Adobe InDesign 2025}"
LOCK=/tmp/paged-indesign.lock
until mkdir "$LOCK" 2>/dev/null; do sleep 15; done
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
# The raw `do script` event code: see run-export.sh for why.
osascript <<OSA
with timeout of 300 seconds
    tell application "$APP"
        «event K2  dosc» (POSIX file "$HERE/flip-probe.jsx") given «class doLg»:«constant ****JSLg»
    end tell
end timeout
OSA
echo "==> $HERE/flip-probe.json"
