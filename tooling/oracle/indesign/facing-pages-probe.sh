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

# Ask InDesign what Facing Pages, a one-page master in a facing document,
# and moving and duplicating a page there do; see facing-pages-probe.jsx.
# Writes facing-pages-probe.json, InDesign's IDML of the end state to the
# second argument and the PDF of step 5 to the third (default temporary
# files). Pass absolute paths. Step 5's rectangle is measured on that PDF
# (pdftoppm at 72 dpi: a pixel is a point) and added to the JSON as
# `onePageMasterItemOnEachSide`. Takes the InDesign GUI for a few seconds;
# take the shared lock:
#
#   until mkdir /tmp/paged-indesign.lock 2>/dev/null; do sleep 15; done
#   bash tooling/oracle/indesign/facing-pages-probe.sh
#   rmdir /tmp/paged-indesign.lock
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/facing-pages-probe.json}"
IDML="${2:-$(mktemp -t paged-facing).idml}"
PDF="${3:-$(mktemp -t paged-facing).pdf}"
APP="${INDESIGN_APP:-Adobe InDesign 2025}"
SHIM="$(mktemp -t paged-facing-shim).jsx"
PAGES="$(mktemp -d -t paged-facing-pages)"
trap 'rm -rf "$SHIM" "$PAGES"' EXIT
cat > "$SHIM" <<JSX
var PROBE_OUT = "$OUT";
var PROBE_IDML = "$IDML";
var PROBE_PDF = "$PDF";
\$.evalFile(File("$HERE/facing-pages-probe.jsx"));
JSX
# The raw `do script` event code: see run-export.sh for why.
osascript <<OSA
with timeout of 300 seconds
    tell application "$APP"
        «event K2  dosc» (POSIX file "$SHIM") given «class doLg»:«constant ****JSLg»
    end tell
end timeout
OSA
# Where the black rectangle is printed on each page: the dark run of the
# row through its middle (y = 45 pt), from the page's left edge.
pdftoppm -r 72 -gray "$PDF" "$PAGES/p"
python3 -I - "$OUT" "$PAGES" <<'PY'
import json, os, sys
out, pages = sys.argv[1], sys.argv[2]
doc = json.load(open(out))
runs = []
for name in sorted(os.listdir(pages)):
    data = open(os.path.join(pages, name), "rb").read()
    magic, w, h, maxval, rest = data.split(maxsplit=4)
    assert magic == b"P5" and maxval == b"255", name
    w = int(w)
    row = rest[45 * w:46 * w]
    dark = [x for x in range(w) if row[x] < 60]
    runs.append([min(dark), max(dark) + 1] if dark else None)
sides = doc.pop("onePageMasterPdfSides")
doc["onePageMasterItemOnEachSide"] = [
    {"page": i + 1, "side": s, "printedFromPageLeft": r} for i, (s, r) in enumerate(zip(sides, runs))
]
# One line per step and per page measured.
line = lambda v: json.dumps(v, ensure_ascii=False)
with open(out, "w") as f:
    f.write('{"indesign": %s,\n"steps": [\n' % line(doc["indesign"]))
    f.write(",\n".join(line(s) for s in doc["steps"]))
    f.write('\n],\n"onePageMasterItemOnEachSide": [\n')
    f.write(",\n".join(line(s) for s in doc["onePageMasterItemOnEachSide"]))
    f.write("\n]}\n")
PY
echo "==> $OUT (InDesign's IDML: $IDML, PDF: $PDF)"
