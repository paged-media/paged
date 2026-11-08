#!/usr/bin/env python3
"""Write one SmartArt diagram per slide into PowerPoint's blank deck
(fixture: smartart).

  python3 smartart.seed.py <blank.pptx> <seed.pptx>

PowerPoint's dictionary cannot create SmartArt. Each diagram here is a data
model (its nodes and their tree) naming a built-in layout, quick style and
colour scheme by id; PowerPoint lays it out when it re-saves the deck
(resave.applescript), writing the layout and style definitions and the
drawing (dsp) part with the shapes it drew. The colour definition is written
here, because PowerPoint does not fill one in from its id: the common style
labels get accent 1 fills and light 1 lines and text."""
import re, sys, zipfile, uuid
DGM="http://schemas.openxmlformats.org/drawingml/2006/diagram"
A="http://schemas.openxmlformats.org/drawingml/2006/main"
R="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
RT="http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
def g(): return "{"+str(uuid.uuid4()).upper()+"}"
def t(s): return f'<dgm:t><a:bodyPr/><a:lstStyle/><a:p>{"<a:r><a:rPr lang=\"en-US\"/><a:t>"+s+"</a:t></a:r>" if s else "<a:endParaRPr lang=\"en-US\"/>"}</a:p></dgm:t>'
def data(layout, nodes, tree=None):
    doc=g(); pts=[f'<dgm:pt modelId="{doc}" type="doc"><dgm:prSet loTypeId="urn:microsoft.com/office/officeart/2005/8/layout/{layout}" loCatId="" qsTypeId="urn:microsoft.com/office/officeart/2005/8/quickstyle/simple1" qsCatId="simple" csTypeId="urn:microsoft.com/office/officeart/2005/8/colors/accent1_2" csCatId="accent1"/><dgm:spPr/>{t("")}</dgm:pt>']
    cx=[]; ids={}
    for i,name in enumerate(nodes):
        n=g(); ids[i]=n; p=g(); s=g(); c=g()
        pts.append(f'<dgm:pt modelId="{n}"><dgm:prSet phldrT="[Text]"/><dgm:spPr/>{t(name)}</dgm:pt>')
        pts.append(f'<dgm:pt modelId="{p}" type="parTrans" cxnId="{c}"><dgm:prSet/><dgm:spPr/>{t("")}</dgm:pt>')
        pts.append(f'<dgm:pt modelId="{s}" type="sibTrans" cxnId="{c}"><dgm:prSet/><dgm:spPr/>{t("")}</dgm:pt>')
        parent = doc if tree is None or tree[i] is None else ids[tree[i]]
        order = sum(1 for j in range(i) if (tree is None or tree[j]==(tree[i] if tree else None)))
        cx.append(f'<dgm:cxn modelId="{c}" srcId="{parent}" destId="{n}" srcOrd="{order}" destOrd="0" parTransId="{p}" sibTransId="{s}"/>')
    return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><dgm:dataModel xmlns:dgm="{DGM}" xmlns:a="{A}"><dgm:ptLst>{"".join(pts)}</dgm:ptLst><dgm:cxnLst>{"".join(cx)}</dgm:cxnLst><dgm:bg/><dgm:whole/></dgm:dataModel>'
src,dst=sys.argv[1],sys.argv[2]
SPECS=[
    ("default", ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"], None),
    ("process1", ["Plan", "Build", "Ship"], None),
    ("cycle2", ["Read", "Resolve", "Write", "Render"], None),
    ("hierarchy1", ["Board", "Design", "Engineering", "Fonts", "Engine"], [None, 0, 0, 1, 2]),
    ("vList2", ["First point", "Second point", "Third point"], None),
    ("pyramid1", ["Vision", "Strategy", "Tactics"], None),
    ("venn1", ["Print", "Screen", "Slides"], None),
    ("radial1", ["Core", "Draw", "Sheet", "Slide", "Web"], [None, 0, 0, 0, 0]),
]

LABELS = ["node0", "node1", "lnNode1", "alignNode1", "vennNode1", "node2", "node3", "node4",
          "fgAcc1", "bgAcc1", "fgAccFollowNode1", "sibTrans2D1", "sibTrans1D1", "parChTrans1D1",
          "parChTrans1D2", "parChTrans1D3", "trBgShp", "bgShp", "dkBgShp", "trAlignAcc1",
          "solidFgAcc1", "solidAlignAcc1", "solidBgAcc1", "fgImgPlace1", "alignImgPlace1",
          "bgImgPlace1", "revTx", "conFgAcc1", "fgSibTrans2D1", "bgSibTrans2D1", "asst0", "asst1"]


def colors():
    def lbl(name):
        fill, line, text = "accent1", "lt1", "lt1"
        if name.startswith(("parChTrans", "sibTrans1D")):
            fill, line, text = "accent1", "accent1", "tx1"
        elif name in ("revTx", "bgShp", "trBgShp"):
            fill, line, text = "lt1", "accent1", "tx1"
        elif name.startswith(("fgAcc", "bgAcc", "fgAccFollow", "conFgAcc")):
            fill, line, text = "lt1", "accent1", "dk1"
        return (f'<dgm:styleLbl name="{name}"><dgm:fillClrLst meth="repeat"><a:schemeClr val="{fill}"/></dgm:fillClrLst>'
                f'<dgm:linClrLst meth="repeat"><a:schemeClr val="{line}"/></dgm:linClrLst><dgm:effectClrLst/><dgm:txLinClrLst/>'
                f'<dgm:txFillClrLst meth="repeat"><a:schemeClr val="{text}"/></dgm:txFillClrLst><dgm:txEffectClrLst/></dgm:styleLbl>')
    return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><dgm:colorsDef xmlns:dgm="{DGM}" xmlns:a="{A}" '
            f'uniqueId="urn:microsoft.com/office/officeart/2005/8/colors/accent1_2"><dgm:title val=""/><dgm:desc val=""/>'
            f'<dgm:catLst><dgm:cat type="accent1" pri="11200"/></dgm:catLst>{"".join(lbl(n) for n in LABELS)}</dgm:colorsDef>')
zin=zipfile.ZipFile(src); zout=zipfile.ZipFile(dst,"w",zipfile.ZIP_DEFLATED)
extra={}
for k,(layout,nodes,tree) in enumerate(SPECS,1):
    extra[f"ppt/diagrams/data{k}.xml"]=data(layout,nodes,tree)
    extra[f"ppt/diagrams/layout{k}.xml"]=f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><dgm:layoutDef xmlns:dgm="{DGM}" xmlns:a="{A}" uniqueId="urn:microsoft.com/office/officeart/2005/8/layout/{layout}"/>'
    extra[f"ppt/diagrams/quickStyle{k}.xml"]=f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><dgm:styleDef xmlns:dgm="{DGM}" xmlns:a="{A}" uniqueId="urn:microsoft.com/office/officeart/2005/8/quickstyle/simple1"/>'
    extra[f"ppt/diagrams/colors{k}.xml"]=colors()
for item in zin.infolist():
    d=zin.read(item.filename)
    m=re.match(r"ppt/slides/slide(\d+)\.xml$",item.filename)
    if m and int(m.group(1))<=len(SPECS):
        k=int(m.group(1))
        frame=f'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="50" name="Diagram {k}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="1270000" y="1270000"/><a:ext cx="9144000" cy="4572000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds xmlns:dgm="{DGM}" xmlns:r="{R}" r:dm="rIdD{k}" r:lo="rIdL{k}" r:qs="rIdQ{k}" r:cs="rIdC{k}"/></a:graphicData></a:graphic></p:graphicFrame>'
        d=d.decode().replace("</p:spTree>",frame+"</p:spTree>",1).encode()
    m=re.match(r"ppt/slides/_rels/slide(\d+)\.xml\.rels$",item.filename)
    if m and int(m.group(1))<=len(SPECS):
        k=int(m.group(1))
        rels=f'<Relationship Id="rIdD{k}" Type="{RT}diagramData" Target="../diagrams/data{k}.xml"/><Relationship Id="rIdL{k}" Type="{RT}diagramLayout" Target="../diagrams/layout{k}.xml"/><Relationship Id="rIdQ{k}" Type="{RT}diagramQuickStyle" Target="../diagrams/quickStyle{k}.xml"/><Relationship Id="rIdC{k}" Type="{RT}diagramColors" Target="../diagrams/colors{k}.xml"/>'
        d=d.decode().replace("</Relationships>",rels+"</Relationships>",1).encode()
    if item.filename=="[Content_Types].xml":
        o="".join(f'<Override PartName="/ppt/diagrams/{p}{k}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.diagram{ct}+xml"/>' for k in range(1,len(SPECS)+1) for p,ct in [("data","Data"),("layout","Layout"),("quickStyle","Style"),("colors","Colors")])
        d=d.decode().replace("</Types>",o+"</Types>",1).encode()
    zout.writestr(item,d)
for k,v in extra.items(): zout.writestr(k,v)
zout.close()
