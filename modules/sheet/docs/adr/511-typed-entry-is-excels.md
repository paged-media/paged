# ADR 511 — A typed cell entry is stored the way Excel stores it

- **Status:** Accepted 2026-10-22.
- **Scope:** `sheet-format/src/entry.rs`, `Engine::enter` / `Engine::parse_entry_at` in
  `sheet-calc`, `SheetSession::set_cell` / `set_cells` and the CSV import in `sheet-js`, the
  built-in number-format table in `sheet-xlsx`, the cell-edit journal in `sheet-bundle`

## Context

`Engine::enter` recognised numbers, booleans and error literals; everything else became text.
`45%`, `$1,234.50`, `1/2`, `2024-01-15` and `9:30 PM` were stored as text, so they did not
calculate, sort or format. The CSV import had its own, smaller typing (`type_field`). An
Excel-like grid needs what a person types to land the way Excel stores it: a value and, often,
a number format.

What Excel does was not taken from memory. The Excel oracle got an ENTRY lane
(`sheet-conformance/oracle/excel/drive.sh --entry <locale>`): 220 raw texts typed into a cell
of Excel 16.114 for Mac under en-US, 71 under each of de-DE, fr-FR, es-ES and it-IT (region
changed, UI language kept English), and 522 texts typed into cells pre-formatted with 29
formats. The stored value, its type, the cell's number format and the quote prefix are
recorded in `recorded/entry*.tsv`.

## Decision

One pure parser, `sheet_format::entry::parse_entry(raw, ctx) -> Entry { value, hint,
quote_prefix }`, types every entry: the session's cell entry and the CSV import. Its rules are
the recorded ones (the module documentation lists them). Choices beyond the recording:

- **The implied format is a `FormatHint`, applied by the session.** The engine stores the
  value; `SheetSession` applies the format through the existing style path, after Excel's
  rule, recorded on the pre-formatted cells (`resolve_format`): a General cell takes the
  hint; a cell whose format is one Excel assigns from typing (percent, scientific, fraction,
  date, time, currency) takes a hint of another category; the thousands hint never replaces
  a format; plain number formats and custom formats stay. A Text (`@`) cell stores what was
  typed verbatim. The restyled cells are reported (`restyled`), and the bundle journals value
  and style as one undo step; the style is put back after the prior input is re-typed.
- **The quote prefix is a style attribute.** A leading `'` stores the rest as text and sets
  `quotePrefix="1"` on the cell's `<xf>`, as Excel does; typing without it clears the
  attribute. A text that would re-type as something else is re-entered (`get_cell_input`)
  with its `'`, so undo, copy and replace keep it text.
- **Month names are English in every locale**, and `TRUE`/`FALSE` are English: the recording
  ran with Excel's UI language English, and the engine's dialect is en-US (ADR 509). The
  region sets separators, date order and the currency.
- **Built-in format 14 is `m/d/yy`, 47 is `mm:ss.0`.** ECMA-376 lists `mm-dd-yy` and
  `mmss.0`; Excel reports and renders the ids as `m/d/yy` and `mm:ss.0`. Built-in 14 is the
  system short date, so the euro locales' typed dates get explicit codes (`dd\.mm\.yyyy`,
  `dd/mm/yyyy`), and their currency is `#,##0.00 "€";[Red]-#,##0.00 "€"`.
- **Digits past the fifteenth significant one are truncated**, as Excel does. A number cell
  re-entered from its shortest text (undo) therefore keeps 15 significant digits.
- **The CSV import keeps two of its own rules:** a leading `=` stays text, and a
  group-separated number imports in General (its existing behaviour and regression tests).
  Everything else a CSV field implies — currency, time, fraction, quote prefix, error
  literals — follows typed entry.
- **Recorded disagreements** (`oracle/excel/entry-divergences.tsv`): `#GETTING_DATA` stays
  text (the model has no such error; Excel saves it as `#N/A`), and fr-FR currency is a
  trailing `€` as Microsoft documents it, where the recording took the position from the
  recording machine's system region.

## Consequences

- en-US agreement: 215 of 216 texts through the parser, 741 of 742 through `set_cell`; de-DE,
  es-ES and it-IT 71 of 71; fr-FR 63 of 71; every other row is listed with its reason. A
  property test checks that a typed value's display re-types to the same value in all five
  locales.
- A workbook cell with format 14 now shows `1/15/24`, not `01-15-24`.
- New recordings need Excel on a Mac; CI replays the committed files.
