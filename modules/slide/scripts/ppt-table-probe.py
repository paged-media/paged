#!/usr/bin/env python3
"""Record how PowerPoint drew every table of a deck (ADR 705).

  python3 scripts/ppt-table-probe.py <deck.pptx> <deck.ppt.pdf> > <deck>.tables.json

Per table (by shape name): for each cell, the colour PowerPoint's page shows
there (RGB 0–255, sampled from the rasterised page at three quarters of the
cell's width and half its height, clear of left-aligned text and of borders,
so a translucent fill reads as composited over what lies beneath) and its text's colour and weight; and every border
segment drawn inside the table's box (strokes, and the thin filled bars
PowerPoint draws for compound lines), in table-local pt. The cell grid is
read from the slide XML (column widths, row heights). Needs pdfplumber."""
import json, re, sys, zipfile

import pdfplumber

EMU = 12700
pptx, pdf = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(pptx)
doc = pdfplumber.open(pdf)


def rgb(c):
    if c is None:
        return None
    c = list(c) if isinstance(c, (list, tuple)) else [c]
    if len(c) == 1:
        c = c * 3
    if len(c) != 3:
        return None
    return [round(v * 255) for v in c]


slides = sorted((n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)),
                key=lambda n: int(re.findall(r"\d+", n)[0]))
tables = {}
SCALE = 4  # px per pt
for name in slides:
    number = int(re.findall(r"\d+", name)[0])
    page = doc.pages[number - 1]
    image = None
    xml = z.read(name).decode()
    for m in re.finditer(r"<p:graphicFrame>.*?</p:graphicFrame>", xml, re.S):
        frame = m.group(0)
        if "<a:tbl>" not in frame:
            continue
        shape = re.search(r'name="([^"]*)"', frame)[1]
        off = re.search(r'<a:off x="(-?\d+)" y="(-?\d+)"', frame)
        x, y = int(off[1]) / EMU, int(off[2]) / EMU
        cols = [int(w) / EMU for w in re.findall(r'<a:gridCol w="(\d+)"', frame)]
        rows = [int(h) / EMU for h in re.findall(r'<a:tr h="(\d+)"', frame)]
        xs = [x + sum(cols[:i]) for i in range(len(cols) + 1)]
        ys = [y + sum(rows[:i]) for i in range(len(rows) + 1)]
        inside = lambda o: o["x0"] >= xs[0] - 3 and o["x1"] <= xs[-1] + 3 and o["top"] >= ys[0] - 3 and o["bottom"] <= ys[-1] + 3
        cells = []
        for r in range(len(rows)):
            row = []
            for c in range(len(cols)):
                cx, cy = (xs[c] + xs[c + 1]) / 2, (ys[r] + ys[r + 1]) / 2
                if image is None:
                    image = page.to_image(resolution=72 * SCALE).original.convert("RGB")
                sx, sy = xs[c] + 0.75 * (xs[c + 1] - xs[c]), (ys[r] + ys[r + 1]) / 2
                fill = list(image.getpixel((int(sx * SCALE), int(sy * SCALE))))
                chars = [ch for ch in page.chars if xs[c] <= ch["x0"] < xs[c + 1] and ys[r] <= ch["top"] < ys[r + 1] and ch["text"].strip()]
                text = None
                if chars:
                    text = {"rgb": rgb(chars[0].get("non_stroking_color")), "bold": "Bold" in chars[0]["fontname"]}
                row.append({"fill": fill, "text": text})
            cells.append(row)
        borders = []
        for l in page.lines:
            if inside(l):
                borders.append({"from": [round(l["x0"] - x, 2), round(l["top"] - y, 2)], "to": [round(l["x1"] - x, 2), round(l["bottom"] - y, 2)],
                                "width": round(l["linewidth"] / EMU, 2) if l["linewidth"] > 50 else round(l["linewidth"], 2),
                                "rgb": rgb(l.get("stroking_color"))})
        for rect in page.rects:
            if inside(rect) and rect.get("fill") and (rect["width"] <= 5 or rect["height"] <= 5):
                borders.append({"bar": [round(rect["x0"] - x, 2), round(rect["top"] - y, 2), round(rect["width"], 2), round(rect["height"], 2)],
                                "rgb": rgb(rect.get("non_stroking_color"))})
        tables[shape] = {"slide": number, "cols": cols, "rows": rows, "cells": cells, "borders": borders}
json.dump({"tables": tables}, sys.stdout, indent=None, separators=(",", ":"))
print()
