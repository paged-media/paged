#!/usr/bin/env python3
"""Write the live-preset and connector shapes on both slides of PowerPoint's
blank deck (fixture: connectors).

  python3 connectors.seed.py <blank.pptx> <seed.pptx>

PowerPoint's dictionary cannot glue a connector to a shape's connection site
or set a preset's adjust values. This writes, on each slide: a rounded
rectangle with its adjust value, a rectangular callout with its tip moved, a
can (a filled body and a stroke-only rim), a flipped right triangle, three
boxes, and three connectors glued to them (elbow, straight, curved) with
a:stCxn / a:endCxn. Each connector's box runs from its start site to its end
site, as PowerPoint writes it; PowerPoint re-saves the deck
(resave.applescript), then edits slide 2 (connectors.post.applescript)."""
import re, sys, zipfile

IN = 914400
A = "http://schemas.openxmlformats.org/drawingml/2006/main"

def style():
    return ('<p:style><a:lnRef idx="2"><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:lnRef>'
            '<a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef>'
            '<a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style>')

def sp(i, name, prst, x, y, w, h, adj=(), flip="", text=""):
    gds = "".join(f'<a:gd name="{n}" fmla="val {v}"/>' for n, v in adj)
    body = (f'<p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/>'
            + (f'<a:r><a:rPr lang="en-US" dirty="0"/><a:t>{text}</a:t></a:r>' if text else '<a:endParaRPr lang="en-US" dirty="0"/>')
            + '</a:p></p:txBody>')
    return (f'<p:sp><p:nvSpPr><p:cNvPr id="{i}" name="{name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
            f'<p:spPr><a:xfrm{flip}><a:off x="{x}" y="{y}"/><a:ext cx="{w}" cy="{h}"/></a:xfrm>'
            f'<a:prstGeom prst="{prst}"><a:avLst>{gds}</a:avLst></a:prstGeom></p:spPr>{style()}{body}</p:sp>')

# Boxes: (id, name, prst, x, y, w, h) and their sites (rect: t l b r;
# ellipse: t, tl, l, bl, b, br, r, tr).
A_ = (6, "Box A", "rect", 1 * IN, 4.5 * IN, 2 * IN, 1 * IN)
B_ = (7, "Box B", "ellipse", 5.5 * IN, 3.5 * IN, 2 * IN, 1.2 * IN)
C_ = (8, "Box C", "rect", 10 * IN, 5 * IN, 1.5 * IN, 1 * IN)

def site(b, idx):
    _, _, prst, x, y, w, h = b
    pts = {"rect": [(x + w / 2, y), (x, y + h / 2), (x + w / 2, y + h), (x + w, y + h / 2)],
           "ellipse": [(x + w / 2, y), None, (x, y + h / 2), None, (x + w / 2, y + h), None, (x + w, y + h / 2)]}
    return pts[prst][idx]

def cxn(i, name, prst, a, ai, b, bi):
    (x1, y1), (x2, y2) = site(a, ai), site(b, bi)
    fl = (' flipH="1"' if x2 < x1 else "") + (' flipV="1"' if y2 < y1 else "")
    x, y, w, h = min(x1, x2), min(y1, y2), abs(x2 - x1), abs(y2 - y1)
    return (f'<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="{i}" name="{name}"/><p:cNvCxnSpPr>'
            f'<a:stCxn id="{a[0]}" idx="{ai}"/><a:endCxn id="{b[0]}" idx="{bi}"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr>'
            f'<p:spPr><a:xfrm{fl}><a:off x="{int(x)}" y="{int(y)}"/><a:ext cx="{int(w)}" cy="{int(h)}"/></a:xfrm>'
            f'<a:prstGeom prst="{prst}"><a:avLst/></a:prstGeom><a:ln w="19050"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:ln></p:spPr></p:cxnSp>')

def box(b):
    i, name, prst, x, y, w, h = b
    return sp(i, name, prst, int(x), int(y), int(w), int(h), text=name)

SHAPES = "".join([
    sp(2, "Rounded Rectangle 1", "roundRect", IN, int(0.8 * IN), int(2.5 * IN), int(1.5 * IN), adj=[("adj", 30000)], text="Live"),
    sp(3, "Callout 2", "wedgeRectCallout", int(4.5 * IN), int(0.8 * IN), int(2.5 * IN), int(1.2 * IN), adj=[("adj1", -40000), ("adj2", 90000)]),
    sp(4, "Can 3", "can", int(8.3 * IN), int(0.6 * IN), int(1.2 * IN), int(1.8 * IN)),
    sp(5, "Right Triangle 4", "rtTriangle", int(10.3 * IN), int(0.8 * IN), int(1.5 * IN), int(1.5 * IN), flip=' flipH="1"'),
    box(A_), box(B_), box(C_),
    cxn(9, "Elbow Connector 8", "bentConnector3", A_, 3, B_, 2),
    cxn(10, "Straight Arrow Connector 9", "straightConnector1", A_, 0, B_, 0),
    cxn(11, "Curved Connector 10", "curvedConnector3", B_, 6, C_, 1),
])

src, dst = sys.argv[1], sys.argv[2]
zin = zipfile.ZipFile(src)
zout = zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED)
for item in zin.infolist():
    d = zin.read(item.filename)
    if re.match(r"ppt/slides/slide[12]\.xml$", item.filename):
        d = d.decode().replace("</p:spTree>", SHAPES + "</p:spTree>", 1).encode()
    zout.writestr(item, d)
zout.close()
