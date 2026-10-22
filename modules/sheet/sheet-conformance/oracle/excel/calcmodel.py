#!/usr/bin/env python3
# paged.sheet — Excel oracle lane for the CALCULATION MODEL (spill shapes, `@`,
# 3D references, named LAMBDA, circular references, 15-digit rules).
#
# @copyright  Copyright (c) And The Next GmbH
# @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
#
# The fn-corpus lane (generate.py / read.py) reads ONE host cell per case. The
# calculation model needs more: a spill fills a block, a 3D reference spans
# several sheets, a named LAMBDA lives in the workbook's defined names and a
# legacy formula must be stored WITHOUT the dynamic-array metadata. So this
# lane has its own case file and its own workbook, and records every probed
# cell.
#
# Usage (maintainer, macOS + Microsoft Excel; hold the Excel lock first):
#   python3 calcmodel.py generate          # -> build/calcmodel.xlsx
#   ./drive.sh calcmodel                   # Excel recalculates it
#   python3 calcmodel.py read              # -> recorded/calcmodel.tsv
#
# Case file: corpus/calc-model/cases.tsv, one line per item, tab separated:
#   <case id> <kind> <address> <value>
# kinds:
#   cell    a typed input (the fn-corpus setup grammar: number, text:…, bool,
#           an error literal, empty) or a formula `=…`, written as a DYNAMIC
#           array formula (`t="array"` + `cm`), what Excel 365 stores when a
#           user types a formula
#   legacy  a formula written as a plain `<f>` (no dynamic-array metadata):
#           what Excel 2016 and older store — opened in Excel 365 it keeps
#           implicit intersection
#   sheet   declare a further sheet of this case (value unused), in order, so
#           a 3D span `First:Last!A1` covers exactly the declared sheets
#   name    a workbook defined name: <address> is the name, <value> its
#           formula (`=LAMBDA(x,x+1)`, `=Sheet!$A$1`)
#   probe   a cell or a range of cells to record (`B1`, `B1:C4`, `S2!A1`)
# The case's own sheet is `c<n>` (n = case order); an unqualified address is
# on it. Sheet and name spellings must be unique across the whole file.
# `@(x)` is written `_xlfn.SINGLE(x)` in the file (the parenthesised form is
# the one the engine and the file both read unambiguously).
#
# recorded/calcmodel.tsv: <case id> <fingerprint> <cell> <type> <value>, where
# the fingerprint is FNV-1a 64 over the case's lines (the Rust lane recomputes
# it, so an edited case reads STALE instead of passing on an old recording).

from __future__ import annotations

import os
import re
import sys
import zipfile
from xml.sax.saxutils import escape

import generate as g
import oracle_cases as oc
import read as rd

CASES = oc.REPO / "corpus" / "calc-model" / "cases.tsv"
FAMILY = "calcmodel"


class Case:
    def __init__(self, cid: str, n: int):
        self.id = cid
        self.sheet = f"c{n}"
        self.lines: list[str] = []
        self.cells: list[tuple[str, str, str, str]] = []  # (kind, sheet, addr, value)
        self.sheets: list[str] = []
        self.names: list[tuple[str, str]] = []
        self.probes: list[tuple[str, str]] = []  # (sheet, addr)


def fnv1a(text: str) -> str:
    h = 0xCBF29CE484222325
    for b in text.encode("utf-8"):
        h ^= b
        h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{h:016x}"


def split_addr(case: Case, addr: str) -> tuple[str, str]:
    if "!" in addr:
        s, a = addr.rsplit("!", 1)
        return s.strip("'"), a
    return case.sheet, addr


def expand(addr: str) -> list[str]:
    if ":" not in addr:
        return [addr.upper()]
    a, b = addr.split(":")
    (r0, c0), (r1, c1) = oc.a1(a), oc.a1(b)
    return [f"{g.col_letters(c)}{r}" for r in range(r0, r1 + 1) for c in range(c0, c1 + 1)]


def load() -> list[Case]:
    cases: dict[str, Case] = {}
    order: list[Case] = []
    for raw in CASES.read_text(encoding="utf-8").splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        cols = raw.split("\t")
        while len(cols) < 4:
            cols.append("")
        cid, kind, addr, value = cols[:4]
        if cid not in cases:
            cases[cid] = Case(cid, len(order) + 1)
            order.append(cases[cid])
        c = cases[cid]
        c.lines.append(raw)
        if kind == "sheet":
            c.sheets.append(addr)
        elif kind == "name":
            c.names.append((addr, value))
        elif kind == "probe":
            s, a = split_addr(c, addr)
            c.probes.extend((s, x) for x in expand(a))
        elif kind in ("cell", "legacy"):
            s, a = split_addr(c, addr)
            c.cells.append((kind, s, a.upper(), value))
        else:
            raise SystemExit(f"{CASES}: unknown kind {kind!r} in {raw!r}")
    return order


def file_formula(formula: str) -> str:
    body = oc.to_file_formula(formula)
    # `@(` -> `_xlfn.SINGLE(` outside string literals.
    parts = re.split(r'("(?:[^"]|"")*")', body)
    for i in range(0, len(parts), 2):
        parts[i] = parts[i].replace("@(", "_xlfn.SINGLE(")
        # `A1#` is stored as `_xlfn.ANCHORARRAY(A1)`.
        parts[i] = re.sub(r"(\$?[A-Za-z]{1,3}\$?[0-9]+)#", r"_xlfn.ANCHORARRAY(\1)", parts[i])
    return "".join(parts)


def cell_xml(kind: str, addr: str, value: str) -> str:
    if value.startswith("="):
        f = escape(file_formula(value))
        if kind == "legacy":
            return f'<c r="{addr}"><f>{f}</f></c>'
        return f'<c r="{addr}" cm="1"><f t="array" ref="{addr}">{f}</f></c>'
    k, payload = oc.typed_setup(value)
    return g.cell_xml(addr, k, payload)


def sheet_xml(cells: list[tuple[str, str, str]]) -> str:
    rows: dict[int, list[tuple[int, str]]] = {}
    for kind, addr, value in cells:
        x = cell_xml(kind, addr, value)
        if x:
            r, c = oc.a1(addr)
            rows.setdefault(r, []).append((c, x))
    body = "".join(f'<row r="{r}">' + "".join(x for _, x in sorted(rows[r])) + "</row>"
                   for r in sorted(rows))
    return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            f'<worksheet xmlns="{g.NS}" xmlns:r="{g.RNS}"><sheetData>{body}'
            "</sheetData></worksheet>\n")


def quote(name: str) -> str:
    return name if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", name) else \
        "'" + name.replace("'", "''") + "'"


def generate() -> int:
    cases = load()
    only = os.environ.get("PAGED_CALCMODEL_ONLY")
    if only:  # bisecting a workbook Excel refuses (-50): a regex over case ids
        cases = [c for c in cases if re.search(only, c.id)]
    sheets: list[str] = []
    content: dict[str, list[tuple[str, str, str]]] = {}
    names: list[tuple[str, str]] = []
    for c in cases:
        for s in [c.sheet] + c.sheets:
            if s in content:
                raise SystemExit(f"sheet {s!r} declared twice")
            sheets.append(s)
            content[s] = []
        for kind, s, a, v in c.cells:
            content[s].append((kind, a, v))
        names.extend(c.names)
    sheets.append(oc.LOCALE_PROBE_SHEET)
    content[oc.LOCALE_PROBE_SHEET] = [("cell", "A1", oc.LOCALE_PROBE_FORMULA)]
    n = len(sheets)
    ct = g.CONTENT_TYPES_HEAD + "".join(
        f'<Override PartName="/xl/worksheets/sheet{i}.xml" '
        f'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>\n'
        for i in range(1, n + 1)) + "</Types>\n"
    dn = ""
    if names:
        dn = "<definedNames>" + "".join(
            f'<definedName name="{escape(k)}">{escape(file_formula(v)[1:] if file_formula(v).startswith("=") else file_formula(v))}</definedName>'
            for k, v in names) + "</definedNames>"
    wb = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
          f'<workbook xmlns="{g.NS}" xmlns:r="{g.RNS}"><sheets>'
          + "".join(f'<sheet name="{escape(s)}" sheetId="{i}" r:id="rId{i}"/>'
                    for i, s in enumerate(sheets, 1))
          + f'</sheets>{dn}<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>\n')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + "".join(f'<Relationship Id="rId{i}" Type="{g.RNS}/worksheet" '
                      f'Target="worksheets/sheet{i}.xml"/>' for i in range(1, n + 1))
            + f'<Relationship Id="rId{n + 1}" Type="{g.RNS}/styles" Target="styles.xml"/>'
            + f'<Relationship Id="rId{n + 2}" Type="{g.RNS}/sheetMetadata" Target="metadata.xml"/>'
            + "</Relationships>\n")
    out = oc.build_dir() / f"{FAMILY}.xlsx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr("_rels/.rels", g.ROOT_RELS)
        z.writestr("xl/workbook.xml", wb)
        z.writestr("xl/_rels/workbook.xml.rels", rels)
        z.writestr("xl/styles.xml", g.STYLES)
        z.writestr("xl/metadata.xml", g.METADATA)
        for i, s in enumerate(sheets, 1):
            z.writestr(f"xl/worksheets/sheet{i}.xml", sheet_xml(content[s]))
    print(f"{FAMILY}: {len(cases)} case(s), {n} sheet(s) -> {out}")
    return 0


def read() -> int:
    cases = load()
    src = oc.build_dir() / f"{FAMILY}.excel.xlsx"
    if not src.exists():
        raise SystemExit(f"{src} missing — run drive.sh {FAMILY} first")
    rows = ["# Excel-recorded values for corpus/calc-model/cases.tsv (generated by "
            "oracle/excel/calcmodel.py read — do not hand-edit)",
            "# id\tfingerprint\tcell\ttype\tvalue"]
    with zipfile.ZipFile(src) as z:
        sst = rd.shared_strings(z)
        parts = rd.sheet_parts(z)
        rich = rd.rich_errors(z)
        pt, pv = rd.read_cell(z, parts[oc.LOCALE_PROBE_SHEET], "A1", sst)
        if (pt, pv) != ("s", oc.LOCALE_PROBE_EXPECTED):
            raise SystemExit(f"locale probe came back {pv!r} — refusing to record")
        n = 0
        for c in cases:
            fp = fnv1a("\n".join(c.lines))
            for s, a in c.probes:
                t, v = rd.read_cell(z, parts[s], a, sst, rich)
                cell = a if s == c.sheet else f"{s}!{a}"
                rows.append("\t".join([c.id, fp, cell, t, rd.esc(v)]))
                n += 1
    out = oc.oracle_dir() / "recorded" / f"{FAMILY}.tsv"
    out.write_text("\n".join(rows) + "\n", encoding="utf-8")
    print(f"{FAMILY}: recorded {n} cell(s) of {len(cases)} case(s) -> {out}")
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "generate":
        sys.exit(generate())
    if cmd == "read":
        sys.exit(read())
    raise SystemExit("usage: calcmodel.py generate|read")
