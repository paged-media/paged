#!/usr/bin/env python3
# paged.sheet — Excel oracle, DISPLAY lane: what a cell SHOWS.
#
# @copyright  Copyright (c) And The Next GmbH
# @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
#
# The value lanes record what a formula computes; this lane records what a
# cell displays: its text (Excel's `string value`, the Range.Text of the
# object model) and the colours Excel paints it in (`display format`'s font
# and interior colour — the number format's colour bracket and the winning
# conditional format included).
#
# Usage (maintainer, macOS + Excel 16, holding the oracle lock):
#   python3 display.py generate          # build/display.xlsx + build/display.cases.tsv
#   PAGED_ORACLE_SCRIPT=display.applescript ./drive.sh display
#   python3 display.py read              # build/display.meta -> recorded/display.tsv
#
# CI never runs Excel: `tests/it/excel_display.rs` replays recorded/display.tsv
# against the engine (the cell text through the lowering's display path and
# the effective text colour through the shared styler).
#
# Cases: every number-format golden case of corpus/format-corpus that the
# en-US display can show (the locale goldens are skipped — the lane runs
# under en-US), plus the colour brackets, system formats and repeat fills
# the W2.1 work added. One case per row of column A (column B holds the
# fill cases in a narrower column, so the repeat count is visible).

from __future__ import annotations

import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
FORMAT_CORPUS = REPO / "corpus" / "format-corpus"
BUILD = HERE / "build"
RECORDED = HERE / "recorded"
NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"

SKIP_FILES = {"locale-de.golden.tsv", "locale-latin.golden.tsv"}

# (id, format code, value) beyond the corpus: what W2.1 renders.
EXTRA = [
    ("color-index-3", "[Color3]0", "5"),
    ("color-index-10", "[Color10]0.0", "5"),
    ("color-index-12", "[Color12]0", "8"),
    ("color-index-45", "[Color45]#,##0", "1234"),
    ("color-neg-blue", "0.00;[Blue]-0.00", "-5"),
    ("color-zero-section", "0;0;[Magenta]0", "0"),
    ("color-text-section", "0;0;0;[Red]@", "note"),
    ("color-cond-red", "[Red][<0]0;[Green][>100]0;0", "-3"),
    ("color-cond-green", "[Red][<0]0;[Green][>100]0;0", "300"),
    ("color-cond-default", "[Red][<0]0;[Green][>100]0;0", "50"),
    ("sys-long-date", "[$-F800]dddd\\,\\ mmmm\\ dd\\,\\ yyyy", "44197"),
    ("sys-long-date-x", "[$-x-sysdate]dddd, mmmm dd, yyyy", "45000"),
    ("sys-long-time", "[$-F400]h:mm:ss\\ AM/PM", "44197.75"),
    ("sys-long-time-x", "[$-x-systime]h:mm:ss AM/PM", "0.5"),
    ("fraction-2", "# ??/??", "3.14159"),
    ("fraction-3", "# ???/???", "2.71828"),
    ("elapsed-h", "[h]:mm:ss", "1.5"),
    ("elapsed-h-neg", "[h]:mm", "2.25"),
    ("text-at", "@", "123"),
    ("text-quoted", "\"Item: \"@", "lamp"),
]

# Repeat fills, in column B (width 16): the text Excel shows has the fill
# repeated to the column width; the replay collapses the run.
FILL = [
    ("fill-acct", "_($* #,##0.00_);_($* (#,##0.00);_($* \"-\"??_);_(@_)", "1234.5"),
    ("fill-acct-neg", "_($* #,##0.00_);_($* (#,##0.00);_($* \"-\"??_);_(@_)", "-12"),
    ("fill-acct-zero", "_($* #,##0.00_);_($* (#,##0.00);_($* \"-\"??_);_(@_)", "0"),
    ("fill-dots-text", "@*.", "Total"),
    ("fill-dash-num", "*-0", "42"),
    ("fill-star-after", "0*x", "7"),
]


def corpus_cases() -> list[tuple[str, str, str]]:
    out = []
    for path in sorted(FORMAT_CORPUS.glob("*.golden.tsv")):
        if path.name in SKIP_FILES:
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line or line.startswith("#"):
                continue
            cols = line.split("\t")
            if len(cols) < 3:
                continue
            out.append((cols[0], cols[1], cols[2]))
    return out


def all_cases() -> list[tuple[str, str, str, str]]:
    """(column letter, id, code, value)."""
    seen = set()
    out = []
    for cid, code, value in corpus_cases() + EXTRA:
        if cid in seen:
            continue
        seen.add(cid)
        out.append(("A", cid, code, value))
    for cid, code, value in FILL:
        out.append(("B", cid, code, value))
    return out


def is_number(v: str) -> bool:
    try:
        float(v)
        return True
    except ValueError:
        return False


def generate() -> None:
    BUILD.mkdir(exist_ok=True)
    cases = all_cases()
    codes: list[str] = []
    for _, _, code, _ in cases:
        if code not in codes:
            codes.append(code)
    numfmts = "".join(
        f'<numFmt numFmtId="{164 + i}" formatCode="{escape(c, {chr(34): "&quot;"})}"/>'
        for i, c in enumerate(codes)
    )
    xfs = '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' + "".join(
        f'<xf numFmtId="{164 + i}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        for i in range(len(codes))
    )
    styles = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="{NS}">'
        f'<numFmts count="{len(codes)}">{numfmts}</numFmts>'
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="2"><fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="gray125"/></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        f'<cellXfs count="{len(codes) + 1}">{xfs}</cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        "</styleSheet>"
    )
    rows: dict[int, list[str]] = {}
    lines = ["# column\trow\tid\tformat_code\tvalue"]
    counters = {"A": 0, "B": 0}
    for col, cid, code, value in cases:
        counters[col] += 1
        r = counters[col]
        s = codes.index(code) + 1
        ref = f"{col}{r}"
        if is_number(value):
            cell = f'<c r="{ref}" s="{s}"><v>{value}</v></c>'
        else:
            cell = f'<c r="{ref}" s="{s}" t="inlineStr"><is><t>{escape(value)}</t></is></c>'
        rows.setdefault(r, []).append(cell)
        lines.append(f"{col}\t{r}\t{cid}\t{code}\t{value}")
    sheet_rows = "".join(
        f'<row r="{r}">{"".join(sorted(cells))}</row>' for r, cells in sorted(rows.items())
    )
    sheet = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="{NS}">'
        '<cols><col min="1" max="1" width="40" customWidth="1"/>'
        '<col min="2" max="2" width="16" customWidth="1"/></cols>'
        f"<sheetData>{sheet_rows}</sheetData></worksheet>"
    )
    workbook = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="{NS}" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="display" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    with zipfile.ZipFile(BUILD / "display.xlsx", "w", zipfile.ZIP_DEFLATED) as z:
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
    (BUILD / "display.cases.tsv").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"display: {len(cases)} cases -> {BUILD / 'display.xlsx'}")


def read() -> None:
    meta = (BUILD / "display.meta").read_text(encoding="utf-8")
    if "ERR" in meta.splitlines()[0]:
        sys.exit(f"display lane failed: {meta[:400]}")
    shown: dict[str, tuple[str, str, str]] = {}
    for line in meta.splitlines():
        if line.startswith("rc="):
            line = line.split(" ", 1)[1] if " " in line else ""
            if line.startswith("OK"):
                continue
        cols = line.split("\t")
        if len(cols) == 4:
            shown[cols[0]] = (cols[1], cols[2], cols[3])
    out = [
        "# Excel-recorded cell display (oracle/excel/display.py — do not hand-edit)",
        "# id\tformat_code\tvalue\tshown\tfont_rgb\tinterior_rgb",
    ]
    missing = 0
    for line in (BUILD / "display.cases.tsv").read_text(encoding="utf-8").splitlines()[1:]:
        col, row, cid, code, value = line.split("\t")
        got = shown.get(f"{col}{row}")
        if got is None:
            missing += 1
            continue
        text, font, interior = got
        out.append(f"{cid}\t{code}\t{value}\t{text}\t{font}\t{interior}")
    RECORDED.mkdir(exist_ok=True)
    (RECORDED / "display.tsv").write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"display: recorded {len(out) - 2} cells, {missing} missing")


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in {"generate", "read"}:
        sys.exit("usage: display.py generate|read")
    generate() if sys.argv[1] == "generate" else read()
