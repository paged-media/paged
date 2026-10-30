#!/usr/bin/env python3
"""Write the `effect-stack` fixture's shapes into PowerPoint's blank deck.

  python3 effect-stack.seed.py <blank.pptx> <seed.pptx>

One shape per DrawingML effect the shared mapper puts on the engine's
effect stack (engine ADR 1008: blur, fill overlay, reflection) and two
custom geometries that show how PowerPoint fills a path's contours (engine
ADR 1006: even-odd), each named after what it carries. PowerPoint then
re-saves the deck, so the recorded deck and PDF are PowerPoint's own."""
import re, sys, zipfile

EMU = 12700
RECT = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
BLUE = '<a:solidFill><a:srgbClr val="0000FF"/></a:solidFill>'
YELLOW = '<a:solidFill><a:srgbClr val="FFFF00"/></a:solidFill>'


def square(x0, y0, x1, y1, reverse=False):
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    if reverse:
        pts.reverse()
    (fx, fy), rest = pts[0], pts[1:]
    return (f'<a:moveTo><a:pt x="{fx}" y="{fy}"/></a:moveTo>'
            + "".join(f'<a:lnTo><a:pt x="{x}" y="{y}"/></a:lnTo>' for x, y in rest)
            + '<a:close/>')


def nested(reverse):
    return ('<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/>'
            '<a:pathLst><a:path w="100" h="100">'
            + square(0, 0, 100, 100) + square(25, 25, 75, 75, reverse)
            + '</a:path></a:pathLst></a:custGeom>')


SHAPES = [
    ("even-odd", nested(False), BLUE, ""),
    ("non-zero", nested(True), BLUE, ""),
    ("blur", RECT, BLUE, '<a:effectLst><a:blur rad="127000"/></a:effectLst>'),
    ("multiply overlay", RECT, YELLOW, '<a:effectLst><a:fillOverlay blend="mult"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:fillOverlay></a:effectLst>'),
    ("gradient overlay", RECT, BLUE, '<a:effectLst><a:fillOverlay blend="over"><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FFFFFF"/></a:gs><a:gs pos="100000"><a:srgbClr val="000000"/></a:gs></a:gsLst><a:lin ang="0" scaled="0"/></a:gradFill></a:fillOverlay></a:effectLst>'),
    ("reflection", RECT, BLUE, '<a:effectLst><a:reflection blurRad="6350" stA="52000" endA="300" endPos="35000" dist="38100" dir="5400000" sy="-100000" algn="bl" rotWithShape="0"/></a:effectLst>'),
]


def shape(i, name, geom, fill, fx, x, y):
    return (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{100 + i}" name="{name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="{x * EMU}" y="{y * EMU}"/><a:ext cx="{120 * EMU}" cy="{120 * EMU}"/></a:xfrm>'
        f'{geom}{fill}<a:ln><a:noFill/></a:ln>{fx}</p:spPr></p:sp>'
    )


src, dst = sys.argv[1], sys.argv[2]
zin = zipfile.ZipFile(src)
zout = zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED)
for item in zin.infolist():
    data = zin.read(item.filename)
    if re.match(r"ppt/slides/slide1\.xml$", item.filename):
        sps = "".join(
            shape(k, nm, g, f, e, 40 + (k % 3) * 250, 40 + (k // 3) * 220)
            for k, (nm, g, f, e) in enumerate(SHAPES)
        )
        data = data.decode().replace("</p:spTree>", sps + "</p:spTree>", 1).encode()
    zout.writestr(item, data)
zout.close()
