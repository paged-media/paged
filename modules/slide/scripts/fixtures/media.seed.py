#!/usr/bin/env python3
"""Write the `media` fixture's video and audio into a two-slide blank deck.

  python3 media.seed.py <blank.pptx> <clip.mp4> <tone.m4a> <poster.png> <icon.png> <seed.pptx>

Slide 1: a video picture (embedded, `p14:media` with a trim) that plays
automatically, at 40 % volume, looped, hidden while not playing. Slide 2: an
audio picture that plays on the first click. Each comes with the timing
nodes PowerPoint writes for it (`p:video` / `p:audio` and a `mediacall`
effect). The media are self-made (ffmpeg's test pattern and a sine tone;
see media.provenance.json). PowerPoint then re-saves the deck
(resave.applescript), so the recorded deck is PowerPoint's own.

The deck comes from effects.applescript (two blank slides)."""
import re, sys, zipfile

blank, clip, tone, poster, icon, dst = sys.argv[1:7]
EMU = 12700
P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
MEDIA_EXT = "{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"
R_VIDEO = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/video"
R_AUDIO = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio"
R_MEDIA = "http://schemas.microsoft.com/office/2007/relationships/media"
R_IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"


def pic(spid, name, kind, x, y, w, h, trim=""):
    tag = "videoFile" if kind == "video" else "audioFile"
    return (
        f'<p:pic><p:nvPicPr><p:cNvPr id="{spid}" name="{name}"><a:hlinkClick r:id="" action="ppaction://media"/></p:cNvPr>'
        f'<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>'
        f'<p:nvPr><a:{tag} r:link="rId91"/><p:extLst><p:ext uri="{MEDIA_EXT}">'
        f'<p14:media xmlns:p14="{P14}" r:embed="rId92">{trim}</p14:media></p:ext></p:extLst></p:nvPr></p:nvPicPr>'
        f'<p:blipFill><a:blip r:embed="rId93"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
        f'<p:spPr><a:xfrm><a:off x="{x * EMU}" y="{y * EMU}"/><a:ext cx="{w * EMU}" cy="{h * EMU}"/></a:xfrm>'
        f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
    )


def timing(spid, kind, auto, vol, loop, hide):
    # The main sequence's group: with the slide (auto) or on a click.
    group_cond = (
        '<p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>'
        if auto
        else '<p:cond delay="indefinite"/>'
    )
    node_type = "afterEffect" if auto else "clickEffect"
    rep = ' repeatCount="indefinite"' if loop else ""
    disp = ' display="0"' if hide else ""
    return (
        '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>'
        '<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>'
        f'<p:par><p:cTn id="3" fill="hold"><p:stCondLst>{group_cond}</p:stCondLst><p:childTnLst>'
        '<p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>'
        f'<p:par><p:cTn id="5" presetID="1" presetClass="mediacall" presetSubtype="0" fill="hold" nodeType="{node_type}">'
        '<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>'
        f'<p:cmd type="call" cmd="playFrom(0.0)"><p:cBhvr><p:cTn id="6" dur="2000" fill="hold"/>'
        f'<p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cBhvr></p:cmd>'
        '</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>'
        '</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>'
        '<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>'
        f'<p:{kind}><p:cMediaNode vol="{vol}"><p:cTn id="7"{rep} fill="hold"{disp}><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst>'
        f'</p:cTn><p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cMediaNode></p:{kind}>'
        '</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'
    )


SLIDES = {
    1: dict(
        spid=4, name="clip", kind="video", media="ppt/media/media1.mp4", poster="ppt/media/image91.png",
        box=(240, 135, 480, 270), trim='<p14:trim st="250" end="500"/>', auto=True, vol=40000, loop=True, hide=True,
    ),
    2: dict(
        spid=4, name="tone", kind="audio", media="ppt/media/media2.m4a", poster="ppt/media/image92.png",
        box=(448, 238, 64, 64), trim="", auto=False, vol=80000, loop=False, hide=False,
    ),
}
BYTES = {
    "ppt/media/media1.mp4": open(clip, "rb").read(),
    "ppt/media/media2.m4a": open(tone, "rb").read(),
    "ppt/media/image91.png": open(poster, "rb").read(),
    "ppt/media/image92.png": open(icon, "rb").read(),
}

zin = zipfile.ZipFile(blank)
zout = zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED)
names = set(zin.namelist())
for item in zin.infolist():
    data = zin.read(item.filename)
    m = re.match(r"ppt/slides/slide(\d+)\.xml$", item.filename)
    r = re.match(r"ppt/slides/_rels/slide(\d+)\.xml\.rels$", item.filename)
    if m and int(m.group(1)) in SLIDES:
        s = SLIDES[int(m.group(1))]
        x, y, w, h = s["box"]
        xml = data.decode()
        xml = xml.replace(
            "</p:spTree>", pic(s["spid"], s["name"], s["kind"], x, y, w, h, s["trim"]) + "</p:spTree>", 1
        )
        xml = re.sub(r"<p:timing>.*?</p:timing>", "", xml, flags=re.S)
        t = timing(s["spid"], s["kind"], s["auto"], s["vol"], s["loop"], s["hide"])
        xml = xml.replace("</p:cSld>", "</p:cSld>", 1)
        # p:timing goes after p:clrMapOvr (and p:transition).
        anchor = "</p:clrMapOvr>" if "</p:clrMapOvr>" in xml else "</p:cSld>"
        xml = xml.replace(anchor, anchor + t, 1)
        if 'xmlns:r=' not in xml.split(">", 2)[1]:
            xml = xml.replace("<p:sld ", '<p:sld xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ', 1)
        data = xml.encode()
    elif r and int(r.group(1)) in SLIDES:
        s = SLIDES[int(r.group(1))]
        rel_t = R_VIDEO if s["kind"] == "video" else R_AUDIO
        media = "../media/" + s["media"].rsplit("/", 1)[1]
        img = "../media/" + s["poster"].rsplit("/", 1)[1]
        add = (
            f'<Relationship Id="rId91" Type="{rel_t}" Target="{media}"/>'
            f'<Relationship Id="rId92" Type="{R_MEDIA}" Target="{media}"/>'
            f'<Relationship Id="rId93" Type="{R_IMAGE}" Target="{img}"/>'
        )
        data = data.decode().replace("</Relationships>", add + "</Relationships>", 1).encode()
    elif item.filename == "[Content_Types].xml":
        ct = data.decode()
        for ext, typ in (("mp4", "video/mp4"), ("m4a", "audio/mp4"), ("png", "image/png")):
            if f'Extension="{ext}"' not in ct:
                ct = ct.replace("<Default ", f'<Default Extension="{ext}" ContentType="{typ}"/><Default ', 1)
        data = ct.encode()
    zout.writestr(item, data)
for name, b in BYTES.items():
    if name not in names:
        zout.writestr(name, b, compress_type=zipfile.ZIP_STORED)
zout.close()
