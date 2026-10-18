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

# Ask InDesign where it sets a CJK frame's first baseline; see
# cjk-first-baseline-probe.jsx. Writes cjk-first-baseline.{idml,json} into
# OUT_DIR (default: a fresh temporary directory) and prints, per font and
# composer, the first baseline's distance below the frame's top and the
# ascent InDesign reports, in ems of the 30 pt size. Takes the InDesign GUI
# for a few seconds; it takes the shared lock.
#
#   bash tools/indesign-export/cjk-first-baseline-probe.sh [OUT_DIR]
set -euo pipefail
OUT="${1:-$(mktemp -d -t paged-cjk-first-baseline-probe)}"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
APP="${INDESIGN_APP:-Adobe InDesign 2025}"
JSX="$(cd "$(dirname "$0")" && pwd)/cjk-first-baseline-probe.jsx"
SHIM="$(mktemp -t paged-cjk-first-baseline-shim).jsx"
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
python3 - "$OUT/cjk-first-baseline.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for e in d["errors"]:
    print("error:", e)
for f in d["frames"]:
    print(f"{f['font']:22} {f['style']:8} {f['composer']:20} {f['firstBaseline']:15} "
          f"baseline {f['baseline'] - f['top']:7.3f} pt = {(f['baseline'] - f['top']) / 30:.4f} em, "
          f"ascent {f['ascent'] / 30:.4f} em, descent {f['descent'] / 30:.4f} em  {f.get('fontType', '')} {f.get('error', '')}")
PY
echo "==> $OUT"
