#!/usr/bin/env python3
# paged.sheet — Excel oracle, CONDITIONAL-FORMAT display lane.
#
# @copyright  Copyright (c) And The Next GmbH
# @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
#
# One workbook with a column per rule kind (cellIs with formula operands,
# expression, top/bottom N and N %, above/below average with a standard
# deviation, duplicate/unique, text, blanks/errors, 2- and 3-colour scales,
# stacking with stopIfTrue, a differential number format), opened by Excel;
# the display lane's AppleScript records what every cell SHOWS — text, font
# colour and interior colour of its display format (conditional formatting
# included). Data bars and icons have no display-format colour; they are
# covered by the evaluator's unit tests and the corpus lane.
#
# Usage (maintainer, macOS + Excel 16, holding the oracle lock):
#   python3 cfdisplay.py generate     # build/cf.xlsx + corpus/xlsx-corpus/20-condfmt-all.xlsx
#   PAGED_ORACLE_SCRIPT=display.applescript ./drive.sh cf
#   python3 cfdisplay.py read         # build/cf.meta -> recorded/cf-display.tsv
#
# CI replays recorded/cf-display.tsv against the fixture through the session
# (tests/it/excel_cf_display.rs).

from __future__ import annotations

import shutil
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
BUILD = HERE / "build"
RECORDED = HERE / "recorded"
FIXTURE = REPO / "corpus" / "xlsx-corpus" / "20-condfmt-all.xlsx"
NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"

# Differential formats: 0 yellow fill, 1 red bold font, 2 green fill,
# 3 blue font, 4 number format 0.00, 5 orange fill.
DXFS = [
    '<dxf><fill><patternFill><bgColor rgb="FFFFFF00"/></patternFill></fill></dxf>',
    '<dxf><font><b/><color rgb="FFC00000"/></font></dxf>',
    '<dxf><fill><patternFill><bgColor rgb="FF00B050"/></patternFill></fill></dxf>',
    '<dxf><font><color rgb="FF0070C0"/></font></dxf>',
    '<dxf><numFmt numFmtId="200" formatCode="0.00"/></dxf>',
    '<dxf><fill><patternFill><bgColor rgb="FFFFC000"/></patternFill></fill></dxf>',
]

TEXTS = ["apple", "banana", "Apple", "mango", "kiwi", "banana", "grape", "Kiwi", "melon", "pear"]

# (column, values kind, conditionalFormatting XML for the column's rows 1..10)
def columns() -> list[tuple[str, str, str]]:
    num = "num"
    return [
        ("A", num, '<cfRule type="cellIs" dxfId="0" priority="1" operator="between"><formula>3</formula><formula>$Z$1</formula></cfRule>'),
        ("B", num, '<cfRule type="expression" dxfId="2" priority="2"><formula>MOD(B1,3)=0</formula></cfRule>'),
        ("C", num, '<cfRule type="top10" dxfId="0" priority="3" rank="3"/>'),
        ("D", num, '<cfRule type="top10" dxfId="2" priority="4" percent="1" bottom="1" rank="20"/>'),
        ("E", num, '<cfRule type="aboveAverage" dxfId="0" priority="5"/>'),
        ("F", num, '<cfRule type="aboveAverage" dxfId="2" priority="6" aboveAverage="0" stdDev="1"/>'),
        ("G", "text", '<cfRule type="duplicateValues" dxfId="0" priority="7"/>'),
        ("H", "text", '<cfRule type="uniqueValues" dxfId="2" priority="8"/>'),
        ("I", "text", '<cfRule type="containsText" dxfId="0" priority="9" operator="containsText" text="an"><formula>NOT(ISERROR(SEARCH("an",I1)))</formula></cfRule>'),
        ("J", "text", '<cfRule type="beginsWith" dxfId="1" priority="10" operator="beginsWith" text="ap"><formula>LEFT(J1,LEN("ap"))="ap"</formula></cfRule>'),
        ("K", "mixed", '<cfRule type="containsErrors" dxfId="0" priority="11"><formula>ISERROR(K1)</formula></cfRule>'),
        ("L", "mixed", '<cfRule type="containsBlanks" dxfId="2" priority="12"><formula>LEN(TRIM(L1))=0</formula></cfRule>'),
        ("M", num, '<cfRule type="colorScale" priority="13"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FFFFFFFF"/><color rgb="FFF8696B"/></colorScale></cfRule>'),
        ("N", num, '<cfRule type="colorScale" priority="14"><colorScale><cfvo type="num" val="2"/><cfvo type="percentile" val="50"/><cfvo type="max"/><color rgb="FFF8696B"/><color rgb="FFFFEB84"/><color rgb="FF63BE7B"/></colorScale></cfRule>'),
        ("O", num,
         '<cfRule type="cellIs" dxfId="0" priority="15" operator="greaterThan" stopIfTrue="1"><formula>7</formula></cfRule>'
         '<cfRule type="cellIs" dxfId="1" priority="16" operator="greaterThan"><formula>3</formula></cfRule>'
         '<cfRule type="colorScale" priority="17"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FF5A8AC6"/><color rgb="FFFFFFFF"/></colorScale></cfRule>'),
        ("P", num, '<cfRule type="cellIs" dxfId="4" priority="18" operator="greaterThan"><formula>5</formula></cfRule>'),
        ("Q", num,
         '<cfRule type="cellIs" dxfId="5" priority="19" operator="lessThan"><formula>4</formula></cfRule>'
         '<cfRule type="cellIs" dxfId="3" priority="20" operator="lessThan"><formula>6</formula></cfRule>'),
        ("R", "text", '<cfRule type="notContainsText" dxfId="3" priority="21" operator="notContains" text="a"><formula>ISERROR(SEARCH("a",R1))</formula></cfRule>'),
        ("S", "text", '<cfRule type="endsWith" dxfId="0" priority="22" operator="endsWith" text="a"><formula>RIGHT(S1,LEN("a"))="a"</formula></cfRule>'),
        ("T", num, '<cfRule type="cellIs" dxfId="2" priority="23" operator="notEqual"><formula>"x"</formula></cfRule>'),
    ]


def cell(col: str, row: int, kind: str) -> str:
    ref = f"{col}{row}"
    if kind == "num":
        return f'<c r="{ref}"><v>{row}</v></c>'
    if kind == "text":
        t = escape(TEXTS[row - 1])
        return f'<c r="{ref}" t="inlineStr"><is><t>{t}</t></is></c>'
    # mixed: errors, blanks, spaces and values.
    mixed = {
        1: '<c r="{r}" t="e"><f>1/0</f><v>#DIV/0!</v></c>',
        2: '<c r="{r}" t="inlineStr"><is><t>x</t></is></c>',
        3: '<c r="{r}" t="inlineStr"><is><t xml:space="preserve">  </t></is></c>',
        4: '<c r="{r}"><v>5</v></c>',
        5: '<c r="{r}" t="e"><f>NA()</f><v>#N/A</v></c>',
        7: '<c r="{r}"><v>0</v></c>',
    }
    return mixed.get(row, "").replace("{r}", ref)


def generate() -> None:
    BUILD.mkdir(exist_ok=True)
    cols = columns()
    rows = []
    for r in range(1, 11):
        cells = "".join(cell(c, r, k) for c, k, _ in cols)
        if r == 1:
            cells += '<c r="Z1"><v>6</v></c>'
        rows.append(f'<row r="{r}">{cells}</row>')
    cf = "".join(
        f'<conditionalFormatting sqref="{c}1:{c}10">{x}</conditionalFormatting>' for c, _, x in cols
    )
    sheet = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="{NS}">'
        '<cols><col min="1" max="26" width="12" customWidth="1"/></cols>'
        f"<sheetData>{''.join(rows)}</sheetData>{cf}</worksheet>"
    )
    styles = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="{NS}">'
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="2"><fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="gray125"/></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        f'<dxfs count="{len(DXFS)}">{"".join(DXFS)}</dxfs>'
        "</styleSheet>"
    )
    workbook = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="{NS}" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="cf" sheetId="1" r:id="rId1"/></sheets>'
        '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>'
    )
    out = BUILD / "cf.xlsx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            "</Types>",
        )
        z.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            "</Relationships>",
        )
        z.writestr("xl/workbook.xml", workbook)
        z.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            "</Relationships>",
        )
        z.writestr("xl/worksheets/sheet1.xml", sheet)
        z.writestr("xl/styles.xml", styles)
    shutil.copyfile(out, FIXTURE)
    print(f"cf: {len(cols)} rule columns -> {out} and {FIXTURE}")


def read() -> None:
    meta = (BUILD / "cf.meta").read_text(encoding="utf-8")
    if "ERR" in meta.splitlines()[0]:
        sys.exit(f"cf display lane failed: {meta[:400]}")
    out = [
        "# Excel-recorded conditional-format display (oracle/excel/cfdisplay.py — do not hand-edit)",
        "# fixture: corpus/xlsx-corpus/20-condfmt-all.xlsx",
        "# cell\tshown\tfont_rgb\tinterior_rgb",
    ]
    for line in meta.splitlines():
        cols = line.split("\t")
        if len(cols) == 4 and not cols[0].startswith("Z"):
            out.append("\t".join(cols))
    RECORDED.mkdir(exist_ok=True)
    (RECORDED / "cf-display.tsv").write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"cf: recorded {len(out) - 3} cells")


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in {"generate", "read"}:
        sys.exit("usage: cfdisplay.py generate|read")
    generate() if sys.argv[1] == "generate" else read()
