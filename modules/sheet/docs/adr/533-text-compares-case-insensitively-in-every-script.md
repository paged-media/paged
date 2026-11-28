# ADR 533 — Text compares case-insensitively in every script, through one fold

- **Status:** Accepted, 2026-11-28. Amends the frozen `sheet-core` (an additive module and a
  behaviour change of `coerce` and `criteria` for text outside ASCII).
- **Scope:** `sheet-core/src/casefold.rs` (new) and its callers in `sheet-core`, `sheet-calc`,
  `sheet-fn`, `sheet-js`, `sheet-xlsx` and `sheet-parser/src/rewrite.rs`; `sheet-parser/src/lexer.rs`
  (names and unquoted sheet names take letters of any script).

## Context

Case was folded with the ASCII rule at each call site. `="Ä"="ä"` was `FALSE`, a lookup for
`übersicht` missed `Übersicht`, and a sheet named `Übersicht` could not be referenced without
quotes because the lexer took ASCII letters only. Excel folds case in every script.

## Decision

1. **One fold.** `casefold` maps a character to the lower case of its one-character capital
   (`Ä` = `ä`, `ς` = `σ`, `Я` = `я`). A character whose capital is several characters (`ß`) stays
   itself. Comparison operators, `coerce::compare`, criteria and wildcards, the lookup functions,
   `UNIQUE`, the database functions, sort, filter, find, fill and validation lists, and the lookup
   of sheets, tables, columns and defined names all go through it.
2. **Left on ASCII on purpose:** keywords, error codes, function names, format codes and OPC
   part names, which are ASCII by definition.
3. **Names.** A defined name or an unquoted sheet name takes letters and digits of any script,
   `_` and `.`.

## Measured against Excel, and what is still different

Excel for Mac 16.114, 2026-11-28, formulas typed into a new workbook:

| Formula                              | Excel   | paged   |
| ------------------------------------ | ------- | ------- |
| `="Ä"="ä"`, `="É"="é"`, `="Я"="я"`   | `TRUE`  | `TRUE`  |
| `="ς"="σ"`                           | `TRUE`  | `TRUE`  |
| `="e"="é"`, `="Æ"="AE"`              | `FALSE` | `FALSE` |
| `="İ"="i"`, `="I"="ı"`               | `FALSE` | `FALSE` |
| `MATCH("ss",…)` / `VLOOKUP` on `ß`   | `#N/A`  | `#N/A`  |
| `SEARCH("ss","ß")`                   | error   | error   |
| `EXACT("ß","ss")`                    | `FALSE` | `FALSE` |
| `="ß"="ss"`, `="ß"="SS"`             | `TRUE`  | `FALSE` |
| `="ﬁ"="fi"`, `="ﬀ"="FF"`             | `TRUE`  | `FALSE` |
| `="Ａ"="A"` (full-width)             | `TRUE`  | `FALSE` |
| `COUNTIF`/`SUMIF` criterion `ss` on `ß` | match | no match |
| `XLOOKUP("ss",…)` on `ß`             | found   | `#N/A`  |

So Excel uses two rules: the comparison operators, criteria and `XLOOKUP` fold a character to
its full, possibly several-character form and ignore width; `MATCH`, `VLOOKUP` and `SEARCH`
fold one character to one. paged has the second rule everywhere. The first is open: it needs a
second, full fold for those three callers, and a recording on Excel for Windows, which may
differ.

## Consequences

- Evidence: `sheet-core/src/casefold.rs` (unit tests), the lexer tests for names in other
  scripts, and the conformance suite, unchanged in its results.
- A workbook that relied on `"Ä"<>"ä"` computes differently; Excel computes it the new way.
