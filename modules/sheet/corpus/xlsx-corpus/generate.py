#!/usr/bin/env python3
# Reproducible XLSX fixtures for sheet-xlsx conformance (spec §10).
#
# stdlib only (zipfile + hand-authored XML strings; no openpyxl/xlsxwriter)
# so the corpus is auditable byte-for-byte and has no external deps. Each
# fixture targets a specific parse/preservation feature; the docstring on
# each builder records what it exercises. Run:
#
#     python3 corpus/xlsx-corpus/generate.py
#
# Regenerates all *.xlsx fixtures in this directory deterministically (fixed
# zip member order + a fixed timestamp so the bytes are stable across runs).

import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
# Fixed DOS timestamp (1980-01-01 00:00:00) so re-running is byte-stable.
FIXED_DATE = (1980, 1, 1, 0, 0, 0)

XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types"
NS_REL = "http://schemas.openxmlformats.org/package/2006/relationships"

CT_WORKBOOK = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
CT_WORKSHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
CT_SHARED = "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"
CT_STYLES = "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"
CT_CALCCHAIN = "application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"
CT_RELS = "application/vnd.openxmlformats-package.relationships+xml"
CT_XML = "application/xml"
CT_VML = "application/vnd.openxmlformats-officedocument.vmlDrawing"
CT_TABLE = "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"
CT_DRAWING = "application/vnd.openxmlformats-officedocument.drawing+xml"
CT_CHART = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"
CT_EXTLINK = "application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"

RT_OFFICE_DOC = NS_R + "/officeDocument"
RT_WORKSHEET = NS_R + "/worksheet"
RT_SHARED = NS_R + "/sharedStrings"
RT_STYLES = NS_R + "/styles"
RT_CALCCHAIN = NS_R + "/calcChain"
RT_TABLE = NS_R + "/table"
RT_DRAWING = NS_R + "/drawing"
RT_CHART = NS_R + "/chart"
RT_EXTLINK = NS_R + "/externalLink"
# An external-link part's OWN rel to the (never-opened) source workbook file —
# an OPC EXTERNAL relationship (TargetMode="External"). We store the URI but
# NEVER resolve it: external links are not followed (spec §1.1).
RT_EXTLINK_PATH = NS_R + "/externalLinkPath"

# DrawingML chart namespaces.
NS_C = "http://schemas.openxmlformats.org/drawingml/2006/chart"
NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS_XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"


def write_zip(path, members):
    """Write `members` (list of (name, str_body)) in order, deterministically."""
    full = os.path.join(HERE, path)
    with zipfile.ZipFile(full, "w", zipfile.ZIP_DEFLATED) as z:
        for name, body in members:
            info = zipfile.ZipInfo(name, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, body)
    print("wrote", path)


def content_types(overrides):
    """overrides: list of (partname, contenttype)."""
    s = XML_DECL + f'<Types xmlns="{NS_CT}">'
    s += f'<Default Extension="rels" ContentType="{CT_RELS}"/>'
    s += f'<Default Extension="xml" ContentType="{CT_XML}"/>'
    for pn, ct in overrides:
        s += f'<Override PartName="{pn}" ContentType="{ct}"/>'
    s += "</Types>"
    return s


def root_rels():
    return (
        XML_DECL
        + f'<Relationships xmlns="{NS_REL}">'
        + f'<Relationship Id="rId1" Type="{RT_OFFICE_DOC}" Target="xl/workbook.xml"/>'
        + "</Relationships>"
    )


def workbook(sheets, date1904=False, defined_names=None, external_refs=None):
    """sheets: list of (name, sheetId, rId). defined_names: list of
    (name, text, localSheetId|None). external_refs: list of rId (the
    <externalReferences> order = the [n] external-book index, M3 spec §13)."""
    s = XML_DECL
    s += f'<workbook xmlns="{NS_MAIN}" xmlns:r="{NS_R}">'
    if date1904:
        s += '<workbookPr date1904="1"/>'
    s += "<sheets>"
    for name, sid, rid in sheets:
        s += f'<sheet name="{name}" sheetId="{sid}" r:id="{rid}"/>'
    s += "</sheets>"
    if defined_names:
        s += "<definedNames>"
        for nm, text, local in defined_names:
            if local is None:
                s += f'<definedName name="{nm}">{text}</definedName>'
            else:
                s += f'<definedName name="{nm}" localSheetId="{local}">{text}</definedName>'
        s += "</definedNames>"
    if external_refs:
        s += "<externalReferences>"
        for rid in external_refs:
            s += f'<externalReference r:id="{rid}"/>'
        s += "</externalReferences>"
    s += "</workbook>"
    return s


def workbook_rels(rels):
    """rels: list of (rId, type, target)."""
    s = XML_DECL + f'<Relationships xmlns="{NS_REL}">'
    for rid, ty, tgt in rels:
        s += f'<Relationship Id="{rid}" Type="{ty}" Target="{tgt}"/>'
    s += "</Relationships>"
    return s


def shared_strings(items):
    """items: list of str OR list-of-runs (list of str) for rich text."""
    s = XML_DECL
    s += f'<sst xmlns="{NS_MAIN}" count="{len(items)}" uniqueCount="{len(items)}">'
    for it in items:
        if isinstance(it, list):
            s += "<si>"
            for run in it:
                s += f"<r><t>{run}</t></r>"
            s += "</si>"
        else:
            s += f"<si><t>{it}</t></si>"
    s += "</sst>"
    return s


def styles(num_fmts=None, cell_xfs=None, dxfs=None):
    """num_fmts: list of (id, code). cell_xfs: list of dicts with
    numFmtId/fontId/fillId/borderId. dxfs: list of pre-rendered <dxf>...</dxf>
    body strings (the differential formats a cfRule dxfId references)."""
    num_fmts = num_fmts or []
    cell_xfs = cell_xfs or [dict(numFmtId=0, fontId=0, fillId=0, borderId=0)]
    s = XML_DECL + f'<styleSheet xmlns="{NS_MAIN}">'
    if num_fmts:
        s += f'<numFmts count="{len(num_fmts)}">'
        for i, code in num_fmts:
            s += f'<numFmt numFmtId="{i}" formatCode="{code}"/>'
        s += "</numFmts>"
    s += '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
    s += '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
    s += '<fills count="3"><fill><patternFill patternType="none"/></fill>'
    s += '<fill><patternFill patternType="gray125"/></fill>'
    s += '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills>'
    s += '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
    s += '<border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border></borders>'
    s += '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    s += f'<cellXfs count="{len(cell_xfs)}">'
    for xf in cell_xfs:
        s += (
            f'<xf numFmtId="{xf["numFmtId"]}" fontId="{xf["fontId"]}" '
            f'fillId="{xf["fillId"]}" borderId="{xf["borderId"]}" xfId="0" applyNumberFormat="1"/>'
        )
    s += "</cellXfs>"
    if dxfs:
        s += f'<dxfs count="{len(dxfs)}">'
        for body in dxfs:
            s += body
        s += "</dxfs>"
    s += "</styleSheet>"
    return s


def calc_chain(cells):
    """cells: list of (ref, sheetId)."""
    s = XML_DECL + f'<calcChain xmlns="{NS_MAIN}">'
    for ref, sid in cells:
        s += f'<c r="{ref}" i="{sid}"/>'
    s += "</calcChain>"
    return s


# --- worksheet body builders -------------------------------------------------

def ws(dimension, rows_xml, extras_before="", extras_after="", merges=None, cols=None):
    s = XML_DECL + f'<worksheet xmlns="{NS_MAIN}" xmlns:r="{NS_R}">'
    s += extras_before
    if dimension:
        s += f'<dimension ref="{dimension}"/>'
    if cols:
        s += "<cols>" + cols + "</cols>"
    s += "<sheetData>" + rows_xml + "</sheetData>"
    if merges:
        s += f'<mergeCells count="{len(merges)}">'
        for m in merges:
            s += f'<mergeCell ref="{m}"/>'
        s += "</mergeCells>"
    s += extras_after
    s += "</worksheet>"
    return s


# --- fixtures ---------------------------------------------------------------

def gen_01_minimal():
    """01: 3 cells, inline values only (number, inlineStr, number). No
    sharedStrings/styles parts at all — the smallest valid workbook."""
    rows = (
        '<row r="1">'
        '<c r="A1" t="n"><v>1</v></c>'
        '<c r="B1" t="inlineStr"><is><t>hello</t></is></c>'
        '<c r="C1" t="n"><v>3.14</v></c>'
        "</row>"
    )
    members = [
        ("[Content_Types].xml", content_types([
            ("/xl/workbook.xml", CT_WORKBOOK),
            ("/xl/worksheets/sheet1.xml", CT_WORKSHEET),
        ])),
        ("_rels/.rels", root_rels()),
        ("xl/workbook.xml", workbook([("Sheet1", 1, "rId1")])),
        ("xl/_rels/workbook.xml.rels", workbook_rels([
            ("rId1", RT_WORKSHEET, "worksheets/sheet1.xml"),
        ])),
        ("xl/worksheets/sheet1.xml", ws("A1:C1", rows)),
    ]
    write_zip("01-minimal.xlsx", members)


def gen_02_formulas():
    """02: formulas with cached values + sharedStrings + a calcChain.
    A1=2, A2=3, A3=SUM(A1:A2)=5, B1 is a shared string label."""
    rows = (
        '<row r="1"><c r="A1" t="n"><v>2</v></c>'
        '<c r="B1" t="s"><v>0</v></c></row>'
        '<row r="2"><c r="A2" t="n"><v>3</v></c>'
        '<c r="B2" t="s"><v>1</v></c></row>'
        '<row r="3"><c r="A3" t="n"><f>SUM(A1:A2)</f><v>5</v></c>'
        '<c r="B3" t="str"><f>B1&amp;B2</f><v>SumProduct</v></c></row>'
    )
    members = [
        ("[Content_Types].xml", content_types([
            ("/xl/workbook.xml", CT_WORKBOOK),
            ("/xl/worksheets/sheet1.xml", CT_WORKSHEET),
            ("/xl/sharedStrings.xml", CT_SHARED),
            ("/xl/calcChain.xml", CT_CALCCHAIN),
        ])),
        ("_rels/.rels", root_rels()),
        ("xl/workbook.xml", workbook([("Sheet1", 1, "rId1")])),
        ("xl/_rels/workbook.xml.rels", workbook_rels([
            ("rId1", RT_WORKSHEET, "worksheets/sheet1.xml"),
            ("rId2", RT_SHARED, "sharedStrings.xml"),
            ("rId3", RT_CALCCHAIN, "calcChain.xml"),
        ])),
        ("xl/sharedStrings.xml", shared_strings(["Sum", "Product"])),
        ("xl/worksheets/sheet1.xml", ws("A1:B3", rows)),
        ("xl/calcChain.xml", calc_chain([("A3", 1), ("B3", 1)])),
    ]
    write_zip("02-formulas.xlsx", members)


def gen_03_styles():
    """03: custom numFmts (id>=164) + built-in numFmt ids + merges + col
    widths + custom row heights. Exercises the styles + geometry parse."""
    num_fmts = [(164, '&quot;$&quot;#,##0.00'), (165, "0.000%")]
    cell_xfs = [
        dict(numFmtId=0, fontId=0, fillId=0, borderId=0),   # 0: General
        dict(numFmtId=2, fontId=1, fillId=0, borderId=1),   # 1: built-in 0.00, bold, border
        dict(numFmtId=164, fontId=0, fillId=2, borderId=0), # 2: custom $#,##0.00, yellow fill
        dict(numFmtId=9, fontId=0, fillId=0, borderId=0),   # 3: built-in 0%
        dict(numFmtId=165, fontId=0, fillId=0, borderId=0), # 4: custom 0.000%
    ]
    rows = (
        '<row r="1" ht="28.5" customHeight="1">'
        '<c r="A1" s="1" t="n"><v>1234.5</v></c>'
        '<c r="B1" s="2" t="n"><v>9999.99</v></c>'
        '<c r="C1" s="3" t="n"><v>0.25</v></c>'
        "</row>"
        '<row r="2">'
        '<c r="A2" s="4" t="n"><v>0.12345</v></c>'
        "</row>"
    )
    cols = (
        '<col min="1" max="1" width="18.5" customWidth="1"/>'
        '<col min="2" max="3" width="12.0" customWidth="1"/>'
    )
    members = [
        ("[Content_Types].xml", content_types([
            ("/xl/workbook.xml", CT_WORKBOOK),
            ("/xl/worksheets/sheet1.xml", CT_WORKSHEET),
            ("/xl/styles.xml", CT_STYLES),
        ])),
        ("_rels/.rels", root_rels()),
        ("xl/workbook.xml", workbook([("Sheet1", 1, "rId1")])),
        ("xl/_rels/workbook.xml.rels", workbook_rels([
            ("rId1", RT_WORKSHEET, "worksheets/sheet1.xml"),
            ("rId2", RT_STYLES, "styles.xml"),
        ])),
        ("xl/styles.xml", styles(num_fmts, cell_xfs)),
        ("xl/worksheets/sheet1.xml", ws("A1:C2", rows, merges=["A1:A2"], cols=cols)),
    ]
    write_zip("03-styles.xlsx", members)


def gen_04_unknown_parts():
    """04: a customXml part + a fake vbaProject.bin + a calcChain. The
    customXml + vba bytes MUST survive byte-identical (preservation of
    unknown PARTS); calcChain MUST drop on save."""
    rows = '<row r="1"><c r="A1" t="n"><v>7</v></c></row>'
    fake_vba = "MZ\x00\x00fake-vba-project-bytes-\x01\x02\x03not-executed"
    custom_xml = '<?xml version="1.0"?><myData xmlns="urn:example:custom"><field>preserved</field></myData>'
    members = [
        ("[Content_Types].xml", content_types([
            ("/xl/workbook.xml", CT_WORKBOOK),
            ("/xl/worksheets/sheet1.xml", CT_WORKSHEET),
            ("/xl/calcChain.xml", CT_CALCCHAIN),
            ("/customXml/item1.xml", CT_XML),
            ("/xl/vbaProject.bin", "application/vnd.ms-office.vbaProject"),
        ])),
        ("_rels/.rels", root_rels()),
        ("xl/workbook.xml", workbook([("Sheet1", 1, "rId1")])),
        ("xl/_rels/workbook.xml.rels", workbook_rels([
            ("rId1", RT_WORKSHEET, "worksheets/sheet1.xml"),
            ("rId3", RT_CALCCHAIN, "calcChain.xml"),
        ])),
        ("customXml/item1.xml", custom_xml),
        ("xl/vbaProject.bin", fake_vba),
        ("xl/worksheets/sheet1.xml", ws("A1:A1", rows)),
        ("xl/calcChain.xml", calc_chain([("A1", 1)])),
    ]
    write_zip("04-unknown-parts.xlsx", members)


def gen_05_unknown_subtrees():
    """05: a worksheet with unknown <worksheet> children (sheetPr before
    sheetData, conditionalFormatting + extLst after) + unknown per-cell
    attrs. The subtrees survive a dirty re-encode; per-cell unknown attrs
    survive only via lazy-verbatim (T0 granularity)."""
    rows = (
        '<row r="1">'
        '<c r="A1" t="n" customUnknownAttr="keepme"><v>10</v></c>'
        '<c r="B1" t="n"><v>20</v></c>'
        "</row>"
    )
    before = '<sheetPr><tabColor rgb="FFFF0000"/></sheetPr>'
    after = (
        '<conditionalFormatting sqref="A1:B1">'
        '<cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>5</formula></cfRule>'
        "</conditionalFormatting>"
        '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
        '<extLst><ext uri="{EXAMPLE-EXT}"><x:future xmlns:x="urn:x"/></ext></extLst>'
    )
    members = [
        ("[Content_Types].xml", content_types([
            ("/xl/workbook.xml", CT_WORKBOOK),
            ("/xl/worksheets/sheet1.xml", CT_WORKSHEET),
        ])),
        ("_rels/.rels", root_rels()),
        ("xl/workbook.xml", workbook([("Sheet1", 1, "rId1")])),
        ("xl/_rels/workbook.xml.rels", workbook_rels([
            ("rId1", RT_WORKSHEET, "worksheets/sheet1.xml"),
        ])),
        ("xl/worksheets/sheet1.xml",
         ws("A1:B1", rows, extras_before=before, extras_after=after)),
    ]
    write_zip("05-unknown-subtrees.xlsx", members)


def gen_06_multisheet_1904():
    """06: 3 sheets, definedNames, date1904=1. Exercises multi-sheet order,
    the 1904 epoch flag, and workbook + sheet-scoped defined names."""
    sheets = [("Summary", 1, "rId1"), ("Data", 2, "rId2"), ("Notes", 3, "rId3")]
    names = [
        ("TaxRate", "0.2", None),
        ("DataRange", "Data!$A$1:$A$3", None),
        ("LocalName", "Notes!$B$2", 2),
    ]
    s1 = ws("A1:A1", '<row r="1"><c r="A1" t="n"><v>100</v></c></row>')
    s2 = ws("A1:A3",
            '<row r="1"><c r="A1" t="n"><v>1</v></c></row>'
            '<row r="2"><c r="A2" t="n"><v>2</v></c></row>'
            '<row r="3"><c r="A3" t="n"><v>3</v></c></row>')
    s3 = ws("B2:B2", '<row r="2"><c r="B2" t="inlineStr"><is><t>note</t></is></c></row>')
    members = [
        ("[Content_Types].xml", content_types([
            ("/xl/workbook.xml", CT_WORKBOOK),
            ("/xl/worksheets/sheet1.xml", CT_WORKSHEET),
            ("/xl/worksheets/sheet2.xml", CT_WORKSHEET),
            ("/xl/worksheets/sheet3.xml", CT_WORKSHEET),
        ])),
        ("_rels/.rels", root_rels()),
        ("xl/workbook.xml", workbook(sheets, date1904=True, defined_names=names)),
        ("xl/_rels/workbook.xml.rels", workbook_rels([
            ("rId1", RT_WORKSHEET, "worksheets/sheet1.xml"),
            ("rId2", RT_WORKSHEET, "worksheets/sheet2.xml"),
            ("rId3", RT_WORKSHEET, "worksheets/sheet3.xml"),
        ])),
        ("xl/worksheets/sheet1.xml", s1),
        ("xl/worksheets/sheet2.xml", s2),
        ("xl/worksheets/sheet3.xml", s3),
    ]
    write_zip("06-multisheet-1904.xlsx", members)


def gen_07_tables():
    """07: a real Excel structured table (ListObject). Sheet1!A1:C4 is the
    `Sales` table — header row (Region/Units/Total) + 3 data rows. E1 carries a
    structured-reference formula `=SUM(Sales[Units])` with a cached value (60).
    The worksheet lists the table via <tableParts>, its .rels points at
    xl/tables/table1.xml, and that part defines name/ref/columns. Exercises:
    table-part parse, the worksheet→table relationship, structured-ref formula
    text capture, and round-trip preservation of the table part."""
    rows = (
        '<row r="1">'
        '<c r="A1" t="inlineStr"><is><t>Region</t></is></c>'
        '<c r="B1" t="inlineStr"><is><t>Units</t></is></c>'
        '<c r="C1" t="inlineStr"><is><t>Total</t></is></c>'
        '<c r="E1" t="n"><f>SUM(Sales[Units])</f><v>60</v></c>'
        "</row>"
        '<row r="2">'
        '<c r="A2" t="inlineStr"><is><t>North</t></is></c>'
        '<c r="B2" t="n"><v>10</v></c><c r="C2" t="n"><v>100</v></c></row>'
        '<row r="3">'
        '<c r="A3" t="inlineStr"><is><t>South</t></is></c>'
        '<c r="B3" t="n"><v>20</v></c><c r="C3" t="n"><v>200</v></c></row>'
        '<row r="4">'
        '<c r="A4" t="inlineStr"><is><t>East</t></is></c>'
        '<c r="B4" t="n"><v>30</v></c><c r="C4" t="n"><v>300</v></c></row>'
    )
    # The worksheet references its table parts; <tableParts> is an unknown
    # child to sheet-xlsx (captured verbatim) so it survives round-trip.
    table_parts = '<tableParts count="1"><tablePart r:id="rId1"/></tableParts>'
    sheet1 = ws("A1:E4", rows, extras_after=table_parts)

    table1 = (
        XML_DECL
        + f'<table xmlns="{NS_MAIN}" id="1" name="Sales" displayName="Sales" '
        'ref="A1:C4" totalsRowShown="0">'
        '<autoFilter ref="A1:C4"/>'
        '<tableColumns count="3">'
        '<tableColumn id="1" name="Region"/>'
        '<tableColumn id="2" name="Units"/>'
        '<tableColumn id="3" name="Total"/>'
        "</tableColumns>"
        '<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" '
        'showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>'
        "</table>"
    )
    sheet1_rels = workbook_rels([
        ("rId1", RT_TABLE, "../tables/table1.xml"),
    ])

    members = [
        ("[Content_Types].xml", content_types([
            ("/xl/workbook.xml", CT_WORKBOOK),
            ("/xl/worksheets/sheet1.xml", CT_WORKSHEET),
            ("/xl/tables/table1.xml", CT_TABLE),
        ])),
        ("_rels/.rels", root_rels()),
        ("xl/workbook.xml", workbook([("Sheet1", 1, "rId1")])),
        ("xl/_rels/workbook.xml.rels", workbook_rels([
            ("rId1", RT_WORKSHEET, "worksheets/sheet1.xml"),
        ])),
        ("xl/worksheets/sheet1.xml", sheet1),
        ("xl/worksheets/_rels/sheet1.xml.rels", sheet1_rels),
        ("xl/tables/table1.xml", table1),
    ]
    write_zip("07-tables.xlsx", members)


def gen_08_condfmt():
    """08: conditional formatting lowered to style overrides (spec §10.4, M2).
    Sheet1 carries four cf blocks over distinct columns so each rule kind is
    exercised independently:

      A1:A5  cellIs greaterThan 5  -> dxf 0 (bold + red text + yellow fill)
      B1:B5  expression  B1>100    -> dxf 1 (green fill)   [reducible form]
      C1:C5  2-colour scale  white -> red   over the column's value domain
      D1:D5  dataBar  (drawn-rect track; lowers to Preserved in the style path)
      E1:E5  iconSet  (preserve-only T2 floor)

    The <conditionalFormatting> children are unknown to the worksheet parser, so
    they round-trip via the verbatim capture; the cf MODEL is parsed additively.
    Values are chosen so specific cells match (A1=8>5, A3=10>5; B1=150>100)."""
    rows = (
        '<row r="1">'
        '<c r="A1" t="n"><v>8</v></c>'
        '<c r="B1" t="n"><v>150</v></c>'
        '<c r="C1" t="n"><v>0</v></c>'
        '<c r="D1" t="n"><v>10</v></c>'
        '<c r="E1" t="n"><v>1</v></c>'
        "</row>"
        '<row r="2">'
        '<c r="A2" t="n"><v>3</v></c>'
        '<c r="B2" t="n"><v>50</v></c>'
        '<c r="C2" t="n"><v>50</v></c>'
        '<c r="D2" t="n"><v>40</v></c>'
        '<c r="E2" t="n"><v>2</v></c>'
        "</row>"
        '<row r="3">'
        '<c r="A3" t="n"><v>10</v></c>'
        '<c r="B3" t="n"><v>200</v></c>'
        '<c r="C3" t="n"><v>100</v></c>'
        '<c r="D3" t="n"><v>70</v></c>'
        '<c r="E3" t="n"><v>3</v></c>'
        "</row>"
        '<row r="4">'
        '<c r="A4" t="n"><v>5</v></c>'
        '<c r="B4" t="n"><v>99</v></c>'
        '<c r="C4" t="n"><v>25</v></c>'
        '<c r="D4" t="n"><v>20</v></c>'
        '<c r="E4" t="n"><v>2</v></c>'
        "</row>"
        '<row r="5">'
        '<c r="A5" t="n"><v>7</v></c>'
        '<c r="B5" t="n"><v>120</v></c>'
        '<c r="C5" t="n"><v>75</v></c>'
        '<c r="D5" t="n"><v>90</v></c>'
        '<c r="E5" t="n"><v>1</v></c>'
        "</row>"
    )
    cf = (
        '<conditionalFormatting sqref="A1:A5">'
        '<cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>5</formula></cfRule>'
        "</conditionalFormatting>"
        '<conditionalFormatting sqref="B1:B5">'
        '<cfRule type="expression" dxfId="1" priority="2"><formula>B1&gt;100</formula></cfRule>'
        "</conditionalFormatting>"
        '<conditionalFormatting sqref="C1:C5">'
        '<cfRule type="colorScale" priority="3"><colorScale>'
        '<cfvo type="min"/><cfvo type="max"/>'
        '<color rgb="FFFFFFFF"/><color rgb="FFFF0000"/>'
        "</colorScale></cfRule>"
        "</conditionalFormatting>"
        '<conditionalFormatting sqref="D1:D5">'
        '<cfRule type="dataBar" priority="4"><dataBar>'
        '<cfvo type="min"/><cfvo type="max"/><color rgb="FF638EC6"/>'
        "</dataBar></cfRule>"
        "</conditionalFormatting>"
        '<conditionalFormatting sqref="E1:E5">'
        '<cfRule type="iconSet" priority="5"><iconSet iconSet="3TrafficLights1">'
        '<cfvo type="percent" val="0"/><cfvo type="percent" val="33"/><cfvo type="percent" val="67"/>'
        "</iconSet></cfRule>"
        "</conditionalFormatting>"
    )
    # dxf 0: bold + red text + yellow fill (bgColor — the dxf convention).
    # dxf 1: green fill.
    dxfs = [
        (
            "<dxf>"
            '<font><b/><color rgb="FFFF0000"/></font>'
            '<fill><patternFill><bgColor rgb="FFFFFF00"/></patternFill></fill>'
            "</dxf>"
        ),
        "<dxf><fill><patternFill><bgColor rgb="
        '"FF00FF00"/></patternFill></fill></dxf>',
    ]
    sheet1 = ws("A1:E5", rows, extras_after=cf)
    members = [
        ("[Content_Types].xml", content_types([
            ("/xl/workbook.xml", CT_WORKBOOK),
            ("/xl/worksheets/sheet1.xml", CT_WORKSHEET),
            ("/xl/styles.xml", CT_STYLES),
        ])),
        ("_rels/.rels", root_rels()),
        ("xl/workbook.xml", workbook([("Sheet1", 1, "rId1")])),
        ("xl/_rels/workbook.xml.rels", workbook_rels([
            ("rId1", RT_WORKSHEET, "worksheets/sheet1.xml"),
            ("rId2", RT_STYLES, "styles.xml"),
        ])),
        ("xl/styles.xml", styles(dxfs=dxfs)),
        ("xl/worksheets/sheet1.xml", sheet1),
    ]
    write_zip("08-condfmt.xlsx", members)


def gen_09_chart():
    """09: a DrawingML chart (M2 charts track, spec §8.4). Sheet1!A1:B4 holds a
    category column (A: Q1/Q2/Q3) + a value column (B: 10/20/30) with a header
    row (A1=Region, B1=Revenue). The worksheet references a drawing via
    <drawing r:id>; the drawing anchors a graphicFrame to chart1.xml; chart1.xml
    is a column barChart with ONE series bound to Sheet1!$B$2:$B$4 (values) and
    Sheet1!$A$2:$A$4 (categories), a cached series title 'Revenue', a series
    fill (#3366CC), a chart title 'Q1 Revenue', and a legend. Exercises:
    chart-part parse into ChartModel (kind/series/title/legend/color), the
    worksheet→drawing→chart relationship chain, range-ref resolution, and
    round-trip preservation of the OPAQUE drawing + chart parts (+ the captured
    <drawing> worksheet child)."""
    rows = (
        '<row r="1">'
        '<c r="A1" t="inlineStr"><is><t>Region</t></is></c>'
        '<c r="B1" t="inlineStr"><is><t>Revenue</t></is></c>'
        "</row>"
        '<row r="2">'
        '<c r="A2" t="inlineStr"><is><t>Q1</t></is></c>'
        '<c r="B2" t="n"><v>10</v></c></row>'
        '<row r="3">'
        '<c r="A3" t="inlineStr"><is><t>Q2</t></is></c>'
        '<c r="B3" t="n"><v>20</v></c></row>'
        '<row r="4">'
        '<c r="A4" t="inlineStr"><is><t>Q3</t></is></c>'
        '<c r="B4" t="n"><v>30</v></c></row>'
    )
    # The worksheet's <drawing> child is unknown to the parser → captured
    # verbatim (round-trips byte-identical).
    drawing_ref = '<drawing r:id="rId1"/>'
    sheet1 = ws("A1:B4", rows, extras_after=drawing_ref)
    sheet1_rels = workbook_rels([("rId1", RT_DRAWING, "../drawings/drawing1.xml")])

    # The drawing: a two-cell anchor holding a graphicFrame that references the
    # chart part through the drawing's OWN rels (r:id rId1 → chart1.xml).
    drawing1 = (
        XML_DECL
        + f'<xdr:wsDr xmlns:xdr="{NS_XDR}" xmlns:a="{NS_A}" xmlns:r="{NS_R}">'
        "<xdr:twoCellAnchor>"
        "<xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff>"
        "<xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>"
        "<xdr:to><xdr:col>10</xdr:col><xdr:colOff>0</xdr:colOff>"
        "<xdr:row>15</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>"
        "<xdr:graphicFrame><xdr:nvGraphicFramePr>"
        '<xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/>'
        "</xdr:nvGraphicFramePr>"
        "<xdr:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/></xdr:xfrm>"
        '<a:graphic><a:graphicData uri="' + NS_C + '">'
        f'<c:chart xmlns:c="{NS_C}" r:id="rId1"/>'
        "</a:graphicData></a:graphic></xdr:graphicFrame>"
        "<xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>"
    )
    drawing1_rels = workbook_rels([("rId1", RT_CHART, "../charts/chart1.xml")])

    # The chart: a column barChart, one series bound to Sheet1 ranges, a cached
    # series title + color, a chart title, and a legend.
    chart1 = (
        XML_DECL
        + f'<c:chartSpace xmlns:c="{NS_C}" xmlns:a="{NS_A}" xmlns:r="{NS_R}">'
        "<c:chart>"
        "<c:title><c:tx><c:rich><a:p><a:r><a:t>Q1 Revenue</a:t></a:r></a:p>"
        "</c:rich></c:tx></c:title>"
        "<c:plotArea>"
        "<c:barChart><c:barDir val=\"col\"/><c:grouping val=\"clustered\"/>"
        "<c:ser><c:idx val=\"0\"/><c:order val=\"0\"/>"
        "<c:tx><c:strRef><c:f>Sheet1!$B$1</c:f>"
        '<c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Revenue</c:v></c:pt>'
        "</c:strCache></c:strRef></c:tx>"
        "<c:spPr><a:solidFill><a:srgbClr val=\"3366CC\"/></a:solidFill></c:spPr>"
        "<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$4</c:f>"
        '<c:strCache><c:ptCount val="3"/>'
        '<c:pt idx="0"><c:v>Q1</c:v></c:pt>'
        '<c:pt idx="1"><c:v>Q2</c:v></c:pt>'
        '<c:pt idx="2"><c:v>Q3</c:v></c:pt></c:strCache></c:strRef></c:cat>'
        "<c:val><c:numRef><c:f>Sheet1!$B$2:$B$4</c:f>"
        '<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="3"/>'
        '<c:pt idx="0"><c:v>10</c:v></c:pt>'
        '<c:pt idx="1"><c:v>20</c:v></c:pt>'
        '<c:pt idx="2"><c:v>30</c:v></c:pt></c:numCache></c:numRef></c:val>'
        "</c:ser>"
        '<c:axId val="1"/><c:axId val="2"/>'
        "</c:barChart>"
        "</c:plotArea>"
        '<c:legend><c:legendPos val="r"/></c:legend>'
        "</c:chart></c:chartSpace>"
    )

    members = [
        ("[Content_Types].xml", content_types([
            ("/xl/workbook.xml", CT_WORKBOOK),
            ("/xl/worksheets/sheet1.xml", CT_WORKSHEET),
            ("/xl/drawings/drawing1.xml", CT_DRAWING),
            ("/xl/charts/chart1.xml", CT_CHART),
        ])),
        ("_rels/.rels", root_rels()),
        ("xl/workbook.xml", workbook([("Sheet1", 1, "rId1")])),
        ("xl/_rels/workbook.xml.rels", workbook_rels([
            ("rId1", RT_WORKSHEET, "worksheets/sheet1.xml"),
        ])),
        ("xl/worksheets/sheet1.xml", sheet1),
        ("xl/worksheets/_rels/sheet1.xml.rels", sheet1_rels),
        ("xl/drawings/drawing1.xml", drawing1),
        ("xl/drawings/_rels/drawing1.xml.rels", drawing1_rels),
        ("xl/charts/chart1.xml", chart1),
    ]
    write_zip("09-chart.xlsx", members)


def gen_10_extlink():
    """10: external-workbook link reads (M3, spec §13; the no-network ruling
    §1.1). The workbook declares ONE <externalReference> (the [1] external
    book); workbook.xml.rels maps it to xl/externalLinks/externalLink1.xml,
    whose CACHED snapshot holds the last-known values of a referenced (but NOT
    embedded) workbook 'budget.xlsx' — sheet 'Sheet1' (A1=42 number, B1='hello'
    str, A2=TRUE bool, B2=#DIV/0! error) and sheet 'Costs' (C3=3.5).

    Sheet1!A1 of THIS workbook holds the local formula =[1]Sheet1!A1; Excel
    stores its CACHED result (42) inline in the cell's own <v>, so the cell
    DISPLAYS 42 with no AST support (the frozen parser never sees the [1]
    prefix). A2 references the external book too (=[1]Sheet1!B2) with cached
    #DIV/0!.

    The external-link part's OWN .rels points at the source workbook with
    TargetMode='External' — a URI we record but NEVER resolve (no network, no
    file access). Exercises: <externalReferences> parse, externalLink1.xml
    cached-value parse, the cached-value read, the documented #REF! fallback for
    an un-cached cell, and round-trip preservation of the OPAQUE externalLink
    part + its external .rels."""
    # Local sheet: two formula cells whose CACHED results are stored inline.
    rows = (
        '<row r="1">'
        '<c r="A1" t="n"><f>[1]Sheet1!A1</f><v>42</v></c>'
        "</row>"
        '<row r="2">'
        '<c r="A2" t="e"><f>[1]Sheet1!B2</f><v>#DIV/0!</v></c>'
        "</row>"
    )
    sheet1 = ws("A1:A2", rows)

    # The external-link part: cached sheet names + cached cell values. NO source
    # workbook is embedded; this inline cache is all we ever read.
    extlink1 = (
        XML_DECL
        + f'<externalLink xmlns="{NS_MAIN}" xmlns:r="{NS_R}">'
        '<externalBook r:id="rId1">'
        "<sheetNames>"
        '<sheetName val="Sheet1"/>'
        '<sheetName val="Costs"/>'
        "</sheetNames>"
        "<sheetDataSet>"
        '<sheetData sheetId="0">'
        '<row r="1">'
        '<cell r="A1"><v>42</v></cell>'
        '<cell r="B1" t="str"><v>hello</v></cell>'
        "</row>"
        '<row r="2">'
        '<cell r="A2" t="b"><v>1</v></cell>'
        '<cell r="B2" t="e"><v>#DIV/0!</v></cell>'
        "</row>"
        "</sheetData>"
        '<sheetData sheetId="1">'
        '<row r="3"><cell r="C3" t="n"><v>3.5</v></cell></row>'
        "</sheetData>"
        "</sheetDataSet>"
        "</externalBook>"
        "</externalLink>"
    )
    # The external-link part's rels: the (never-opened) source workbook, marked
    # TargetMode="External". We store the URI but never resolve it (§1.1).
    extlink1_rels = (
        XML_DECL
        + f'<Relationships xmlns="{NS_REL}">'
        f'<Relationship Id="rId1" Type="{RT_EXTLINK_PATH}" '
        'Target="file:///C:/budgets/budget.xlsx" TargetMode="External"/>'
        "</Relationships>"
    )

    members = [
        ("[Content_Types].xml", content_types([
            ("/xl/workbook.xml", CT_WORKBOOK),
            ("/xl/worksheets/sheet1.xml", CT_WORKSHEET),
            ("/xl/externalLinks/externalLink1.xml", CT_EXTLINK),
        ])),
        ("_rels/.rels", root_rels()),
        ("xl/workbook.xml", workbook(
            [("Sheet1", 1, "rId1")],
            external_refs=["rId2"],
        )),
        ("xl/_rels/workbook.xml.rels", workbook_rels([
            ("rId1", RT_WORKSHEET, "worksheets/sheet1.xml"),
            ("rId2", RT_EXTLINK, "externalLinks/externalLink1.xml"),
        ])),
        ("xl/worksheets/sheet1.xml", sheet1),
        ("xl/externalLinks/externalLink1.xml", extlink1),
        ("xl/externalLinks/_rels/externalLink1.xml.rels", extlink1_rels),
    ]
    write_zip("10-extlink.xlsx", members)


CT_COMMENTS = "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"
RT_COMMENTS = NS_R + "/comments"


def gen_11_freeze():
    """11: a FROZEN PANE (spec §8.1, the sheets-mode grid view). Sheet1's
    <sheetViews> carries a frozen pane holding the first column + the first two
    rows fixed (xSplit=1 frozen cols, ySplit=2 frozen rows, state="frozen").
    <sheetViews> is an unmodeled <worksheet> child (BeforeSheetData), so it
    round-trips via the verbatim capture; the freeze split is parsed additively
    (read-only) for the grid surface."""
    rows = (
        '<row r="1"><c r="A1" t="inlineStr"><is><t>Hdr</t></is></c>'
        '<c r="B1" t="n"><v>1</v></c></row>'
        '<row r="2"><c r="A2" t="inlineStr"><is><t>Sub</t></is></c>'
        '<c r="B2" t="n"><v>2</v></c></row>'
        '<row r="3"><c r="A3" t="inlineStr"><is><t>row</t></is></c>'
        '<c r="B3" t="n"><v>3</v></c></row>'
    )
    sheet_views = (
        '<sheetViews><sheetView tabSelected="1" workbookViewId="0">'
        '<pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"/>'
        '<selection pane="bottomRight" activeCell="B3" sqref="B3"/>'
        "</sheetView></sheetViews>"
    )
    sheet1 = ws("A1:B3", rows, extras_before=sheet_views)
    members = [
        ("[Content_Types].xml", content_types([
            ("/xl/workbook.xml", CT_WORKBOOK),
            ("/xl/worksheets/sheet1.xml", CT_WORKSHEET),
        ])),
        ("_rels/.rels", root_rels()),
        ("xl/workbook.xml", workbook([("Sheet1", 1, "rId1")])),
        ("xl/_rels/workbook.xml.rels", workbook_rels([
            ("rId1", RT_WORKSHEET, "worksheets/sheet1.xml"),
        ])),
        ("xl/worksheets/sheet1.xml", sheet1),
    ]
    write_zip("11-freeze.xlsx", members)


def gen_12_datavalidation():
    """12: DATA VALIDATION (publishing-first: PRESERVED, never interpreted as a
    runtime constraint — spec §1.1/§11, T∞). Sheet1!B2:B4 carries a list
    validation (an inline "Yes,No,Maybe" dropdown); B6 a whole-number
    constraint (1..100); B8 a date constraint. <dataValidations> is an unmodeled
    <worksheet> child (AfterSheetData), so it round-trips byte-identical via the
    verbatim capture; the validations are parsed ADDITIVELY (read-only inventory)
    so a panel can REPORT that they exist — they are NEVER enforced on edits."""
    rows = (
        '<row r="2"><c r="B2" t="inlineStr"><is><t>Yes</t></is></c></row>'
        '<row r="6"><c r="B6" t="n"><v>42</v></c></row>'
        '<row r="8"><c r="B8" t="n"><v>45000</v></c></row>'
    )
    dv = (
        '<dataValidations count="3">'
        '<dataValidation type="list" allowBlank="1" showDropDown="0" '
        'showInputMessage="1" showErrorMessage="1" sqref="B2:B4">'
        '<formula1>"Yes,No,Maybe"</formula1></dataValidation>'
        '<dataValidation type="whole" operator="between" allowBlank="1" '
        'showErrorMessage="1" sqref="B6">'
        '<formula1>1</formula1><formula2>100</formula2></dataValidation>'
        '<dataValidation type="date" operator="greaterThan" allowBlank="1" '
        'sqref="B8"><formula1>43000</formula1></dataValidation>'
        "</dataValidations>"
    )
    sheet1 = ws("B2:B8", rows, extras_after=dv)
    members = [
        ("[Content_Types].xml", content_types([
            ("/xl/workbook.xml", CT_WORKBOOK),
            ("/xl/worksheets/sheet1.xml", CT_WORKSHEET),
        ])),
        ("_rels/.rels", root_rels()),
        ("xl/workbook.xml", workbook([("Sheet1", 1, "rId1")])),
        ("xl/_rels/workbook.xml.rels", workbook_rels([
            ("rId1", RT_WORKSHEET, "worksheets/sheet1.xml"),
        ])),
        ("xl/worksheets/sheet1.xml", sheet1),
    ]
    write_zip("12-datavalidation.xlsx", members)


def gen_13_comments():
    """13: CELL COMMENTS / NOTES (preserve-first; spec §10.2). Sheet1 references
    a comments part (xl/comments1.xml) through its OWN .rels; the part holds two
    comments (A1 by 'Alice', C3 by 'Bob') with an authors table. The comments
    part is an OPAQUE OPC part (round-trips byte-identical); the worksheet's
    <legacyDrawing>/<drawing> link to the VML is captured verbatim. We parse the
    comments part ADDITIVELY (read-only) so the grid can show an indicator + the
    panel can list them — authoring is preserve-first (we never rewrite the part).
    """
    rows = (
        '<row r="1"><c r="A1" t="inlineStr"><is><t>cell</t></is></c></row>'
        '<row r="3"><c r="C3" t="n"><v>7</v></c></row>'
    )
    # The worksheet links its comments part via its own .rels (rId1).
    sheet1 = ws("A1:C3", rows, extras_after='<legacyDrawing r:id="rId2"/>')
    ws_rels = (
        XML_DECL
        + f'<Relationships xmlns="{NS_REL}">'
        f'<Relationship Id="rId1" Type="{RT_COMMENTS}" Target="../comments1.xml"/>'
        f'<Relationship Id="rId2" Type="{NS_R}/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/>'
        "</Relationships>"
    )
    comments = (
        XML_DECL
        + f'<comments xmlns="{NS_MAIN}">'
        "<authors><author>Alice</author><author>Bob</author></authors>"
        "<commentList>"
        '<comment ref="A1" authorId="0"><text>'
        "<r><t>Check this value before publishing.</t></r>"
        "</text></comment>"
        '<comment ref="C3" authorId="1"><text>'
        "<r><t>Sourced from Q3 ledger.</t></r>"
        "</text></comment>"
        "</commentList>"
        "</comments>"
    )
    # A minimal VML drawing part (opaque; we never parse it — it round-trips).
    vml = (
        '<xml xmlns:v="urn:schemas-microsoft-com:vml" '
        'xmlns:o="urn:schemas-microsoft-com:office:office" '
        'xmlns:x="urn:schemas-microsoft-com:office:excel">'
        '<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" '
        'path="m,l,21600r21600,l21600,xe"/>'
        "</xml>"
    )
    members = [
        ("[Content_Types].xml", content_types([
            ("/xl/workbook.xml", CT_WORKBOOK),
            ("/xl/worksheets/sheet1.xml", CT_WORKSHEET),
            ("/xl/comments1.xml", CT_COMMENTS),
        ]) .replace(
            f'<Default Extension="xml" ContentType="{CT_XML}"/>',
            f'<Default Extension="xml" ContentType="{CT_XML}"/>'
            f'<Default Extension="vml" ContentType="{CT_VML}"/>',
        )),
        ("_rels/.rels", root_rels()),
        ("xl/workbook.xml", workbook([("Sheet1", 1, "rId1")])),
        ("xl/_rels/workbook.xml.rels", workbook_rels([
            ("rId1", RT_WORKSHEET, "worksheets/sheet1.xml"),
        ])),
        ("xl/worksheets/sheet1.xml", sheet1),
        ("xl/worksheets/_rels/sheet1.xml.rels", ws_rels),
        ("xl/comments1.xml", comments),
        ("xl/drawings/vmlDrawing1.vml", vml),
    ]
    write_zip("13-comments.xlsx", members)


def gen_15_saveloss():
    """15: WHAT AN EDITED SHEET MUST NOT LOSE (W1.4). Rich-text shared strings
    (runs with run properties), an inline rich string, hidden and styled and
    outlined columns, row styles / outline levels / collapsed / thick borders /
    hidden rows, the `x14ac:dyDescent` and `ph` attributes Paged does not
    model, and two hidden sheets (`hidden`, `veryHidden`). The probe edits
    one cell, saves, and checks every one of them is still there.
    """
    ns_x14ac = "http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"
    ns_mc = "http://schemas.openxmlformats.org/markup-compatibility/2006"
    sst = (
        XML_DECL
        + f'<sst xmlns="{NS_MAIN}" count="3" uniqueCount="3">'
        "<si><t>plain</t></si>"
        '<si><r><rPr><b/><sz val="11"/><color rgb="FFFF0000"/><rFont val="Calibri"/></rPr>'
        '<t xml:space="preserve">Bold </t></r>'
        '<r><rPr><i/><sz val="11"/><rFont val="Calibri"/></rPr><t>italic</t></r></si>'
        "<si><t>moved</t></si>"
        "</sst>"
    )
    rows = (
        '<row r="1" spans="1:4" s="1" customFormat="1" x14ac:dyDescent="0.25">'
        '<c r="A1" t="s"><v>0</v></c>'
        '<c r="B1" t="s"><v>1</v></c>'
        '<c r="C1" s="1" ph="1"><v>5</v></c>'
        '<c r="D1" t="inlineStr"><is><r><rPr><b/></rPr><t>in</t></r><r><t>line</t></r></is></c>'
        "</row>"
        '<row r="2" spans="1:4" ht="20" customHeight="1" hidden="1" outlineLevel="1" x14ac:dyDescent="0.25">'
        '<c r="A2"><v>1</v></c>'
        "</row>"
        '<row r="3" spans="1:4" collapsed="1" thickBot="1" x14ac:dyDescent="0.25">'
        '<c r="A3"><f>A2*2</f><v>2</v></c>'
        '<c r="B3" t="s"><v>2</v></c>'
        "</row>"
        '<row r="5" s="1" customFormat="1" x14ac:dyDescent="0.25"/>'
    )
    cols = (
        '<col min="1" max="1" width="12.7109375" style="1" customWidth="1"/>'
        '<col min="2" max="2" width="0" hidden="1" customWidth="1"/>'
        '<col min="3" max="4" width="9.140625" outlineLevel="1" collapsed="1"/>'
    )
    sheet1 = (
        XML_DECL
        + f'<worksheet xmlns="{NS_MAIN}" xmlns:r="{NS_R}" xmlns:mc="{ns_mc}" '
        f'mc:Ignorable="x14ac" xmlns:x14ac="{ns_x14ac}">'
        '<sheetPr><outlinePr summaryBelow="0"/></sheetPr>'
        '<dimension ref="A1:D3"/>'
        '<sheetFormatPr defaultRowHeight="15" outlineLevelRow="1" outlineLevelCol="1" x14ac:dyDescent="0.25"/>'
        "<cols>" + cols + "</cols>"
        "<sheetData>" + rows + "</sheetData>"
        '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
        "</worksheet>"
    )
    plain = ws("A1", '<row r="1"><c r="A1"><v>1</v></c></row>')
    st = styles(cell_xfs=[
        dict(numFmtId=0, fontId=0, fillId=0, borderId=0),
        dict(numFmtId=0, fontId=1, fillId=2, borderId=0),
    ])
    wb = (
        XML_DECL
        + f'<workbook xmlns="{NS_MAIN}" xmlns:r="{NS_R}"><sheets>'
        '<sheet name="Data" sheetId="1" r:id="rId1"/>'
        '<sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/>'
        '<sheet name="Secret" sheetId="3" state="veryHidden" r:id="rId3"/>'
        "</sheets></workbook>"
    )
    members = [
        ("[Content_Types].xml", content_types([
            ("/xl/workbook.xml", CT_WORKBOOK),
            ("/xl/worksheets/sheet1.xml", CT_WORKSHEET),
            ("/xl/worksheets/sheet2.xml", CT_WORKSHEET),
            ("/xl/worksheets/sheet3.xml", CT_WORKSHEET),
            ("/xl/sharedStrings.xml", CT_SHARED),
            ("/xl/styles.xml", CT_STYLES),
        ])),
        ("_rels/.rels", root_rels()),
        ("xl/workbook.xml", wb),
        ("xl/_rels/workbook.xml.rels", workbook_rels([
            ("rId1", RT_WORKSHEET, "worksheets/sheet1.xml"),
            ("rId2", RT_WORKSHEET, "worksheets/sheet2.xml"),
            ("rId3", RT_WORKSHEET, "worksheets/sheet3.xml"),
            ("rId4", RT_SHARED, "sharedStrings.xml"),
            ("rId5", RT_STYLES, "styles.xml"),
        ])),
        ("xl/worksheets/sheet1.xml", sheet1),
        ("xl/worksheets/sheet2.xml", plain),
        ("xl/worksheets/sheet3.xml", plain),
        ("xl/sharedStrings.xml", sst),
        ("xl/styles.xml", st),
    ]
    write_zip("15-saveloss.xlsx", members)


def gen_16_structure():
    """16: EVERYTHING A ROW/COLUMN INSERT OR DELETE MUST MOVE (W1.2). Sheet
    `Data` carries a conditional format, a list validation, an internal
    hyperlink, a sheet autoFilter (with its `_FilterDatabase` name), a table
    (`Rates`, H1:J4), a drawing with a picture and a chart over Data's ranges,
    a note (legacy comment + VML box), a threaded comment, a page break, a
    selection, a sparkline group in the x14 extension, a print area and a
    defined name. Sheet `Report` sums Data and validates against it, so a
    shift on Data must move references on another sheet too. Every piece is
    written as Excel writes it, so the Excel open-check lane can open the
    Paged-saved result without a repair prompt.
    """
    ns_x14 = "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"
    ns_xm = "http://schemas.microsoft.com/office/excel/2006/main"
    ns_mc = "http://schemas.openxmlformats.org/markup-compatibility/2006"
    ns_tc = "http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"
    rt_tc = "http://schemas.microsoft.com/office/2017/10/relationships/threadedComment"
    rt_person = "http://schemas.microsoft.com/office/2017/10/relationships/person"
    person_id = "{6F1D7E2A-0000-4000-8000-000000000001}"
    tc_id = "{6F1D7E2A-0000-4000-8000-000000000002}"

    def t(ref, text):
        return f'<c r="{ref}" t="inlineStr"><is><t>{text}</t></is></c>'

    def n(ref, v, s=None):
        st = f' s="{s}"' if s else ""
        return f'<c r="{ref}"{st}><v>{v}</v></c>'

    rows = (
        '<row r="1">' + t("A1", "Item") + t("B1", "Qty") + t("C1", "Kind") + t("D1", "Limit")
        + t("F1", "a") + t("H1", "Code") + t("I1", "Rate") + t("J1", "Note") + "</row>"
        '<row r="2">' + t("A2", "Pens") + n("B2", 12) + t("C2", "a") + n("D2", 15)
        + t("F2", "b") + t("H2", "X") + n("I2", 1.5) + t("J2", "x") + "</row>"
        '<row r="3">' + t("A3", "Ink") + n("B3", 20) + t("C3", "b") + n("D3", 15)
        + t("F3", "c") + t("H3", "Y") + n("I3", 2.5) + t("J3", "y") + "</row>"
        '<row r="4">' + t("A4", "Paper") + n("B4", 7) + t("C4", "c") + n("D4", 15)
        + t("H4", "Z") + n("I4", 3.5) + t("J4", "z") + "</row>"
        '<row r="5">' + t("A5", "Clips") + n("B5", 30) + t("C5", "a") + n("D5", 15) + "</row>"
        '<row r="6">' + t("A6", "Total") + '<c r="B6"><f>SUM(B2:B5)</f><v>69</v></c>'
        + '<c r="E6"><f>SUM(Rates[Rate])</f><v>7.5</v></c>' + "</row>"
    )
    sheet_data = (
        XML_DECL
        + f'<worksheet xmlns="{NS_MAIN}" xmlns:r="{NS_R}" xmlns:mc="{ns_mc}" '
        f'mc:Ignorable="x14ac" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac">'
        '<dimension ref="A1:J6"/>'
        '<sheetViews><sheetView tabSelected="1" workbookViewId="0">'
        '<selection activeCell="B4" sqref="B4"/></sheetView></sheetViews>'
        '<sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/>'
        "<sheetData>" + rows + "</sheetData>"
        '<autoFilter ref="A1:D5"/>'
        '<conditionalFormatting sqref="B2:B5">'
        '<cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>$D$2</formula></cfRule>'
        "</conditionalFormatting>"
        '<dataValidations count="1"><dataValidation type="list" allowBlank="1" '
        'showInputMessage="1" showErrorMessage="1" sqref="C2:C5"><formula1>$F$1:$F$3</formula1>'
        "</dataValidation></dataValidations>"
        '<hyperlinks><hyperlink ref="A6" location="Report!A1" display="Total"/></hyperlinks>'
        '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
        '<rowBreaks count="1" manualBreakCount="1"><brk id="4" max="16383" man="1"/></rowBreaks>'
        '<drawing r:id="rId1"/>'
        '<legacyDrawing r:id="rId2"/>'
        '<tableParts count="1"><tablePart r:id="rId3"/></tableParts>'
        "<extLst>"
        f'<ext uri="{{05C60535-1F16-4fd2-B633-F4F36F0B64E0}}" xmlns:x14="{ns_x14}">'
        f'<x14:sparklineGroups xmlns:xm="{ns_xm}">'
        '<x14:sparklineGroup displayEmptyCellsAs="gap">'
        '<x14:colorSeries rgb="FF376092"/><x14:colorNegative rgb="FFD00000"/>'
        '<x14:colorAxis rgb="FF000000"/><x14:colorMarkers rgb="FFD00000"/>'
        '<x14:colorFirst rgb="FFD00000"/><x14:colorLast rgb="FFD00000"/>'
        '<x14:colorHigh rgb="FFD00000"/><x14:colorLow rgb="FFD00000"/>'
        "<x14:sparklines>"
        "<x14:sparkline><xm:f>Data!B2:B5</xm:f><xm:sqref>B7</xm:sqref></x14:sparkline>"
        "</x14:sparklines></x14:sparklineGroup></x14:sparklineGroups></ext>"
        "</extLst>"
        "</worksheet>"
    )
    sheet_data_rels = (
        XML_DECL
        + f'<Relationships xmlns="{NS_REL}">'
        f'<Relationship Id="rId1" Type="{RT_DRAWING}" Target="../drawings/drawing1.xml"/>'
        f'<Relationship Id="rId2" Type="{NS_R}/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/>'
        f'<Relationship Id="rId3" Type="{RT_TABLE}" Target="../tables/table1.xml"/>'
        f'<Relationship Id="rId4" Type="{RT_COMMENTS}" Target="../comments1.xml"/>'
        f'<Relationship Id="rId5" Type="{rt_tc}" Target="../threadedComments/threadedComment1.xml"/>'
        "</Relationships>"
    )
    report = (
        XML_DECL
        + f'<worksheet xmlns="{NS_MAIN}" xmlns:r="{NS_R}"><dimension ref="A1:B1"/>'
        "<sheetData><row r=\"1\">"
        '<c r="A1"><f>SUM(Data!B2:B5)</f><v>69</v></c>' + t("B1", "Pens")
        + "</row></sheetData>"
        '<dataValidations count="1"><dataValidation type="list" allowBlank="1" '
        'showInputMessage="1" showErrorMessage="1" sqref="B1"><formula1>Data!$A$2:$A$5</formula1>'
        "</dataValidation></dataValidations>"
        '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
        "</worksheet>"
    )
    table1 = (
        XML_DECL
        + f'<table xmlns="{NS_MAIN}" id="1" name="Rates" displayName="Rates" ref="H1:J4" totalsRowShown="0">'
        '<autoFilter ref="H1:J4"/>'
        '<tableColumns count="3"><tableColumn id="1" name="Code"/>'
        '<tableColumn id="2" name="Rate"/><tableColumn id="3" name="Note"/></tableColumns>'
        '<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" '
        'showRowStripes="1" showColumnStripes="0"/></table>'
    )
    def png_1x1():
        import struct
        import zlib

        def chunk(kind, data):
            body = kind + data
            return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

        ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)
        idat = zlib.compress(b"\x00\x33\x66\xcc\xff", 9)
        return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")

    png = png_1x1()
    drawing1 = (
        XML_DECL
        + f'<xdr:wsDr xmlns:xdr="{NS_XDR}" xmlns:a="{NS_A}" xmlns:r="{NS_R}">'
        '<xdr:twoCellAnchor editAs="oneCell">'
        "<xdr:from><xdr:col>11</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>"
        "<xdr:to><xdr:col>12</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>"
        '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Picture 1"/><xdr:cNvPicPr>'
        '<a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>'
        '<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>'
        '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="609600" cy="381000"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>'
        "<xdr:clientData/></xdr:twoCellAnchor>"
        "<xdr:twoCellAnchor>"
        "<xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>8</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>"
        "<xdr:to><xdr:col>7</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>20</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>"
        '<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="3" name="Chart 1"/>'
        "<xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>"
        '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>'
        f'<a:graphic><a:graphicData uri="{NS_C}"><c:chart xmlns:c="{NS_C}" r:id="rId2"/>'
        "</a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>"
        "</xdr:wsDr>"
    )
    drawing1_rels = (
        XML_DECL
        + f'<Relationships xmlns="{NS_REL}">'
        f'<Relationship Id="rId1" Type="{NS_R}/image" Target="../media/image1.png"/>'
        f'<Relationship Id="rId2" Type="{RT_CHART}" Target="../charts/chart1.xml"/>'
        "</Relationships>"
    )
    chart1 = (
        XML_DECL
        + f'<c:chartSpace xmlns:c="{NS_C}" xmlns:a="{NS_A}" xmlns:r="{NS_R}">'
        "<c:chart><c:autoTitleDeleted val=\"1\"/><c:plotArea><c:layout/>"
        '<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>'
        '<c:ser><c:idx val="0"/><c:order val="0"/>'
        "<c:tx><c:strRef><c:f>Data!$B$1</c:f><c:strCache><c:ptCount val=\"1\"/>"
        '<c:pt idx="0"><c:v>Qty</c:v></c:pt></c:strCache></c:strRef></c:tx>'
        '<c:invertIfNegative val="0"/>'
        "<c:cat><c:strRef><c:f>Data!$A$2:$A$5</c:f><c:strCache><c:ptCount val=\"4\"/>"
        '<c:pt idx="0"><c:v>Pens</c:v></c:pt><c:pt idx="1"><c:v>Ink</c:v></c:pt>'
        '<c:pt idx="2"><c:v>Paper</c:v></c:pt><c:pt idx="3"><c:v>Clips</c:v></c:pt>'
        "</c:strCache></c:strRef></c:cat>"
        "<c:val><c:numRef><c:f>Data!$B$2:$B$5</c:f><c:numCache><c:formatCode>General</c:formatCode>"
        '<c:ptCount val="4"/><c:pt idx="0"><c:v>12</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt>'
        '<c:pt idx="2"><c:v>7</c:v></c:pt><c:pt idx="3"><c:v>30</c:v></c:pt>'
        "</c:numCache></c:numRef></c:val></c:ser>"
        '<c:gapWidth val="150"/><c:axId val="10"/><c:axId val="20"/></c:barChart>'
        '<c:catAx><c:axId val="10"/><c:scaling><c:orientation val="minMax"/></c:scaling>'
        '<c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/>'
        '<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>'
        '<c:crossAx val="20"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/>'
        '<c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>'
        '<c:valAx><c:axId val="20"/><c:scaling><c:orientation val="minMax"/></c:scaling>'
        '<c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/>'
        '<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/>'
        '<c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="10"/>'
        '<c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>'
        "</c:plotArea><c:plotVisOnly val=\"1\"/></c:chart></c:chartSpace>"
    )
    comments1 = (
        XML_DECL
        + f'<comments xmlns="{NS_MAIN}" xmlns:mc="{ns_mc}" mc:Ignorable="xr" '
        'xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision">'
        f"<authors><author>Reviewer</author><author>tc={tc_id}</author></authors>"
        "<commentList>"
        '<comment ref="B3" authorId="0" shapeId="0"><text><r><t>Check the count.</t></r></text></comment>'
        f'<comment ref="D3" authorId="1" shapeId="0" xr:uid="{tc_id}"><text><t>'
        "[Threaded comment]\n\nYour version of Excel allows you to read this threaded comment; "
        "however, any edits to it will get removed if the file is opened in a newer version of "
        "Excel. Learn more: https://go.microsoft.com/fwlink/?linkid=870924\n\nComment:\n    "
        "Is the limit right?</t></text></comment>"
        "</commentList></comments>"
    )

    def note_shape(sid, row, col):
        return (
            f'<v:shape id="_x0000_s{sid}" type="#_x0000_t202" style="position:absolute;'
            "margin-left:59.25pt;margin-top:1.5pt;width:108pt;height:59.25pt;z-index:1;"
            'visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto">'
            '<v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/>'
            '<v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto">'
            '<div style="text-align:left"></div></v:textbox>'
            '<x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/>'
            f"<x:Anchor>{col + 1}, 15, {row}, 10, {col + 3}, 15, {row + 4}, 4</x:Anchor>"
            f"<x:AutoFill>False</x:AutoFill><x:Row>{row}</x:Row><x:Column>{col}</x:Column>"
            "</x:ClientData></v:shape>"
        )

    vml = (
        '<xml xmlns:v="urn:schemas-microsoft-com:vml" '
        'xmlns:o="urn:schemas-microsoft-com:office:office" '
        'xmlns:x="urn:schemas-microsoft-com:office:excel">'
        '<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout>'
        '<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" '
        'path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/>'
        '<v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>'
        + note_shape(1025, 2, 1)
        + note_shape(1026, 2, 3)
        + "</xml>"
    )
    threaded = (
        XML_DECL
        + f'<ThreadedComments xmlns="{ns_tc}" xmlns:x="{NS_MAIN}">'
        f'<threadedComment ref="D3" dT="2026-10-22T10:00:00.00" personId="{person_id}" id="{tc_id}">'
        "<text>Is the limit right?</text></threadedComment></ThreadedComments>"
    )
    persons = (
        XML_DECL
        + f'<personList xmlns="{ns_tc}" xmlns:x="{NS_MAIN}">'
        f'<person displayName="Reviewer" id="{person_id}" userId="Reviewer" providerId="None"/>'
        "</personList>"
    )
    st = styles(
        cell_xfs=[dict(numFmtId=0, fontId=0, fillId=0, borderId=0)],
        dxfs=['<dxf><font><b/></font></dxf>'],
    )
    wb = workbook(
        [("Data", 1, "rId1"), ("Report", 2, "rId2")],
        defined_names=[
            ("_xlnm._FilterDatabase", "Data!$A$1:$D$5", 0),
            ("_xlnm.Print_Area", "Data!$A$1:$D$6", 0),
            ("Limits", "Data!$D$2:$D$5", None),
        ],
    ).replace(
        '<definedName name="_xlnm._FilterDatabase" localSheetId="0">',
        '<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">',
    )
    ct = content_types([
        ("/xl/workbook.xml", CT_WORKBOOK),
        ("/xl/worksheets/sheet1.xml", CT_WORKSHEET),
        ("/xl/worksheets/sheet2.xml", CT_WORKSHEET),
        ("/xl/styles.xml", CT_STYLES),
        ("/xl/tables/table1.xml", CT_TABLE),
        ("/xl/drawings/drawing1.xml", CT_DRAWING),
        ("/xl/charts/chart1.xml", CT_CHART),
        ("/xl/comments1.xml", CT_COMMENTS),
        ("/xl/threadedComments/threadedComment1.xml", "application/vnd.ms-excel.threadedcomments+xml"),
        ("/xl/persons/person.xml", "application/vnd.ms-excel.person+xml"),
    ]).replace(
        f'<Default Extension="xml" ContentType="{CT_XML}"/>',
        f'<Default Extension="xml" ContentType="{CT_XML}"/>'
        f'<Default Extension="vml" ContentType="{CT_VML}"/>'
        '<Default Extension="png" ContentType="image/png"/>',
    )
    members = [
        ("[Content_Types].xml", ct),
        ("_rels/.rels", root_rels()),
        ("xl/workbook.xml", wb),
        ("xl/_rels/workbook.xml.rels", workbook_rels([
            ("rId1", RT_WORKSHEET, "worksheets/sheet1.xml"),
            ("rId2", RT_WORKSHEET, "worksheets/sheet2.xml"),
            ("rId3", RT_STYLES, "styles.xml"),
            ("rId4", rt_person, "persons/person.xml"),
        ])),
        ("xl/worksheets/sheet1.xml", sheet_data),
        ("xl/worksheets/_rels/sheet1.xml.rels", sheet_data_rels),
        ("xl/worksheets/sheet2.xml", report),
        ("xl/styles.xml", st),
        ("xl/tables/table1.xml", table1),
        ("xl/drawings/drawing1.xml", drawing1),
        ("xl/drawings/_rels/drawing1.xml.rels", drawing1_rels),
        ("xl/media/image1.png", png),
        ("xl/charts/chart1.xml", chart1),
        ("xl/comments1.xml", comments1),
        ("xl/drawings/vmlDrawing1.vml", vml),
        ("xl/threadedComments/threadedComment1.xml", threaded),
        ("xl/persons/person.xml", persons),
    ]
    write_zip("16-structure.xlsx", members)


def main():
    gen_01_minimal()
    gen_02_formulas()
    gen_03_styles()
    gen_04_unknown_parts()
    gen_05_unknown_subtrees()
    gen_06_multisheet_1904()
    gen_07_tables()
    gen_08_condfmt()
    gen_09_chart()
    gen_10_extlink()
    gen_11_freeze()
    gen_12_datavalidation()
    gen_13_comments()
    gen_15_saveloss()
    gen_16_structure()


if __name__ == "__main__":
    main()
