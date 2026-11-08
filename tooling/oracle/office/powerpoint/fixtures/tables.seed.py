#!/usr/bin/env python3
"""Write the `tables` fixture's tables into PowerPoint's blank deck.

  python3 tables.seed.py <blank.pptx> <seed.pptx>

Two 4 × 4 tables per slide, each referencing a built-in table style by its
GUID with a set of style options (header row, total row, first/last column,
banded rows/columns). PowerPoint then re-saves the deck, writing the
definition of every style it recognises into ppt/tableStyles.xml; a GUID it
does not recognise is simply absent there, and the importer falls back."""
import re, sys, zipfile

TABLES = [
    # (style name, GUID, options)
    ("Medium Style 2 - Accent 1", "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}", "firstRow bandRow"),
    ("Medium Style 2 - Accent 1 all", "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}", "firstRow lastRow firstCol lastCol bandRow bandCol"),
    ("Light Style 1 - Accent 1", "{3B4B98B0-60AC-42C2-AFA5-B58CD77FA1E5}", "firstRow bandRow"),
    ("Light Style 3 - Accent 1", "{BC89EF96-8CEA-46FF-86C4-4CE0E7609802}", "firstRow bandRow"),
    ("Medium Style 1 - Accent 1", "{B301B821-A1FF-4177-AEE7-76D212191A09}", "firstRow bandRow"),
    ("Medium Style 3 - Accent 1", "{6E25E649-3F16-4E02-A733-19D2CDBF48F0}", "firstRow bandRow"),
    ("Medium Style 4 - Accent 1", "{69CF1AB2-1976-4502-BF36-3FF5EA218861}", "firstRow bandRow"),
    ("Dark Style 1", "{E8034E78-7F5D-4C2E-B375-FC64B27BC917}", "firstRow bandRow"),
    ("Dark Style 2", "{5202B0CA-FC54-4496-8BCA-5EF66A818D29}", "firstRow bandRow"),
    ("No Style, Table Grid", "{5940675A-B579-460E-94D1-54222C63F5DA}", "firstRow bandRow"),
    ("Medium Style 2 - Accent 2 columns", "{21E4AEA4-8DFA-4A89-87EB-49C32662AFE8}", "bandCol firstCol"),
    ("Medium Style 2 no options", "{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}", ""),
]

EMU = 12700
COL_W, ROW_H = 100 * EMU, 30 * EMU


def table(shape_id, name, guid, options, x, y):
    flags = "".join(f' {o}="1"' for o in options.split())
    grid = "".join(f'<a:gridCol w="{COL_W}"/>' for _ in range(4))
    rows = []
    for r in range(4):
        cells = []
        for c in range(4):
            text = ["Region", "North", "South", "Total"][r] if c == 0 else f"{(r + 1) * (c + 2) * 7}"
            cells.append(
                f'<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>{text}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>'
            )
        rows.append(f'<a:tr h="{ROW_H}">{"".join(cells)}</a:tr>')
    return (
        f'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="{shape_id}" name="{name}"/>'
        f'<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>'
        f'<p:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{4 * COL_W}" cy="{4 * ROW_H}"/></p:xfrm>'
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
    if m and int(m.group(1)) <= len(TABLES) // 2:
        n = int(m.group(1))
        xml = data.decode()
        frames = "".join(
            table(100 + k, TABLES[2 * (n - 1) + k][0], TABLES[2 * (n - 1) + k][1], TABLES[2 * (n - 1) + k][2],
                  (40 + k * 460) * EMU, 120 * EMU)
            for k in range(2)
        )
        xml = xml.replace("</p:spTree>", frames + "</p:spTree>", 1)
        data = xml.encode()
    zout.writestr(item, data)
zout.close()
