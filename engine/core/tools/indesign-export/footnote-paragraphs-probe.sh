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

# Ask InDesign how a footnote's paragraph settings lay its lines out; see
# footnote-paragraphs-probe.jsx. Writes footnote-paragraphs.{idml,pdf,json}
# into OUT_DIR (default: a fresh temporary directory) and prints, per case,
# each note line's baseline and its first and last insertion point. Takes
# the InDesign GUI for a few seconds; it takes the shared lock.
#
#   bash tools/indesign-export/footnote-paragraphs-probe.sh [OUT_DIR]
set -euo pipefail
OUT="${1:-$(mktemp -d -t paged-footnote-paragraphs-probe)}"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
APP="${INDESIGN_APP:-Adobe InDesign 2025}"
JSX="$(cd "$(dirname "$0")" && pwd)/footnote-paragraphs-probe.jsx"
SHIM="$(mktemp -t paged-footnote-paragraphs-shim).jsx"
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
python3 - "$OUT/footnote-paragraphs.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for e in d["errors"]:
    print("error:", e)
for name, f in d["frames"].items():
    print(f"{name}: frame {f['frame']}, body baselines {f['body']}")
    for n in f["notes"]:
        for pi, p in enumerate(n["paragraphs"]):
            for l in p["lines"]:
                print(f"    note@{n['at']} p{pi} baseline {l['baseline']:8.3f} "
                      f"x {l['ip'][0]:8.3f}..{l['ip'][-1]:8.3f}  {l['text'][:40]!r}")
PY
echo "==> $OUT"
