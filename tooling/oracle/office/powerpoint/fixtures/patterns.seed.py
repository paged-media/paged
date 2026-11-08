#!/usr/bin/env python3
"""Write the `patterns` fixture's shapes into PowerPoint's blank deck.

  python3 patterns.seed.py <blank.pptx> <seed.pptx>

Every preset pattern of `a:pattFill` (ECMA-376 ST_PresetPatternVal, 54),
one rectangle each, black on white, named after its preset: slides 1 and 2
hold 27 each in a 9 x 3 grid. Slide 3 holds the colour and placement cases:
a red-on-yellow pattern, a half-transparent foreground and background, a
pattern in a rotated rectangle, one in an ellipse, one under a text frame and
one with a theme colour. PowerPoint then re-saves the deck, so the recorded
deck and PDF are PowerPoint's own; slide-native reads each preset's 8 x 8
cell and the scale PowerPoint draws it at from that PDF (slide ADR 723)."""
import re, sys, zipfile

EMU = 12700
PRESETS = [
    "pct5", "pct10", "pct20", "pct25", "pct30", "pct40", "pct50", "pct60", "pct70",
    "pct75", "pct80", "pct90", "horz", "vert", "ltHorz", "ltVert", "dkHorz", "dkVert",
    "narHorz", "narVert", "dashHorz", "dashVert", "cross", "dnDiag", "upDiag", "ltDnDiag",
    "ltUpDiag", "dkDnDiag", "dkUpDiag", "wdDnDiag", "wdUpDiag", "dashDnDiag", "dashUpDiag",
    "diagCross", "smCheck", "lgCheck", "smGrid", "lgGrid", "dotGrid", "smConfetti",
    "lgConfetti", "horzBrick", "diagBrick", "solidDmnd", "openDmnd", "dotDmnd", "plaid",
    "sphere", "weave", "divot", "shingle", "wave", "trellis", "zigZag",
]
assert len(PRESETS) == 54


def clr(v):
    if v.startswith("scheme:"):
        return f'<a:schemeClr val="{v[7:]}"/>'
    if "/" in v:
        rgb, a = v.split("/")
        return f'<a:srgbClr val="{rgb}"><a:alpha val="{a}"/></a:srgbClr>'
    return f'<a:srgbClr val="{v}"/>'


def patt(prst, fg="000000", bg="FFFFFF"):
    return f'<a:pattFill prst="{prst}"><a:fgClr>{clr(fg)}</a:fgClr><a:bgClr>{clr(bg)}</a:bgClr></a:pattFill>'


def shape(i, name, x, y, w, h, fill, geom="rect", rot=0, text=None):
    r = f' rot="{rot * 60000}"' if rot else ""
    body = ""
    if text:
        body = ('<p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/>'
                f'<a:r><a:rPr lang="en-US" sz="2400" b="1"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:rPr><a:t>{text}</a:t></a:r></a:p></p:txBody>')
    return (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{100 + i}" name="{name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm{r}><a:off x="{x * EMU}" y="{y * EMU}"/><a:ext cx="{w * EMU}" cy="{h * EMU}"/></a:xfrm>'
        f'<a:prstGeom prst="{geom}"><a:avLst/></a:prstGeom>{fill}<a:ln><a:noFill/></a:ln></p:spPr>{body}</p:sp>'
    )


def grid(presets):
    out = []
    for k, p in enumerate(presets):
        col, row = k % 9, k // 9
        out.append(shape(k, p, 24 + col * 104, 30 + row * 170, 96, 150, patt(p)))
    return "".join(out)


SLIDE3 = "".join([
    shape(0, "red on yellow", 40, 40, 200, 140, patt("lgCheck", "FF0000", "FFFF00")),
    shape(1, "half transparent", 280, 40, 200, 140, patt("diagCross", "0000FF/50000", "00FF00/50000")),
    shape(2, "rotated", 540, 50, 200, 120, patt("horz", "000000", "FFFFFF"), rot=30),
    shape(3, "ellipse", 40, 260, 200, 140, patt("wave", "7030A0", "FFFFFF"), geom="ellipse"),
    shape(4, "with text", 280, 260, 200, 140, patt("pct20", "000000", "FFFFFF"), text="Text"),
    shape(5, "theme colour", 540, 260, 200, 140, patt("trellis", "scheme:accent1", "scheme:bg1")),
])

src, dst = sys.argv[1], sys.argv[2]
zin = zipfile.ZipFile(src)
zout = zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED)
for item in zin.infolist():
    data = zin.read(item.filename)
    m = re.match(r"ppt/slides/slide(\d)\.xml$", item.filename)
    if m:
        n = int(m.group(1))
        sps = {1: grid(PRESETS[:27]), 2: grid(PRESETS[27:]), 3: SLIDE3}.get(n, "")
        data = data.decode().replace("</p:spTree>", sps + "</p:spTree>", 1).encode()
    zout.writestr(item, data)
zout.close()
