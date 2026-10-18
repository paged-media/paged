#!/usr/bin/env python3
"""Record where PowerPoint put each box's first two baselines (ADR 705).

  python3 scripts/ppt-baseline-probe.py <deck.pptx> <deck.ppt.pdf> > <deck>.baselines.json

Reads the 'H' glyphs of every text box in PowerPoint's own PDF export and
writes, per box name, the first baseline below the box's top inset and the
pitch to the second line, in pt. PowerPoint's PDF quantises positions to
0.96 pt, so the answers carry that much noise. Needs pdfplumber.
"""
import json, re, sys, zipfile

import pdfplumber

EMU = 12700
pptx, pdf = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(pptx)
doc = pdfplumber.open(pdf)
boxes = []
for n, page in enumerate(doc.pages, start=1):
    xml = z.read(f"ppt/slides/slide{n}.xml").decode()
    top = page.height
    for m in re.finditer(r"<p:sp>.*?</p:sp>", xml, re.S):
        sp = m.group(0)
        name = re.search(r'name="([^"]*)"', sp)[1]
        off = re.search(r'<a:off x="(-?\d+)" y="(-?\d+)"', sp)
        ext = re.search(r'<a:ext cx="(\d+)" cy="(\d+)"', sp)
        ins = re.search(r'tIns="(\d+)"', sp)
        x, y = int(off[1]) / EMU, int(off[2]) / EMU
        w, h = int(ext[1]) / EMU, int(ext[2]) / EMU
        inset = int(ins[1]) / EMU if ins else 3.6
        bases = sorted({round(top - c["matrix"][5], 2) for c in page.chars
                        if c["text"] == "H" and x <= c["x0"] <= x + w
                        and y <= top - c["matrix"][5] <= y + h + 40})
        if len(bases) >= 2:
            boxes.append({"slide": n, "name": name,
                          "first_baseline": round(bases[0] - (y + inset), 2),
                          "pitch": round(bases[1] - bases[0], 2)})
json.dump({"quantum_pt": 0.96, "boxes": boxes}, sys.stdout, indent=1)
print()
