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

# Ask InDesign which composers print ruby and kenten; see
# cjk-composer-probe.jsx. Prints, per frame (composer), the ruby text and
# the emphasis marks InDesign's PDF carries above it. Takes the InDesign
# GUI for a few seconds; it takes the shared lock.
#
#   bash tools/indesign-export/cjk-composer-probe.sh [OUT_DIR]
set -euo pipefail
OUT="${1:-$(mktemp -d -t paged-cjk-probe)}"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
APP="${INDESIGN_APP:-Adobe InDesign 2025}"
JSX="$(cd "$(dirname "$0")" && pwd)/cjk-composer-probe.jsx"
SHIM="$(mktemp -t paged-cjk-probe-shim).jsx"
LOCK=/tmp/paged-indesign.lock
until mkdir "$LOCK" 2>/dev/null; do sleep 15; done
trap 'rm -f "$SHIM"; rmdir "$LOCK" 2>/dev/null || true' EXIT
printf 'var PROBE_OUT = "%s";\n$.evalFile(File("%s"));\n' "$OUT" "$JSX" > "$SHIM"
osascript <<OSA
with timeout of 900 seconds
    tell application "$APP"
        «event K2  dosc» (POSIX file "$SHIM") given «class doLg»:«constant ****JSLg»
    end tell
end timeout
OSA
rmdir "$LOCK" 2>/dev/null || true
[ -f "$OUT/cjk-composer.pdf" ] || { cat "$OUT/cjk-composer.error.txt" 2>/dev/null; exit 1; }
echo "==> composers InDesign wrote: $(unzip -p "$OUT/cjk-composer.idml" 'Stories/*.xml' | grep -oE 'Composer="[^"]*"' | tr '\n' ' ')"
echo "==> what each frame prints (y of the line, then its words)"
pdftotext -bbox "$OUT/cjk-composer.pdf" - | grep '<word' \
    | sed -E 's/.*yMin="([0-9.]+)".*>(.*)<\/word>/\1 \2/' | sort -n
echo "    ruby かんじ and the KentenGeneric marks appear only above the frames"
echo "    set with HL Composer J and HL Single J (InDesign 20.0.1)."
echo "==> $OUT"
