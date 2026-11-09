#!/usr/bin/env python3
"""Write straight lines with DrawingML line ends into slide 1 of PowerPoint's
blank deck: the probe of doc ADR 629, amendment 1 (where Office stops a line
under its head).

  python3 ppt-line-ends-probe.py <blank.pptx> <seed.pptx> [1|2]

Set 1: columns are line widths 1, 4 and 10 pt; rows the tail kinds
(triangle, stealth, diamond, oval, arrow) at med/med, then triangle sm/sm and
lg/lg, then triangle and arrow on a round-capped line. Set 2: widths 0.5,
1.5, 2.5 and 6 pt; triangle med, stealth sm and lg, triangle w=sm len=lg and
w=lg len=sm, arrow sm, lg and w=lg len=sm, stealth w=sm len=lg. Each line runs
to the right, its tail at its right end; the head end stays plain.

The blank deck comes from fixtures/tables.applescript (`<out> 1`); PowerPoint
re-saves the seed (fixtures/resave.applescript) and ppt-export-probe.sh asks
it for the PDF, whose content stream gives each line's stroke outline (a
filled rectangle ending where the stroke stops) and its head."""
import re, sys, zipfile

IN = 914400
PT = 12700
SETS = {
    "1": ([("triangle", "med", "med", "flat"), ("stealth", "med", "med", "flat"),
           ("diamond", "med", "med", "flat"), ("oval", "med", "med", "flat"),
           ("arrow", "med", "med", "flat"), ("triangle", "sm", "sm", "flat"),
           ("triangle", "lg", "lg", "flat"), ("triangle", "med", "med", "rnd"),
           ("arrow", "med", "med", "rnd")], [1, 4, 10], 3.0, 4.2, 0.6),
    "2": ([("triangle", "med", "med", "flat"), ("stealth", "sm", "sm", "flat"),
           ("stealth", "lg", "lg", "flat"), ("triangle", "sm", "lg", "flat"),
           ("triangle", "lg", "sm", "flat"), ("arrow", "sm", "sm", "flat"),
           ("arrow", "lg", "lg", "flat"), ("arrow", "lg", "sm", "flat"),
           ("stealth", "sm", "lg", "flat")], [0.5, 1.5, 2.5, 6], 2.5, 3.2, 0.4),
}


def line(i, x, y, length_in, w_pt, kind, wsz, lsz, cap):
    return (f'<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="{i}" name="Line {i}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>'
            f'<p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{int(length_in * IN)}" cy="0"/></a:xfrm>'
            f'<a:prstGeom prst="line"><a:avLst/></a:prstGeom>'
            f'<a:ln w="{int(w_pt * PT)}" cap="{cap}"><a:solidFill><a:srgbClr val="1F4E79"/></a:solidFill>'
            f'<a:prstDash val="solid"/><a:headEnd type="none"/>'
            f'<a:tailEnd type="{kind}" w="{wsz}" len="{lsz}"/></a:ln></p:spPr></p:cxnSp>')


src, dst = sys.argv[1], sys.argv[2]
rows, widths, length_in, step_in, left_in = SETS[sys.argv[3] if len(sys.argv) > 3 else "1"]
shapes, i = [], 2
for r, (kind, wsz, lsz, cap) in enumerate(rows):
    for c, w in enumerate(widths):
        x, y = int((left_in + c * step_in) * IN), int((0.5 + r * 0.78) * IN)
        shapes.append(line(i, x, y, length_in, w, kind, wsz, lsz, cap))
        i += 1
zin = zipfile.ZipFile(src)
zout = zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED)
for item in zin.infolist():
    d = zin.read(item.filename)
    if re.match(r"ppt/slides/slide1\.xml$", item.filename):
        d = d.decode().replace("</p:spTree>", "".join(shapes) + "</p:spTree>", 1).encode()
    zout.writestr(item, d)
zout.close()
