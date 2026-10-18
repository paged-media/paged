#!/usr/bin/env python3
"""Write one table per built-in table style and variant into PowerPoint's
blank deck (fixture: tablestyles).

  python3 tablestyles.seed.py <blank.pptx> <seed.pptx>

Each of the 74 styles in slide-resolve/data/table-style-ids.tsv appears
twice, as 5 × 4 tables named "<id> A" and "<id> B":
  A: header row, total row, first and last column, banded rows — shows
     those parts and the corner cells;
  B: banded columns only — shows the whole-table and column-band parts.
Four tables per slide. PowerPoint then re-saves the deck (resave.applescript)."""
import os, re, sys, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
TSV = os.path.join(HERE, "../../slide-resolve/data/table-style-ids.tsv")
STYLES = [l.split("\t")[0] for l in open(TSV) if l.startswith("{")]
VARIANTS = [("A", "firstRow lastRow firstCol lastCol bandRow"), ("B", "bandCol")]
TABLES = [(sid, v, opts) for sid in STYLES for v, opts in VARIANTS]

EMU = 12700
COLS, ROWS = 4, 5
COL_W, ROW_H = 60 * EMU, 20 * EMU
SLOTS = [(40, 40), (500, 40), (40, 290), (500, 290)]


def table(shape_id, name, guid, options, x, y):
    flags = "".join(f' {o}="1"' for o in options.split())
    grid = "".join(f'<a:gridCol w="{COL_W}"/>' for _ in range(COLS))
    rows = []
    for r in range(ROWS):
        cells = "".join(
            f'<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1000"/>'
            f"<a:t>{'H' if r == 0 else 'R'}{r}{c}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>"
            for c in range(COLS)
        )
        rows.append(f'<a:tr h="{ROW_H}">{cells}</a:tr>')
    return (
        f'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="{shape_id}" name="{name}"/>'
        f'<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>'
        f'<p:xfrm><a:off x="{x * EMU}" y="{y * EMU}"/><a:ext cx="{COLS * COL_W}" cy="{ROWS * ROW_H}"/></p:xfrm>'
        f'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>'
        f'<a:tblPr{flags}><a:tableStyleId>{guid}</a:tableStyleId></a:tblPr><a:tblGrid>{grid}</a:tblGrid>'
        f'{"".join(rows)}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
    )


src, dst = sys.argv[1], sys.argv[2]
zin = zipfile.ZipFile(src)
zout = zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED)
for item in zin.infolist():
    data = zin.read(item.filename)
    m = re.match(r"ppt/slides/slide(\d+)\.xml$", item.filename)
    if m:
        n = int(m.group(1)) - 1
        chunk = TABLES[n * 4:(n + 1) * 4]
        frames = "".join(
            table(100 + k, f"{sid} {v}", sid, opts, *SLOTS[k]) for k, (sid, v, opts) in enumerate(chunk)
        )
        data = data.decode().replace("</p:spTree>", frames + "</p:spTree>", 1).encode()
    zout.writestr(item, data)
zout.close()
