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

# Ask InDesign how big, and where, it sets ruby and emphasis marks; see
# ruby-kenten-probe.jsx. Writes ruby-kenten.{idml,pdf,json} into OUT_DIR
# (default: a fresh temporary directory) and prints every text run of the
# PDF (font, size, origin) beside the characters' insertion points. Takes
# the InDesign GUI for a few seconds; it takes the shared lock.
#
#   bash tools/indesign-export/ruby-kenten-probe.sh [OUT_DIR]
set -euo pipefail
OUT="${1:-$(mktemp -d -t paged-ruby-kenten-probe)}"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
APP="${INDESIGN_APP:-Adobe InDesign 2025}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SHIM="$(mktemp -t paged-ruby-kenten-shim).jsx"
LOCK=/tmp/paged-indesign.lock
until mkdir "$LOCK" 2>/dev/null; do sleep 15; done
trap 'rm -f "$SHIM"; rmdir "$LOCK" 2>/dev/null || true' EXIT
printf 'var PROBE_OUT = "%s";\n$.evalFile(File("%s"));\n' "$OUT" "$HERE/ruby-kenten-probe.jsx" > "$SHIM"
osascript <<OSA
with timeout of 900 seconds
    tell application "$APP"
        «event K2  dosc» (POSIX file "$SHIM") given «class doLg»:«constant ****JSLg»
    end tell
end timeout
OSA
rmdir "$LOCK" 2>/dev/null || true
python3 -c 'import json,sys; [print("error:", e) for e in json.load(open(sys.argv[1]))["errors"]]' "$OUT/ruby-kenten.json"
echo "==> the PDF's text runs (font, size, origin; y down from the page top)"
python3 "$HERE/pdf-text.py" "$OUT/ruby-kenten.pdf"
echo "==> $OUT"
