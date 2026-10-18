#!/usr/bin/env python3
"""Record what PowerPoint drew inside each chart or SmartArt frame of a
deck (ADR 705).

  python3 scripts/ppt-chart-probe.py <deck.pptx> <deck.ppt.pdf> > <deck>.charts.json

For every chart or diagram graphic frame: its kind, its box (pt, slide
space), every filled rectangle PowerPoint's PDF export painted inside it
(bars, legend keys, diagram blocks) in slide space, and the colours its text
was drawn in. Needs pdfplumber.
"""
import json, re, sys, zipfile

import pdfplumber

EMU = 12700
pptx, pdf = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(pptx)
doc = pdfplumber.open(pdf)
slides = sorted((n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)),
                key=lambda n: int(re.findall(r"\d+", n)[0]))
charts = []
for name in slides:
    xml = z.read(name).decode()
    number = int(re.findall(r"\d+", name)[0])
    page = doc.pages[number - 1]
    for m in re.finditer(r"<p:graphicFrame>.*?</p:graphicFrame>", xml, re.S):
        frame = m.group(0)
        kind = "chart" if "drawingml/2006/chart" in frame else "diagram" if "drawingml/2006/diagram" in frame else None
        if kind is None:
            continue
        off = re.search(r'<a:off x="(-?\d+)" y="(-?\d+)"', frame)
        ext = re.search(r'<a:ext cx="(\d+)" cy="(\d+)"', frame)
        x, y = int(off[1]) / EMU, int(off[2]) / EMU
        w, h = int(ext[1]) / EMU, int(ext[2]) / EMU
        rects = [[round(r["x0"], 2), round(r["top"], 2), round(r["width"], 2), round(r["height"], 2)]
                 for r in page.rects
                 if r["x0"] >= x - 2 and r["x1"] <= x + w + 2 and r["top"] >= y - 2 and r["bottom"] <= y + h + 2]
        inside = lambda o: o["x0"] >= x - 2 and o["x1"] <= x + w + 2 and o["top"] >= y - 2 and o["bottom"] <= y + h + 2
        text = sorted({tuple(round(v * 255) for v in (c.get("non_stroking_color") or (0, 0, 0)))
                       for c in page.chars if inside(c) and c["text"].strip()})
        charts.append({"slide": number, "kind": kind, "name": re.search(r'name="([^"]*)"', frame)[1],
                       "frame": [round(x, 2), round(y, 2), round(w, 2), round(h, 2)], "rects": rects,
                       "text_rgb": [list(t) for t in text]})
json.dump({"charts": charts}, sys.stdout, indent=1)
print()
