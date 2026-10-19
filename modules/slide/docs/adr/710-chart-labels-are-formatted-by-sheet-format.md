# ADR 710 — Chart labels are formatted by sheet-format

- **Status:** Accepted 2026-10-19.
- **Scope:** `slide-chart` (`format_number` and the value-axis tick labels)

## Context

A chart's axis, data and pie labels print numbers in the chart's Excel number-format code
(`c:numFmt formatCode`). slide-chart read those codes itself: `General`, `0`, `0.0…`, `#,##0…`
and a trailing `%`, from the first section only, rounding the way Rust's formatter does (half
to even on the binary value). Every other code lost its meaning: a currency literal
(`"$"#,##0`), a locale token (`[$€-407]`), a negative section (`#,##0;(#,##0)`), scientific
(`0.0E+00`) and dates printed as the bare number, and `2.5` in `0` printed `2`.

PowerPoint labels a chart with the number-format engine Excel uses for cells. paged.sheet has
that grammar, measured against Excel (ADR 509 and its format corpora), in sheet-format.

## Decision

`format_number` is sheet-format's renderer: the code is compiled once per call, rendered en-US
in the 1900 date system, and a code that does not compile renders as `General`. A value-axis
tick that is zero up to rounding (an explicit minimum such as −0.6 stepped by 0.2 lands on
1.1e-16) is labelled as zero, as PowerPoint labels it, because sheet-format's `General`
would print the residue (`1.11022302462516E-16`).

The pie's percentage label (`showPercent`) is not a format code and keeps its own rounding.

slide depends on modules/sheet's sheet-format and sheet-core by path (PM-0005: built-ins depend
on each other through the workspace).

## Consequences

- Measured over 19 codes and the value grids slide-chart produces: `General` is unchanged
  except for tiny values (`1E-11`, was `0`) and the 15-significant-digit rule
  (`1/3` → `0.333333333333333`, was `0.3333333333`). The other codes now round half away from
  zero (`2.5` → `3`, `0.125` in `0.00` → `0.13`), print no `-0`, and keep their literals,
  sections, locale tokens, scientific form and dates.
- The corpus decks' four charts and the slide fixtures, which all use `General`, lay out
  byte for byte as before.
- `slide_js_bg.wasm` carries the format engine: +51,812 B on its own. It lands with slide's
  zip change (zopfli and zlib-rs leave the module), which takes more than that back.
- A change in sheet-format, sheet-core or the function registry (sheet-core's build reads it)
  runs slide's workflows.
