# ADR 516 — The function library towards Excel's full set (W3): rulings, the oracle as the source of expected values, and the document-name amendment

- **Status:** Accepted, 2026-10-23. Extends [ADR 507](507-golden-corpora-coverage-gate.md)
  (goldens) with recorded expected values; amends the frozen `SheetModel` and `EvalCtx` (one field each).
  Part 2 (decisions 11–16) adds the statistical and financial functions.
- **Scope:** `registry/functions/{eng,math3,text3,info3,array3,stat3,fin2,…}.yaml`, `sheet-fn` (the new
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

### Part 2 (2026-10-23): statistics and financial functions

11. **Own numerics, no statistics crate.** `special.rs` carries ln Γ (Lanczos on (0.5, 10),
    Stirling beyond, the ζ series of ln Γ(1+z) around the zeros at 1 and 2), the regularised
    incomplete gamma (series / continued fraction, the prefactor kept accurate for a large
    shape) and beta functions (continued fraction, the hypergeometric series near the mean of
    a very large parameter, logarithms from the accurate small one of `x` and `1 − x`),
    Loader's binomial and Poisson densities, and Brent's bracketed root finder. Every inverse
    (`BETA.INV`, `CHISQ.INV`, `F.INV`, `T.INV`, `GAMMA.INV`, …) solves on the smaller tail for
    the smaller of `z` and `1 − z` to a few ulps; the recordings agree to 1e-12 except at
    `10^10` degrees of freedom and alpha `1E-9`, where Excel's own value is the less accurate
    one (listed).
12. **Legacy names keep their legacy arguments** (`CHIDIST`/`FDIST`/`FINV`/`CHIINV` right-tailed,
    `TDIST` with tails and no negative `x`, `TINV` two-tailed, the density-only `HYPGEOMDIST`
    and `NEGBINOMDIST`), sharing the kernels of the new names. Domain edges follow the
    recordings, not the reference where they differ (`T.INV.2T` accepts a probability in (1, 2);
    `HYPGEOM.DIST` outside its support is 0, not `#NUM!`; `PROB` checks only the sum of the
    probabilities).
13. **`FORECAST.ETS` is the published AAA method, and diverges.** Microsoft names the model but
    not its optimiser or initial states. The engine starts from a classical decomposition and
    minimises the one-step squared error over α, β, γ; seasonality is the strongest
    autocorrelation peak of the detrended series (it agrees on every recorded case). Forecasts
    agree where the series fits the model exactly; elsewhere the four functions are listed
    divergences, not guessed tuning.
14. **Financial conventions the reference leaves open are recorded.** One coupon schedule
    (back from maturity, month ends kept for a month-end maturity) drives `COUP*`, `PRICE`,
    `YIELD`, `DURATION`; the days to the next coupon in the bond formulas are
    `COUPDAYS − COUPDAYBS`; the 30/360 variants differ by function family (coupon/discount,
    `PRICEMAT`/`YIELDMAT`, odd last period); `AMORDEGRC`'s coefficients (1.5 to a life of 4
    years, 2 to 6, 2.5 beyond, `#NUM!` below 2) and its last-two-periods rule come from the
    recordings. The long odd first period follows the documented formula, which Excel's values
    do not match (listed).
15. **`FIXED` and `DOLLAR` render in the workbook's locale**, `DOLLAR` with the locale's currency
    pattern (recorded from Excel under each region: `1.234,57 €`, `€1 234,57`, `($1,234.57)`).
16. **Size.** `dispatch_rich` routes scalar rows through `dispatch` instead of inlining a second
    copy of every scalar kernel, and `lookup_func` is a binary search over a sorted table instead
    of a generated `match`; together −23 KB of wasm. `opt-level = "z"` would save 0.3 MiB but
    halves calculation speed (measured), so the release profile stays at `"s"`.

## Consequences

- The oracle lane is the function library's specification; re-recording is a maintainer step
  on a Mac with Excel (`sheet-conformance/oracle/excel/`), CI replays the recordings.
- Behaviour that only Windows Excel has (`ENCODEURL`, `FILTERXML`, `EUROCONVERT`) follows the
  reference and stays listed until a Windows recording exists.
