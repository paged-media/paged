#!/usr/bin/env python3
# paged.sheet — Excel oracle ENTRY lane: the raw texts a person types.
#
# Each case is (id, raw): `raw` is set into a cell exactly as typed (no
# formula wrapper), and Excel's stored value, value type, number format and
# quote prefix are recorded (entry.py). The Rust lane
# (sheet-conformance/tests/it/entry_oracle.rs) replays the recording through
# `sheet_format::entry::parse_entry` and the session's `set_cell`.
#
# Case ids are stable: add new cases at the end of a group, never renumber.

from __future__ import annotations

EN_US: list[tuple[str, str]] = []


def group(prefix: str, raws: list[str]) -> None:
    for i, raw in enumerate(raws, 1):
        EN_US.append((f"{prefix}-{i:02d}", raw))


group("num", [
    "0", "42", "-42", "+42", "3.14", "-0.5", ".5", "5.", "00123", " 12",
    "12 ", "1 2", "1,234", "1,234.5", "1,234,567.89", "12,34", "1,2345",
    "-1,234", "(123)", "(1,234.50)", "1.2.3", "--5", "+-5", "5-", "5+",
    "1_000", "0x1F", "inf", "NaN", "- 5", "1 000", "-0", "1,234.", ",5",
])
group("sci", [
    "1e3", "1.2E-5", "-1e3", "1E+20", "2.5e10", "1e400", "1e-400", "1e",
    "e5", "1.5e3%", "1,000e2", "1E308", "1 e3",
])
group("digits", [
    "12345678901234567890", "0.1234567890123456789", "123456789012345.678",
    "9999999999999999", "1234567890123456", "-98765432109876543",
    "0.000000000000000012345678901234567", "123456789012345",
])
group("pct", [
    "45%", "12.5%", "12.5 %", "-3%", "%45", "45%%", "0.5%", "1,234%",
    "(5%)", "100%", "0%", "1e2%", "$5%", "12.345%", "-12.5 %",
])
group("cur", [
    "$1,234.50", "$1234", "$-5", "-$5", "($5)", "($1,234.56)", "$ 5", "5$",
    "$1.5", "$0.99", "€5", "£5", "$1e3", "$1,234", "$.5", "+$5", "$1,234.567",
    "$12.3456", "$-1,234.50", "$(5)",
])
group("frac", [
    "0 1/2", "1 1/4", "-1 1/4", "2 3/8", "1/2", "3/4", "1/4", "12/31",
    "13/1", "1/13", "0 3/4", "5 0/4", "1 12/25", "1/0", "0/1", "10 1/3",
    "1 2/3", "1 1/100", "0 1/1000", "1 3/2",
])
group("date", [
    "2024-01-15", "2024/01/15", "1/15/2024", "1/15/24", "01/15/2024",
    "12/31/1899", "1/1/1900", "2/29/1900", "3/1/1900", "2/29/2024",
    "2/30/2024", "15-Jan", "15-Jan-2024", "15-Jan-24", "Jan 2024", "Jan-24",
    "January 15, 2024", "January 15 2024", "15 January 2024", "Jan 15",
    "January 2024", "Jan 15, 2024", "15.01.2024", "2024-1-5", "1/15", "1-15",
    "1/2024", "13/1/2024", "1/1/10000", "12/31/9999", "2024-13-01",
    "Monday, January 15, 2024", "mar 5", "MAR 5", "Sept 5", "5-mar",
    "1-2-3", "1/1/29", "1/1/30", "1/1/00", "2024.01.15", "15/Jan/2024",
])
group("dt", [
    "1/15/2024 9:30", "1/15/2024 9:30 PM", "2024-01-15 13:45",
    "2024-01-15T13:45", "1/15/2024 13:45:10", "15-Jan 9:30", "9:30 1/15/2024",
])
group("time", [
    "9:30", "9:30 PM", "9:30PM", "9:30 pm", "9:30 a", "13:45:10", "0:00",
    "24:00", "25:30", "9:30:15 AM", "12:00 AM", "12:00 PM", "9 PM", "9PM",
    "1:30:45.5", "100:00", "9:75", "-9:30", "9:30:60", "12:30:00.123",
    "13:30 PM", "0:90", "9:5",
])
group("bool", ["TRUE", "false", "True", "FALSE ", " TRUE", "yes"])
group("err", [
    "#N/A", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#NULL!",
    "#SPILL!", "#CALC!", "#GETTING_DATA", "#n/a", "#BOGUS", "#N/A ",
])
group("text", [
    "'123", "'=1+1", "'TRUE", "'abc", "''x", "abc", "Q1 2026", "1st", "A1",
    "N/A", "'45%", "'1/2", "'", "' 12", "x 12",
])
group("formula", ["=1+1", "=SUM(1,2)", "=1/0", "=\"a\"&\"b\""])


# ── the other display locales: one template, the locale's own spellings ──
# (separators, currency symbol placement, date order, month names). Run
# under that region with the UI language kept en-US (drive.sh --entry
# <locale>); recorded to recorded/entry-<lang>.tsv when a run is reliable.
LOCALE_SPELLING = {
    # locale: (decimal, group, month Jan abbr, month January full)
    "de-DE": (",", ".", "Jan", "Januar"),
    "fr-FR": (",", " ", "janv.", "janvier"),
    "es-ES": (",", ".", "ene", "enero"),
    "it-IT": (",", ".", "gen", "gennaio"),
}


def locale_cases(locale: str) -> list[tuple[str, str]]:
    d, g, jan, january = LOCALE_SPELLING[locale]
    raws = [
        # numbers and groups
        f"3{d}14", f"-0{d}5", f"1{g}234", f"1{g}234{d}5", f"1{g}234{g}567{d}89",
        f"1{d}234", f"12{g}34", f"1{g}2345", f"({1}{g}234{d}50)", f"{d}5",
        "1.5", "1,5", "1 234", "1 234",
        # scientific
        f"1{d}2E-5", "1e3", f"2{d}5e10",
        # percent
        "45%", "45 %", f"12{d}5 %", f"12{d}5%", "-3 %",
        # currency
        f"1{g}234{d}50 €", f"1{g}234 €", "5 €", "-5 €", "5€", f"€1{g}234{d}50",
        "€ 5", "$5", f"({5} €)",
        # fractions
        "0 1/2", "1 1/4", "1/2", "3/4", "13/1",
        # dates
        "2024-01-15", "15.01.2024", "15.1.2024", "15.1.24", "15/01/2024",
        "15/1/24", "1/15/2024", "15.1.", "15.1", "1.2", "15-01-2024",
        f"15. {january} 2024", f"15 {january} 2024", f"15-{jan}-2024", f"15-{jan}",
        f"{jan} 2024", f"{january} 2024", "1/2024", "31.12.9999", "29.2.1900",
        # date + time, times
        "15.01.2024 9:30", "2024-01-15 13:45", "9:30", "13:45:10", "9:30 PM",
        "24:00", "9,5", "1:30:45,5", "1:30:45.5",
        # bool, error, text
        "TRUE", "WAHR", "VRAI", "#N/A", "'123", "abc",
    ]
    return [(f"{locale}-{i:02d}", raw) for i, raw in enumerate(raws, 1)]


# ── entry into a PRE-FORMATTED cell: (id, raw, number format set first) ──
# Does a typed entry's implied format replace a format the cell already has?
PRE_FORMATS = [
    "0.00", "m/d/yyyy", "@", "0%", "h:mm",
    # every builtin a typed entry can imply, the other builtins, customs
    "0", "#,##0", "#,##0.00", "0.00%", "0.00E+00", "# ?/?", "# ??/??",
    "m/d/yy", "d-mmm-yy", "d-mmm", "mmm-yy", "h:mm AM/PM", "h:mm:ss AM/PM",
    "h:mm:ss", "m/d/yy h:mm", "mm:ss", "[h]:mm:ss", "mm:ss.0",
    "$#,##0_);[Red]($#,##0)", "$#,##0.00_);[Red]($#,##0.00)", "0.000",
    "yyyy-mm-dd", "0.0%", "General",
]
PRE_RAWS = ["45%", "1/15/2024", "$5", "1,234", "1e3", "9:30", "0 1/2", "123",
            "TRUE", "'x", "15-Jan", "1,234.5", "Jan 2024", "9:30 PM",
            "1/15/2024 9:30", "12.5%", "$1.50", "13:45:10"]
PREFORMATTED: list[tuple[str, str, str]] = [
    (f"pre-{fi + 1}-{ri + 1:02d}", raw, fmt)
    for fi, fmt in enumerate(PRE_FORMATS)
    for ri, raw in enumerate(PRE_RAWS)
]
