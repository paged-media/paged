#!/usr/bin/env python3
"""Write turned WordArt and SmartArt with turned text into PowerPoint's blank
deck (fixture: rotated-text).

  python3 rotated-text.seed.py <blank.pptx> <seed.pptx>

Slide 1: two shapes whose text is bent (`a:prstTxWarp`) and turned with the
shape (`a:xfrm/@rot`): an arch up at 30 degrees, a wave at -20 degrees, each
with a thin outline so the box shows.

Slides 2 to 4: a SmartArt diagram each, laid out by PowerPoint when it
re-saves the deck: the vertical chevron list (chevrons turned a quarter, their
text turned back upright: `dsp:txXfrm/@rot`), the horizontal multi-level
hierarchy (its root's text set along the turned box) and a basic process.

PowerPoint lays a diagram out with the layout definition the deck carries, so
the layout, quick style and colour definitions are copied from PowerPoint's
own SmartArt resources on the recording Mac (`SMARTART` below); nothing of
them is kept in this repository."""
import os, re, sys, uuid, zipfile

SMARTART = os.environ.get(
    "PPT_SMARTART",
    "/Applications/Microsoft PowerPoint.app/Contents/Frameworks/SmartArt.framework/Versions/A/Resources",
)
DGM = "http://schemas.openxmlformats.org/drawingml/2006/diagram"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
RT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"


def g():
    return "{" + str(uuid.uuid4()).upper() + "}"


def t(s):
    body = f'<a:r><a:rPr lang="en-US"/><a:t>{s}</a:t></a:r>' if s else '<a:endParaRPr lang="en-US"/>'
    return f"<dgm:t><a:bodyPr/><a:lstStyle/><a:p>{body}</a:p></dgm:t>"


def data(urn, nodes, tree):
    doc = g()
    pts = [
        f'<dgm:pt modelId="{doc}" type="doc"><dgm:prSet loTypeId="{urn}" loCatId="" '
        'qsTypeId="urn:microsoft.com/office/officeart/2005/8/quickstyle/simple1" qsCatId="simple" '
        'csTypeId="urn:microsoft.com/office/officeart/2005/8/colors/accent1_2" csCatId="accent1"/>'
        f'<dgm:spPr/>{t("")}</dgm:pt>'
    ]
    cx, ids, order = [], {}, {}
    for i, name in enumerate(nodes):
        n, p, s, c = g(), g(), g(), g()
        ids[i] = n
        pts.append(f'<dgm:pt modelId="{n}"><dgm:prSet phldrT="[Text]"/><dgm:spPr/>{t(name)}</dgm:pt>')
        pts.append(f'<dgm:pt modelId="{p}" type="parTrans" cxnId="{c}"><dgm:prSet/><dgm:spPr/>{t("")}</dgm:pt>')
        pts.append(f'<dgm:pt modelId="{s}" type="sibTrans" cxnId="{c}"><dgm:prSet/><dgm:spPr/>{t("")}</dgm:pt>')
        parent = doc if tree[i] is None else ids[tree[i]]
        k = order.get(parent, 0)
        order[parent] = k + 1
        cx.append(
            f'<dgm:cxn modelId="{c}" srcId="{parent}" destId="{n}" srcOrd="{k}" destOrd="0" '
            f'parTransId="{p}" sibTransId="{s}"/>'
        )
    return (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><dgm:dataModel xmlns:dgm="{DGM}" '
        f'xmlns:a="{A}"><dgm:ptLst>{"".join(pts)}</dgm:ptLst><dgm:cxnLst>{"".join(cx)}</dgm:cxnLst>'
        "<dgm:bg/><dgm:whole/></dgm:dataModel>"
    )


def resource(kind, name):
    with open(os.path.join(SMARTART, kind, name), "rb") as f:
        return f.read()


# (layout file, layout id, nodes, parent of each node)
DIAGRAMS = [
    (
        "chevron2.glo",
        "urn:microsoft.com/office/officeart/2005/8/layout/chevron2",
        ["One", "First step", "Two", "Second step", "Three", "Third step"],
        [None, 0, None, 2, None, 4],
    ),
    (
        "horizontalmultilevelhierarchy.glo",
        "urn:microsoft.com/office/officeart/2008/layout/HorizontalMultiLevelHierarchy",
        ["Root", "Left", "Right", "Below"],
        [None, 0, 0, 0],
    ),
    (
        "hlist6.glo",
        "urn:microsoft.com/office/officeart/2005/8/layout/hList6",
        ["Alpha", "Beta", "Gamma"],
        [None, None, None],
    ),
]


def wordart(sid, name, rot, off, ext, warp, text, color):
    return (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{sid}" name="{name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm rot="{rot}"><a:off x="{off[0]}" y="{off[1]}"/><a:ext cx="{ext[0]}" cy="{ext[1]}"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>'
        '<a:ln w="6350"><a:solidFill><a:srgbClr val="808080"/></a:solidFill></a:ln></p:spPr>'
        '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr">'
        f'<a:prstTxWarp prst="{warp}"><a:avLst/></a:prstTxWarp><a:noAutofit/></a:bodyPr><a:lstStyle/>'
        f'<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="4000" b="1"><a:solidFill><a:srgbClr val="{color}"/>'
        f'</a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>'
    )


SLIDE1 = wordart(
    60, "Arch 30", 1800000, (1524000, 1524000), (4572000, 1828800), "textArchUp", "Rotated arch", "C00000"
) + wordart(
    61, "Wave -20", 20400000, (6858000, 3657600), (4114800, 1371600), "textWave1", "Waving text", "1F4E79"
)

src, dst = sys.argv[1], sys.argv[2]
zin = zipfile.ZipFile(src)
zout = zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED)
extra = {}
for k, (glo, urn, nodes, tree) in enumerate(DIAGRAMS, 1):
    extra[f"ppt/diagrams/data{k}.xml"] = data(urn, nodes, tree).encode()
    extra[f"ppt/diagrams/layout{k}.xml"] = resource("lo", glo)
    extra[f"ppt/diagrams/quickStyle{k}.xml"] = resource("qs", "simple1.gqs")
    extra[f"ppt/diagrams/colors{k}.xml"] = resource("cs", "accent1_2.gcs")
for item in zin.infolist():
    d = zin.read(item.filename)
    m = re.match(r"ppt/slides/slide(\d+)\.xml$", item.filename)
    if m:
        n = int(m.group(1))
        if n == 1:
            d = d.decode().replace("</p:spTree>", SLIDE1 + "</p:spTree>", 1).encode()
        elif n - 1 <= len(DIAGRAMS):
            k = n - 1
            frame = (
                f'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="50" name="Diagram {k}"/><p:cNvGraphicFramePr/>'
                '<p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="1270000" y="1270000"/><a:ext cx="9144000" cy="4572000"/>'
                '</p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">'
                f'<dgm:relIds xmlns:dgm="{DGM}" xmlns:r="{R}" r:dm="rIdD{k}" r:lo="rIdL{k}" r:qs="rIdQ{k}" r:cs="rIdC{k}"/>'
                "</a:graphicData></a:graphic></p:graphicFrame>"
            )
            d = d.decode().replace("</p:spTree>", frame + "</p:spTree>", 1).encode()
    m = re.match(r"ppt/slides/_rels/slide(\d+)\.xml\.rels$", item.filename)
    if m and 1 <= int(m.group(1)) - 1 <= len(DIAGRAMS):
        k = int(m.group(1)) - 1
        rels = (
            f'<Relationship Id="rIdD{k}" Type="{RT}diagramData" Target="../diagrams/data{k}.xml"/>'
            f'<Relationship Id="rIdL{k}" Type="{RT}diagramLayout" Target="../diagrams/layout{k}.xml"/>'
            f'<Relationship Id="rIdQ{k}" Type="{RT}diagramQuickStyle" Target="../diagrams/quickStyle{k}.xml"/>'
            f'<Relationship Id="rIdC{k}" Type="{RT}diagramColors" Target="../diagrams/colors{k}.xml"/>'
        )
        d = d.decode().replace("</Relationships>", rels + "</Relationships>", 1).encode()
    if item.filename == "[Content_Types].xml":
        o = "".join(
            f'<Override PartName="/ppt/diagrams/{p}{k}.xml" '
            f'ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagram{ct}+xml"/>'
            for k in range(1, len(DIAGRAMS) + 1)
            for p, ct in [("data", "Data"), ("layout", "Layout"), ("quickStyle", "Style"), ("colors", "Colors")]
        )
        d = d.decode().replace("</Types>", o + "</Types>", 1).encode()
    zout.writestr(item, d)
for k, v in extra.items():
    zout.writestr(k, v)
zout.close()
