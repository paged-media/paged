# ADR 521 — Files and the formula dialect: macro workbooks, templates, ODS, CSV export, R1C1 and localized names

- **Status:** Accepted, 2026-10-23. Amends [ADR 509](509-excel-first-dialect.md) (the formula
  dialect); extends [ADR 503](503-xlsx-patched-not-regenerated.md) (what a save writes).
- **Scope:** `sheet-parser` (`dialect.rs`, `dialect/de.txt`), `sheet-xlsx` (`kind.rs`, `ods.rs`
  behind the `ods` feature), `sheet-js` (`core/files.rs`, `wasm_files.rs`), the bundle
  (`engine-files.ts`, the importers, exporters and commands in `activate.ts`,
  `layout-commands.ts`, the formula bar in `session.ts`).

## Context

The engine read `.xlsx` and delimited text and wrote `.xlsx`. Excel users also hand over
macro-enabled workbooks (`.xlsm`) and templates (`.xltx`, `.xltm`), LibreOffice users send
OpenDocument spreadsheets (`.ods`), and data leaves a workbook as CSV. The formula bar showed
Excel's en-US A1 dialect only (ADR 509): a workbook saved in R1C1 mode showed A1, and a German
user could not type `=SUMME(A1;B1)`.

## Decision

**Package kinds.** `.xlsx`, `.xlsm`, `.xltx` and `.xltm` are one OPC package; only the
workbook part's content type differs. They all open through `XlsxDocument::open`;
`XlsxDocument::kind()` reads the kind from `[Content_Types].xml`. The VBA project
(`xl/vbaProject.bin` and the parts it relates, its signature) is an opaque part like any
other: kept byte for byte, never parsed, never run. A template opens as a new workbook of the
same macro flavour (`.xltx` → `.xlsx`, `.xltm` → `.xlsm`): the content type is spliced at load
and the session starts unsaved. `set_kind` changes the kind as a byte splice of the one
`<Override>`; a kind without macros also removes the VBA parts, their overrides and the
workbook relationship, because Excel refuses an `.xlsx` that has them. `save_as(kind)` does
that on a copy, so the open workbook keeps its macros. The bundle's `.xlsx` exporter is
`save_as("xlsx")`; a new `.xlsm` exporter keeps the macros; persistence saves the workbook's
own kind.

**OpenDocument read.** `sheet_xlsx::ods::ods_to_xlsx` converts `content.xml` and `styles.xml`
into a SpreadsheetML package, the CSV import's pattern, which then opens like any workbook: an
imported ODS edits, saves as `.xlsx` and lowers with no ODS case downstream. It is read-only;
nothing is written as ODS. Mapping:

| OpenDocument | Workbook |
| --- | --- |
| `table:table` | a sheet, its name made legal and unique; a table style with `table:display="false"` hides it |
| `office:value-type` float / percentage / currency / date / time / boolean / string | number, serial date (1899-12-30 or 1904 null date), day fraction, boolean, text |
| `table:formula="of:=…"` | Excel text: `[.A1:.B2]` → `A1:B2`, `[Sheet2.C3]` → `Sheet2!C3`, `[A.A1:C.A1]` → `A:C!A1:A1`, `;` → `,`, `{1;2\|3;4}` → `{1,2;3,4}`, `!` → space, `COM.MICROSOFT.`/`LEGACY.` prefixes dropped; with the cached value |
| a union `~`, an external document | no formula: the cached value only |
| a function the engine does not know | kept as written; the load keeps its cached value (ADR 513) |
| `table:named-range`, `table:named-expression` | defined names |
| `number-columns-spanned` / `number-rows-spanned` | merged cells |
| data styles (number, percentage, currency, scientific, fraction, date, time, text; `style:map` sections, red negatives) | an Excel number-format code |
| bold, italic, underline, font colour, background, alignment, wrap (through parent styles) | the cell's xf |
| repeated rows and columns | expanded only where they hold content (a styled empty run is capped) |

Not mapped: column widths, row heights, borders, conditional formats, validations, charts,
images, comments.

**CSV export.** `export_csv(sheet, options)` writes the used range from A1 (or a given range)
with RFC 4180 quoting (a field with the delimiter, `"`, CR or LF is quoted, `"` doubled), CRLF
row ends and every row as wide as the range. Options: the delimiter (`,`, `;`, tab), formatted
values (what the cells show, as Excel's CSV save) or raw values (numbers in shortest
round-trip form, dates as serials), and a UTF-8 BOM. Formulas export their values. The bundle's
CSV exporter and the "Export sheet as CSV…" command write formatted values with a BOM and the
host language's list separator (`;` where `,` is the decimal sign); the typed `exportCsv`
command takes every option. What the export writes reads back through the CSV import.

**Display dialect (amends ADR 509).** Stored formulas stay the canonical en-US A1 text; the
display dialect is a text translation in front of the parser, so the AST, the parser and the
printer are untouched. Two axes:

- *Reference style*, per workbook. Excel keeps it as `<calcPr refMode="R1C1"/>`, so it is read
  from and written to the workbook (a byte splice of `<calcPr>`; A1 removes the attribute).
  R1C1 is relative to the formula's own cell: `R[1]C[-2]`, `R1C1`, `RC`, `C[2]` for a column,
  `R1:R3` for rows, mixed forms. A relative reference that leaves the sheet reads `#REF!`.
- *Language*, per session, from the host language. English is the identity. German comes from
  a data table, `sheet-parser/src/dialect/de.txt`: one `CANONICAL LOCAL` pair per line (321
  names, 5 KB in the wasm, parsed once), plus the separators (`;` between arguments, `,`
  decimal, `.` and `;` in array literals), the error words (`#NV`, `#WERT!`, `#BEZUG!` …), the
  booleans (`WAHR`, `FALSCH`), the structured-reference specifiers (`#Kopfzeilen` …) and the
  R1C1 letters (`Z1S1`, relative `Z(-1)S(2)`). A name the table lacks passes through both ways,
  so canonical names are always accepted; a test holds the table to a bijection that never
  maps onto another canonical name. A new language is a table and a `LangData` constant.

`to_display` re-spells the tokens of the parser's own lexer (whitespace kept);
`from_display` scans the localized text by hand, since `1,5` and `;` do not lex as English.
The session's `get_cell_edit_text` / `set_cell_display` and the wasm doors
`formula_to_display` / `formula_from_display` translate; the bundle applies them at the formula
bar and the cell editor only (`cellInputAt`, the F2 edit, `editCell`, the in-frame commit).
Journals, clipboard, object model and storage stay canonical. In the canonical dialect the
bundle makes no extra engine call (it learns the dialect once per load).

## Consequences

- Files the editor's Open offers now include `.xlsm`, `.xltx`, `.xltm`, `.ods` and `.ots`;
  the editor derives its accept list from the importers, so it needed no change.
- The wasm grew from 3,039,034 to 3,150,183 bytes (+109 KiB): the ODS reader about 73 KiB, the
  dialect, kinds, CSV export and doors about 36 KiB. `sheet-xlsx`'s `ods` feature (default on;
  `sheet-js` forwards it) drops the reader from a build that wants the smaller wasm.
- `.xls`, `.xlsb` and writing ODS are not built. Languages other than English and German show
  English names (with their own separators only once they have a table). Typed values in the
  cell editor keep their own locale rules (ADR 511); only formulas translate.

## Evidence

- `sheet-parser/src/dialect.rs` tests — R1C1 relative/absolute/mixed both ways, German names,
  separators, arrays, errors, structured references, the table bijection.
- `sheet-xlsx/src/ods.rs`, `kind.rs` tests — OpenFormula translation, dates and durations,
  data styles to format codes, kinds.
- `sheet-js/tests/it/w5_files.rs` — xlsm round trip with the VBA project byte-identical, xlsm
  saved as xlsx, templates opening as workbooks, CSV export and its round trip through the CSV
  import, R1C1 persisting in `<calcPr>`, German entry and display, an ODS with every value
  type, formulas, styles, a merge, a hidden sheet and a named range.
- `packages/sheet-bundle/test/files-dialect.spec.ts`, `test/headless/files-dialect.headless.test.ts`
  — the importers, exporters and commands through the bundle, the formula bar in R1C1 and German.
