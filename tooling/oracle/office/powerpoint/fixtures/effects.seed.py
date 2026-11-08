#!/usr/bin/env python3
"""Write the `effects` fixture's shapes into PowerPoint's blank deck.

  python3 effects.seed.py <blank.pptx> <seed.pptx>

One rectangle per DrawingML paint or effect the shared mapper lowers
(slide ADR 722), each named after what it carries. PowerPoint then re-saves
the deck, so the recorded deck and PDF are PowerPoint's own."""
import re, sys, zipfile

EMU = 12700
SOLID = '<a:solidFill><a:srgbClr val="4472C4"/></a:solidFill>'
SHAPES = [
    # slide 1: effects
    ("outer shadow", SOLID, '<a:effectLst><a:outerShdw blurRad="76200" dist="38100" dir="2700000" algn="tl" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr></a:outerShdw></a:effectLst>'),
    ("inner shadow", SOLID, '<a:effectLst><a:innerShdw blurRad="63500" dist="50800" dir="13500000"><a:srgbClr val="000000"><a:alpha val="50000"/></a:srgbClr></a:innerShdw></a:effectLst>'),
    ("glow", SOLID, '<a:effectLst><a:glow rad="101600"><a:srgbClr val="FFC000"><a:alpha val="60000"/></a:srgbClr></a:glow></a:effectLst>'),
    ("soft edge", SOLID, '<a:effectLst><a:softEdge rad="63500"/></a:effectLst>'),
    ("reflection", SOLID, '<a:effectLst><a:reflection blurRad="6350" stA="52000" endA="300" endPos="35000" dir="5400000" sy="-100000" algn="bl" rotWithShape="0"/></a:effectLst>'),
    ("preset shadow", SOLID, '<a:effectLst><a:prstShdw prst="shdw17" dist="38100" dir="2700000"><a:srgbClr val="808080"/></a:prstShdw></a:effectLst>'),
    # slide 2: paints and lines
    ("alpha gradient", '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="C00000"/></a:gs><a:gs pos="100000"><a:srgbClr val="C00000"><a:alpha val="10000"/></a:srgbClr></a:gs></a:gsLst><a:lin ang="0" scaled="0"/></a:gradFill>', ""),
    ("radial gradient", '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="FFFFFF"/></a:gs><a:gs pos="100000"><a:srgbClr val="70AD47"/></a:gs></a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill>', ""),
    ("pattern", '<a:pattFill prst="pct50"><a:fgClr><a:srgbClr val="000000"/></a:fgClr><a:bgClr><a:srgbClr val="FFFFFF"/></a:bgClr></a:pattFill>', ""),
    ("dash sysDash", '<a:noFill/>', '<a:ln w="38100"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:prstDash val="sysDash"/></a:ln>'),
    ("dash lgDashDot", '<a:noFill/>', '<a:ln w="38100"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:prstDash val="lgDashDot"/></a:ln>'),
    ("dash custom", '<a:noFill/>', '<a:ln w="38100"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:custDash><a:ds d="500000" sp="200000"/><a:ds d="100000" sp="200000"/></a:custDash></a:ln>'),
]


def shape(i, name, fill, extra, x, y):
    ln = extra if extra.startswith("<a:ln") else ""
    fx = extra if extra.startswith("<a:effectLst") else ""
    return (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{100 + i}" name="{name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="{x * EMU}" y="{y * EMU}"/><a:ext cx="{200 * EMU}" cy="{120 * EMU}"/></a:xfrm>'
        f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>{fill}{ln}{fx}</p:spPr>'
        f'<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>{name}</a:t></a:r></a:p></p:txBody></p:sp>'
    )


src, dst = sys.argv[1], sys.argv[2]
zin = zipfile.ZipFile(src)
zout = zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED)
for item in zin.infolist():
    data = zin.read(item.filename)
    m = re.match(r"ppt/slides/slide(\d+)\.xml$", item.filename)
    if m and int(m.group(1)) <= 2:
        n = int(m.group(1))
        part = SHAPES[(n - 1) * 6 : n * 6]
        sps = "".join(
            shape((n - 1) * 6 + k, nm, f, e, 40 + (k % 3) * 300, 60 + (k // 3) * 220)
            for k, (nm, f, e) in enumerate(part)
        )
        data = data.decode().replace("</p:spTree>", sps + "</p:spTree>", 1).encode()
    zout.writestr(item, data)
zout.close()
