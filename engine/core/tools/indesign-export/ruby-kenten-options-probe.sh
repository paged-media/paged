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

# Ask InDesign what each ruby and kenten setting does; see
# ruby-kenten-options-probe.jsx. Writes ruby-kenten-options.{idml,pdf,json}
# into OUT_DIR (default: a fresh temporary directory) and prints the PDF's
# ruby and kenten text runs (font, size, origin, character spacing) by
# case. Takes the InDesign GUI for a few seconds; it takes the shared lock.
#
#   bash tools/indesign-export/ruby-kenten-options-probe.sh [OUT_DIR]
set -euo pipefail
OUT="${1:-$(mktemp -d -t paged-ruby-kenten-options-probe)}"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
APP="${INDESIGN_APP:-Adobe InDesign 2025}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SHIM="$(mktemp -t paged-ruby-kenten-options-shim).jsx"
LOCK=/tmp/paged-indesign.lock
until mkdir "$LOCK" 2>/dev/null; do sleep 15; done
trap 'rm -f "$SHIM"; rmdir "$LOCK" 2>/dev/null || true' EXIT
printf 'var PROBE_OUT = "%s";\n$.evalFile(File("%s"));\n' "$OUT" "$HERE/ruby-kenten-options-probe.jsx" > "$SHIM"
osascript <<OSA
with timeout of 900 seconds
    tell application "$APP"
        «event K2  dosc» (POSIX file "$SHIM") given «class doLg»:«constant ****JSLg»
    end tell
end timeout
OSA
rmdir "$LOCK" 2>/dev/null || true
python3 - "$OUT" "$HERE/pdf-text.py" <<'PY'
import json, subprocess, sys
out, tool = sys.argv[1], sys.argv[2]
probe = json.load(open(f"{out}/ruby-kenten-options.json"))
for e in probe["errors"]:
    if e:
        print("error:", e)
frames = []
for c in probe["cases"]:
    name, _, at = c.partition("@")
    page, _, top = at.partition(":")
    frames.append((int(page) + 1, float(top), name))
runs = subprocess.run(["python3", tool, f"{out}/ruby-kenten-options.pdf"], capture_output=True, text=True).stdout
for line in runs.splitlines():
    r = json.loads(line)
    if r["size_x"] >= 29.9 and r["size_y"] >= 29.9 and "Kenten" not in r["font"] and "Minion" not in r["font"]:
        continue  # a base character
    # A mark belongs to the frame whose first baseline (top + 23.16) is
    # nearest it.
    page_frames = [f for f in frames if f[0] == r["page"]]
    name = min(page_frames, key=lambda f: abs(f[1] + 23.16 - r["y"]))[2]
    print(f"{name:22} {r['font'].split('+')[-1][:18]:18} size {r['size_x']:5.2f} x {r['size_y']:5.2f} "
          f"at x {r['x']:8.3f} y {r['y']:8.3f} tc {r['tc']:.3f}")
PY
echo "==> $OUT"
