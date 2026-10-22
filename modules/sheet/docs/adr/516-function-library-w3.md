# ADR 516 — The function library towards Excel's full set (W3): rulings, the oracle as the source of expected values, and the document-name amendment

- **Status:** Accepted, 2026-10-23. Extends [ADR 507](507-golden-corpora-coverage-gate.md)
  (goldens) with recorded expected values; amends the frozen `SheetModel` and `EvalCtx` (one field each).
- **Scope:** `registry/functions/{eng,math3,text3,info3,array3,…}.yaml`, `sheet-fn` (the new
  families, `special.rs`, `coerce.rs`, `ctx.rs`), `sheet-calc/src/eval/info.rs`, `sheet-core/src/model.rs`,
  `sheet-js`, the bundle facade, `sheet-conformance` (golden replay, oracle lane).

## Context

At 263 of Excel's 523 worksheet functions the library left whole categories out (engineering,
complex numbers, regular expressions, the information functions). Adding ~250 functions by
reading documentation alone would encode guesses: the documentation does not say that
`BITLSHIFT(1,49)` is 0 while `BITLSHIFT(1,48)` is `#NUM!`, that `CEILING.MATH(4.42,0.01)` is
`4.42`, or which digits `BESSELJ` returns.

## Decision

1. **Every expected value is recorded from Excel.** A new function lands with its golden cases
   (typical, edges, each error path, an array argument; ~15 points across the parameter space
   for the numerical ones) written first with `?`, recorded through the Excel oracle lane, and
   filled from the recording. The engine is then fixed until it agrees; what cannot agree is a
   `divergences.tsv` row with its reason (a ruling, a defect, or a harness artifact such as a
   function Excel for Mac lacks).
2. **Agreement is numeric.** The golden replay and the oracle lane accept numbers — and the
   parts of a complex-number text — within a relative `1e-12`: platform math libraries differ
   in the last of 15 digits (macOS and Linux disagreed on `IMCOSH("3+4i")`).
3. **Excel's own approximations where Excel uses them.** The Bessel functions reproduce the
   classic Abramowitz & Stegun / Hart approximations Excel evaluates (two of Excel's `BESSELJ`
   coefficients differ from the published ones; recovered by a fit over 76 recorded values).
4. **Storage prefixes from Excel's own save.** A function's `xlfn_prefix` is what Excel wrote
   when it saved the recorded workbook, not a list from memory.
5. **Number-to-text is Excel's conversion** (`coerce::to_text`): 15 significant digits, fixed
   while that takes at most 20 characters, scientific beyond (recorded through `CONCAT`).
6. **Amendment: `SheetModel::document_name: Option<CompactString>`.** The host's name for the
   document (a file name), read by `CELL("filename")` (`[name]sheet`) and by `CELL("address")`
   on another sheet; `None` is an unsaved workbook (`""`, as in Excel). Not written to the
   file. Set through `Engine::set_document_name` / `setDocumentName` after a load.
7. **Amendment: `EvalCtx::locale`** (additive; `EvalCtx::new` keeps en-US, the evaluator sets
   the workbook's through `with_locale`). `TEXT` reads its code in the en dialect and renders it
   in that locale (`1.234,50` in a German workbook), as Excel renders a format code in the
   user's locale.
8. **Row visibility.** SUBTOTAL 1–11 skip filter-hidden rows, 101–111 and AGGREGATE's options
   1/3/5/7 every hidden row; nested SUBTOTAL/AGGREGATE results are skipped under every
   AGGREGATE option (Excel-recorded, 4–7 included). The evaluator masks the cells before the
   kernel; hiding rows (`Engine::set_rows_hidden`) or filtering recalculates the formulas that
   call them.
9. **Information functions are special forms.** `SHEET`, `SHEETS`, `CELL`, `INFO`,
   `ISOMITTED` read the model or the unevaluated argument (`sheet-calc/src/eval/info.rs`);
   `INFO` answers for the engine (`system` is `pcdos`, `release` `16.0`).
10. **Regular expressions** use `fancy-regex` (MIT) with trimmed Unicode tables (+650 KB wasm);
   `\p{L}` and `\p{N}` map onto the Perl classes, other property classes are `#VALUE!`.

## Consequences

- The oracle lane is the function library's specification; re-recording is a maintainer step
  on a Mac with Excel (`sheet-conformance/oracle/excel/`), CI replays the recordings.
- Behaviour that only Windows Excel has (`ENCODEURL`, `FILTERXML`, `EUROCONVERT`) follows the
  reference and stays listed until a Windows recording exists.
