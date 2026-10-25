#!/usr/bin/env python3
"""Write review comments into the `placeholders` fixture (fixture: comments).

  python3 comments.seed.py slide-conformance/fixtures/placeholders.pptx <seed.pptx>
  osascript scripts/fixtures/resave.applescript <seed.pptx> <comments.pptx>

PowerPoint's dictionary cannot add comments. This writes them in the form
PowerPoint 16 writes them, and PowerPoint then re-saves the deck, so the
recorded fixture is PowerPoint's:

  slide 1  a modern comment by Ada Lovelace at (100 pt, 50 pt), "Check the
           title", with a reply by Grace Hopper, "Done"
  slide 2  a modern comment by Grace Hopper, resolved, anchored to its title
           (shape 4), "Shorter title?"
  slide 3  a legacy comment by Bob Legacy at (100 pt, 50 pt), "Legacy note"
"""
import re, sys, zipfile

P188 = "http://schemas.microsoft.com/office/powerpoint/2018/8/main"
PC = "http://schemas.microsoft.com/office/powerpoint/2013/main/command"
AC = "http://schemas.microsoft.com/office/drawing/2013/main/command"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
ADA = "{0A1D0A1D-0000-4000-8000-000000000001}"
GRACE = "{0A1D0A1D-0000-4000-8000-000000000002}"
REL_MODERN = "http://schemas.microsoft.com/office/2018/10/relationships/comments"
REL_LEGACY = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments"

src, dst = sys.argv[1], sys.argv[2]
zi = zipfile.ZipFile(src)
files = {n: zi.read(n) for n in zi.namelist()}


def text(part):
    return files[part].decode()


def add_rel(rels, rid, ty, target):
    files[rels] = text(rels).replace(
        "</Relationships>",
        f'<Relationship Id="{rid}" Type="{ty}" Target="{target}"/></Relationships>',
    ).encode()


def add_type(part, ct):
    files["[Content_Types].xml"] = text("[Content_Types].xml").replace(
        "</Types>", f'<Override PartName="/{part}" ContentType="{ct}"/></Types>'
    ).encode()


def body(s):
    return f'<p188:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>{s}</a:t></a:r></a:p></p188:txBody>'


def creation(slide):
    return re.search(r'p14:creationId [^>]*val="(\d+)"', text(slide)).group(1)


def shape_creation(slide, shape_id):
    m = re.search(
        rf'<p:cNvPr id="{shape_id}"[^>]*>.*?a16:creationId [^>]*id="(\{{[^"]+\}})"',
        text(slide),
    )
    return m.group(1)


def comment_rel(slide, rid):
    files[slide] = text(slide).replace(
        "</p:sld>",
        f'<p:extLst><p:ext uri="{{6950BFC3-D8DA-4A85-94F7-54DA5524770B}}"><p188:commentRel xmlns:p188="{P188}" r:id="{rid}"/></p:ext></p:extLst></p:sld>',
    ).encode()


head = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p188:cmLst xmlns:a="{A}" xmlns:r="{R}" xmlns:p188="{P188}">'
files["ppt/authors.xml"] = (
    f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p188:authorLst xmlns:a="{A}" xmlns:r="{R}" xmlns:p188="{P188}">'
    f'<p188:author id="{ADA}" name="Ada Lovelace" initials="AL" userId="Ada Lovelace" providerId="None"/>'
    f'<p188:author id="{GRACE}" name="Grace Hopper" initials="GH" userId="Grace Hopper" providerId="None"/></p188:authorLst>'
).encode()
add_rel("ppt/_rels/presentation.xml.rels", "rId90",
        "http://schemas.microsoft.com/office/2018/10/relationships/authors", "authors.xml")
add_type("ppt/authors.xml", "application/vnd.ms-powerpoint.authors+xml")

s1 = "ppt/slides/slide1.xml"
files["ppt/comments/modernComment_100_1.xml"] = (
    f'{head}<p188:cm id="{{C0C0C0C0-0000-4000-8000-000000000001}}" authorId="{ADA}" created="2026-10-25T09:00:00.000">'
    f'<pc:sldMkLst xmlns:pc="{PC}"><pc:docMk/><pc:sldMk cId="{creation(s1)}" sldId="256"/></pc:sldMkLst>'
    f'<p188:pos x="1270000" y="635000"/><p188:replyLst>'
    f'<p188:reply id="{{C0C0C0C0-0000-4000-8000-000000000002}}" authorId="{GRACE}" created="2026-10-25T10:00:00.000">{body("Done")}</p188:reply>'
    f'</p188:replyLst>{body("Check the title")}</p188:cm></p188:cmLst>'
).encode()
add_rel("ppt/slides/_rels/slide1.xml.rels", "rId90", REL_MODERN, "../comments/modernComment_100_1.xml")
add_type("ppt/comments/modernComment_100_1.xml", "application/vnd.ms-powerpoint.comments+xml")
comment_rel(s1, "rId90")

s2 = "ppt/slides/slide2.xml"
files["ppt/comments/modernComment_101_2.xml"] = (
    f'{head}<p188:cm id="{{C0C0C0C0-0000-4000-8000-000000000003}}" authorId="{GRACE}" status="resolved" created="2026-10-25T11:00:00.000">'
    f'<ac:deMkLst xmlns:ac="{AC}"><pc:docMk xmlns:pc="{PC}"/><pc:sldMk xmlns:pc="{PC}" cId="{creation(s2)}" sldId="257"/>'
    f'<ac:spMk id="4" creationId="{shape_creation(s2, 4)}"/></ac:deMkLst>'
    f'{body("Shorter title?")}</p188:cm></p188:cmLst>'
).encode()
add_rel("ppt/slides/_rels/slide2.xml.rels", "rId90", REL_MODERN, "../comments/modernComment_101_2.xml")
add_type("ppt/comments/modernComment_101_2.xml", "application/vnd.ms-powerpoint.comments+xml")
comment_rel(s2, "rId90")

files["ppt/commentAuthors.xml"] = (
    f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:cmAuthorLst xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}">'
    '<p:cmAuthor id="0" name="Bob Legacy" initials="BL" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>'
).encode()
add_rel("ppt/_rels/presentation.xml.rels", "rId91",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/commentAuthors", "commentAuthors.xml")
add_type("ppt/commentAuthors.xml",
         "application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml")
files["ppt/comments/comment1.xml"] = (
    f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:cmLst xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}">'
    '<p:cm authorId="0" dt="2026-10-25T12:00:00.000" idx="1"><p:pos x="800" y="400"/><p:text>Legacy note</p:text></p:cm></p:cmLst>'
).encode()
add_rel("ppt/slides/_rels/slide3.xml.rels", "rId90", REL_LEGACY, "../comments/comment1.xml")
add_type("ppt/comments/comment1.xml",
         "application/vnd.openxmlformats-officedocument.presentationml.comments+xml")

zo = zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED)
for n, b in files.items():
    zo.writestr(n, b)
zo.close()
