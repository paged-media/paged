# ADR 513 — The calculation model: the W1.0 amendment of the frozen types, spill of any array, `@`, 3D references, named LAMBDA, short-circuit, 15 digits, manual calculation

- **Status:** Accepted, 2026-10-22. Amends [ADR 509](509-excel-first-dialect.md) (unknown names)
  and [ADR 502](502-recalculation-and-spill.md) (what spills). The circular-reference ruling is
  [ADR 514](514-circular-references.md).
- **Scope:** `sheet-core` (`value.rs`, `ast.rs`, `calc_settings.rs`, `build.rs`), the registry
  schema (`registry/functions/*.yaml`), `sheet-parser`, `sheet-fn` (`build.rs`, `coerce.rs`,
  `criteria.rs`, the array kernels), `sheet-calc`, `sheet-format` (`as_displayed`),
  `sheet-xlsx` (`<calcPr>`, error storage), `sheet-js` and the bundle facade.

## Context

The engine is meant to behave like Excel 365 inside a frame. Measured against Excel before this
change: `=A1:A3`, `=A1:A3*2` and `=IF(A1:A3>1,A1:A3,0)` typed into a cell gave `#VALUE!` or one
value where Excel spills three; `@`, 3D references (`Jan:Mar!A1`) and a call of a named LAMBDA
did not parse; an unknown name or function was a parse error, so the cell refused the text;
`IF` evaluated both branches, so a recursive LAMBDA could not terminate; `#CALC!` and the other
Excel 365 errors had no value, so the kernels grounded them to `#VALUE!`/`#N/A`;
`=0.1+0.2=0.3` was FALSE; a workbook could only calculate automatically.

The `sheet-core` types, the AST and the registry schema are frozen and change only by a
versioned amendment. This record is that amendment (W1.0) and the calculation model built on it.

## Decision

### The amendment (W1.0)

1. **`CellError`** gains `Calc`, `Field`, `Busy`, `Connect`, `Blocked`, `Unknown` (`#CALC!` …
   `#UNKNOWN!`), with `CellError::type_number` — Excel's `ERROR.TYPE` numbers, `#SPILL!` 9
   through `#BUSY!` 15 (recorded: `ERROR.TYPE(SEQUENCE(0))` is 14). A cell stores them; the xlsx
   writer stores the six (and `#SPILL!`) as `#VALUE!`, as Excel does (Excel adds a rich value
   naming the real error, which the writer does not emit). Typed into a cell they stay text
   (ADR 511): only the classic codes are typeable.
2. **AST.** `Expr::Ref3D` / `Expr::Range3D` over a `SheetSpan { first, last }` (sheet ids are
   positions, so a span is a run of ids); `UnOp::ImplicitIntersect` (`@`, stored as
   `_xlfn.SINGLE(…)`); `Expr::UnknownName(text)` and `Expr::UnknownFunc(text, args)`.
3. **Registry schema.** `lazy_args` (IF, IFS, IFERROR, IFNA, CHOOSE, SWITCH), `cached_only:
   connect | blocked` (WEBSERVICE and CUBEVALUE so far; the W3 wave adds the rest), and
   `xlfn_prefix` — the storage prefix moved from the hand list in `sheet-parser/src/future.rs`
   into the rows (the same 67 names; nothing printed differently).
4. **`CalcSettings`** gains `calc_mode: Auto | AutoNoTable | Manual`, `full_precision` and
   `full_calc_on_load`, read from and written to `<calcPr calcMode fullPrecision
   fullCalcOnLoad>`; an attribute at its default the file does not carry stays absent.

### The calculation model

- **Unknown names** (amends ADR 509). An identifier no defined name or LET/LAMBDA local spells is
  `UnknownName`; a call of a function the registry lacks is `UnknownFunc` — unless a defined name
  spells it, which makes it `Call(Name(id), args)`, a named LAMBDA. Both evaluate to `#NAME?`
  (an unknown function's arguments are never evaluated) and print as written. Building the
  engine re-resolves them against the names then defined (`names::resolve_unknowns`), so
  defining a name repairs the formulas that used it. On load, an unknown future function keeps
  its `_xlfn.` prefix (`_xlfn.REGEXTEST(…)`), as an Excel that lacks it shows it, so a save keeps
  it readable to a newer Excel. A formula that calls an unknown or `cached_only` function keeps
  the value its file cached (`eval::keeps_cached_value`): "unknown" is this engine's view, not
  necessarily the saving Excel's. With no cached value it shows the error.
- **Spill of any array root** (amends ADR 502). A formula typed into the engine is a
  dynamic-array formula, as in Excel 365: `eval::root_may_spill` (a range or array, an operator
  or scalar function over one, a `returns_array` call, a lambda call, OFFSET with a size, INDEX
  with a 0 selector, INDIRECT, `a:b`) marks it `Worksheet::dynamic_arrays`, and the result's
  shape decides what spills. The array path (`eval/lift.rs`) also evaluates lambda calls and the
  reference-returning forms as blocks. A formula loaded WITHOUT the dynamic-array mark is
  legacy and never starts spilling: the loader inserts the `@` Excel 365 shows for it
  (`sheet_calc::legacy`) — before a range in a value position (the root, an operand, an
  argument of a scalar-parameter function, a lookup key) and inside an array expression handed
  to a function without an array-class parameter (`SUM(@A1:A3*2)`; `SUMPRODUCT`, `INDEX`,
  `LARGE`, … keep their arrays). It then evaluates like any formula, reads as Excel shows it,
  and a range where one value is expected reduces to the cell in the formula's row or column, or
  `#VALUE!` (recorded: `legacy-*`, `legacy2-*`). An empty array is `#CALC!` (SEQUENCE(0), an empty FILTER, TAKE(x,0), DROP of
  everything, a lambda as a value); SEQUENCE(-2) stays `#VALUE!` (recorded).
- **`@`.** A reference reduces by implicit intersection, an array to its first element, a value
  to itself (`@SEQUENCE(3)` is 1, `@{7,8,9}` is 7).
- **3D references.** The dependency graph registers one box per sheet of the span. SUM,
  AVERAGE(A), COUNT(A), MAX(A), MIN(A), PRODUCT, STDEV(A/P/PA/.S/.P), VAR(A/P/PA/.S/.P) receive
  the span as consecutive range arguments, one per sheet (their kernels are variadic over
  ranges, so the `Arg` convention stays as frozen); any other function is `#VALUE!` and a 3D
  reference as a value `#REF!`, ISREF FALSE (recorded). Deleting a sheet of a span moves its end
  inward, deleting the only sheet makes it `#REF!`. Row and column inserts do not move a 3D
  reference: one reference cannot express a box that moved on one sheet of its span.
- **Short-circuit.** For a `lazy_args` row the evaluator evaluates the deciding arguments
  first and hands the kernel the call with each decided argument replaced by its value and
  every branch it will not return replaced by an omitted argument (`eval::lazy_args`): the
  kernels are unchanged, the untaken branch reads no cell (measured: 0 cells read, 0 ranges
  built, against 10 000 for the taken SUM), and `extract_refs` still registers every branch. A
  deciding argument that is an array keeps the element-wise path. Lambda calls nest at most
  128 deep; deeper is `#NUM!`, not a stack overflow.
- **15 significant digits.** The comparison operators treat numbers equal at 15 significant
  digits as equal (`coerce::eq15`; `=0.1+0.2=0.3` TRUE, `=1+1E-15=1` TRUE, `=1+1E-14=1` FALSE),
  and so do the criteria of COUNTIF/SUMIF and their accelerator indexes; MATCH, VLOOKUP and
  XMATCH compare exactly (recorded: `#N/A` for 0.1+0.2 against 0.3). The LAST operation of a
  formula, when it is `+` or `-`, snaps a result within 2^-48 of the larger operand to 0
  (`eval::eval_root`: `=0.1+0.2-0.3` is 0, `=1*(0.1+0.2-0.3)` 5.55E-17,
  `=2.675-2.67-0.005` −1.07E-16): "within" is fewer than 8 units in the last place of the larger
  operand (recorded: `=1+1E-15-1`, 5 units, is 0; `=1E+15+1-1E+15`, 8 units, is 1). Entry truncation to 15 digits is typed entry's (ADR 511).
- **Manual calculation.** With `calcMode="manual"` an edit marks its dependents dirty and
  calculates only the formula just entered; `Engine::calculate_now` (F9),
  `Engine::calculate_sheet` (Shift+F9) and `Engine::is_calc_pending` are the doors, exported
  as `calculate_now` / `calculate_sheet` / `is_calc_pending` / `set_calc_mode` and on the TS
  facade. `AutoNoTable` calculates like `Auto` (no data tables). A load always calculates; the
  mode governs the edits after it. With `fullPrecision="0"` a number entered is stored as its
  format shows it (`sheet_format::as_displayed`, numeric sections with a fixed decimal count).

## Evidence

- Excel-recorded lane `calcmodel`: `corpus/calc-model/cases.tsv` (135 cases, 415 probed cells),
  `sheet-conformance/oracle/excel/{calcmodel.py,recorded/calcmodel.tsv,calcmodel-divergences.tsv}`,
  replayed by `sheet-conformance/tests/it/calc_model.rs`: 400 of 415 cells agree; the 15 listed
  are ADR 514's cycle ruling (11), the parenthesised root (below), AVERAGEA and VARA (not
  registered yet) and SUM's own cancellation (one recorded case, not modelled).
- The five `#CALC!` rows left `oracle/excel/divergences.tsv`.
- `sheet-calc/tests/it/short_circuit.rs` — the work counters.
- `corpus/xlsx-recalc/expected.tsv` moved for improvements only: FormulaEvalTestData 1100 →
  1224 agreeing cells against the tree before the W3 functions, 1258 with them (legacy implicit
  intersection, unknown names as `#NAME?`), DGet 142 → 145
  and BooleanFunctionsTestCaseData 22 → 23 (`=a`, `=glasses=TRUE`: unknown names as `#NAME?`,
  matching Excel's cached `#NAME?`).

## Alternatives considered

- **A `Paren` AST node** so a parenthesised root (`=(0.1+0.2-0.3)`, 5.55E-17 in Excel) does not
  snap: every exhaustive match, the printer's canonical form and many AST-equality tests would
  change for one display edge. Recorded as a divergence instead.
- **Marking every typed formula dynamic:** every formula would take the spill path and be
  saved as an array formula; `root_may_spill` keeps plain formulas plain.
- **A `Stack` variant of `Arg` for 3D references:** the frozen convention would change for
  every kernel, while all the functions Excel lets take a 3D reference are variadic over ranges.

## Consequences

- A formula typed with a typo is accepted and shows `#NAME?` (Excel's behaviour) instead of
  being refused; the bundle's error path for "unknown function" no longer fires.
- Legacy workbooks keep their values (no new spills); their formulas read with `@` where Excel
  365 shows one. The array-class list is the engine's (`eval::array_class`), checked against
  the recorded cases, not every function Excel classifies.
- A new function row that Excel stores with a prefix must say `xlfn_prefix`.
- Loaded rich-value errors (`t="e"` + `vm`) still read as `#VALUE!` until recalculated.

## Related

- [ADR 502](502-recalculation-and-spill.md), [ADR 509](509-excel-first-dialect.md),
  [ADR 511](511-typed-entry-is-excels.md), [ADR 512](512-range-accelerators.md),
  [ADR 514](514-circular-references.md)
