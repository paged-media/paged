#!/usr/bin/env python3
"""Write the `bevels` fixture's shapes into PowerPoint's blank deck.

  python3 bevels.seed.py <blank.pptx> <seed.pptx>

Slide 1: every top bevel preset of `a:sp3d` (ECMA-376 ST_BevelPresetType,
12), each on a blue rectangle in PowerPoint's default flat scene (an
orthographic front camera, the three-point light from the top), named after
its preset; then a wider and a deeper circle bevel, a bevel with a bottom
bevel beside it, and a bevel seen through a perspective camera (which
slide-native reports). Slide 2: outer shadows with PowerPoint's
perspective presets (scale and skew), a glow and a soft edge at two sizes,
an inner shadow. PowerPoint then re-saves the deck, so the recorded deck and
PDF are PowerPoint's own (slide ADR 723)."""
import re, sys, zipfile

EMU = 12700
BEVELS = ["circle", "relaxedInset", "cross", "coolSlant", "angle", "softRound",
          "convex", "slope", "divot", "riblet", "hardEdge", "artDeco"]
FLAT = ('<a:scene3d><a:camera prst="orthographicFront"/>'
        '<a:lightRig rig="threePt" dir="t"/></a:scene3d>')
PERSP = ('<a:scene3d><a:camera prst="perspectiveRelaxed"/>'
         '<a:lightRig rig="threePt" dir="t"/></a:scene3d>')
BLUE = '<a:solidFill><a:srgbClr val="4472C4"/></a:solidFill>'


def sp3d(top=None, bottom=None, extra=""):
    t = f'<a:bevelT w="{top[0] * EMU}" h="{top[1] * EMU}" prst="{top[2]}"/>' if top else ""
    b = f'<a:bevelB w="{bottom[0] * EMU}" h="{bottom[1] * EMU}" prst="{bottom[2]}"/>' if bottom else ""
    return f'<a:sp3d{extra}>{t}{b}</a:sp3d>'


def shape(i, name, x, y, w, h, fill, after_ln=""):
    return (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{100 + i}" name="{name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="{x * EMU}" y="{y * EMU}"/><a:ext cx="{w * EMU}" cy="{h * EMU}"/></a:xfrm>'
        f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>{fill}<a:ln><a:noFill/></a:ln>{after_ln}</p:spPr></p:sp>'
    )


def slide1():
    out = []
    for k, p in enumerate(BEVELS):
        col, row = k % 6, k // 6
        out.append(shape(k, p, 40 + col * 150, 40 + row * 150, 110, 110, BLUE, FLAT + sp3d((6, 6, p))))
    more = [
        ("circle wide", FLAT + sp3d((18, 6, "circle"))),
        ("circle deep", FLAT + sp3d((6, 18, "circle"))),
        ("top and bottom", FLAT + sp3d((6, 6, "circle"), (6, 6, "circle"))),
        ("perspective camera", PERSP + sp3d((6, 6, "circle"))),
    ]
    for j, (nm, fx) in enumerate(more):
        out.append(shape(20 + j, nm, 40 + j * 150, 360, 110, 110, BLUE, fx))
    return "".join(out)


def shadow(sx, sy, kx, ky, algn, dist=0, blur=0, dir_=0, alpha=50000):
    return (f'<a:effectLst><a:outerShdw blurRad="{blur * EMU}" dist="{dist * EMU}" dir="{dir_ * 60000}" '
            f'sx="{sx}" sy="{sy}" kx="{kx * 60000}" ky="{ky * 60000}" algn="{algn}" rotWithShape="0">'
            f'<a:srgbClr val="000000"><a:alpha val="{alpha}"/></a:srgbClr></a:outerShdw></a:effectLst>')


def slide2():
    cases = [
        # PowerPoint's Perspective presets (Format Shape > Shadow > Presets).
        ("perspective upper left", shadow(100000, 23000, -20, 0, "br", blur=6)),
        ("perspective upper right", shadow(100000, 23000, 20, 0, "bl", blur=6)),
        ("perspective below", shadow(90000, -19000, 0, 0, "bl", dist=12, blur=12, dir_=90)),
        ("perspective lower left", shadow(100000, -23000, 20, 0, "tr", blur=6, dir_=0)),
        ("plain offset", shadow(100000, 100000, 0, 0, "tl", dist=8, blur=8, dir_=45)),
        ("glow small", '<a:effectLst><a:glow rad="63500"><a:srgbClr val="FFC000"><a:alpha val="60000"/></a:srgbClr></a:glow></a:effectLst>'),
        ("glow large", '<a:effectLst><a:glow rad="228600"><a:srgbClr val="70AD47"><a:alpha val="40000"/></a:srgbClr></a:glow></a:effectLst>'),
        ("soft edge small", '<a:effectLst><a:softEdge rad="63500"/></a:effectLst>'),
        ("soft edge large", '<a:effectLst><a:softEdge rad="317500"/></a:effectLst>'),
        ("inner shadow", '<a:effectLst><a:innerShdw blurRad="114300" dist="38100" dir="2700000"><a:srgbClr val="000000"><a:alpha val="60000"/></a:srgbClr></a:innerShdw></a:effectLst>'),
    ]
    out = []
    for k, (nm, fx) in enumerate(cases):
        col, row = k % 5, k // 5
        out.append(shape(k, nm, 60 + col * 180, 70 + row * 230, 120, 120, BLUE, fx))
    return "".join(out)


src, dst = sys.argv[1], sys.argv[2]
zin = zipfile.ZipFile(src)
zout = zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED)
for item in zin.infolist():
    data = zin.read(item.filename)
    m = re.match(r"ppt/slides/slide(\d)\.xml$", item.filename)
    if m:
        sps = {1: slide1(), 2: slide2()}.get(int(m.group(1)), "")
        data = data.decode().replace("</p:spTree>", sps + "</p:spTree>", 1).encode()
    zout.writestr(item, data)
zout.close()
