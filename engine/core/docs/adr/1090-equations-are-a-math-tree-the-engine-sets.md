# ADR 1090 — Equations are a math tree the engine sets

- **Status:** Accepted 2026-11-08; **slice 1 built** (the tree, its layout and the shared OMML
  reader, with tests). Open, in this order: the model type and wire (Amendment slot below), the
  renderer's metrics adapter and paint, doc import and slide import, MathML, write-back. Part of
  the capability layering of PM-0014 and PM-0017
  ([capability register](../../../../docs/development/capability-register.md), "Equations").
- **Scope:** `paged-math` (new leaf crate: `model`, `layout`); `paged-ooxml::omml` (the shared
  reader); later `paged-model`, `paged-scene`, `paged-wire`, `paged-renderer`, `docx-*`,
  `slide-native`.

## Context

Word (`m:oMath`, `m:oMathPara`) and PowerPoint (`a14:m` inside `mc:AlternateContent`, carrying the
same `m:oMathPara`) hold equations as Office Math. The engine shows nothing for them today: doc
and slide skip the element (the bytes survive a save because the part is carried through, but the
page has a hole where the formula was). Every document with a formula therefore diverges from
Word's page, and a formula changes line heights, so the text after it moves too.

Three things are needed, and only the last is specific to the engine:

1. a reader for the markup, which doc and slide share;
2. a description of an equation independent of the markup (so MathML, LaTeX or a UI can produce
   the same);
3. a layout that turns the description into positioned glyphs and rules with the engine's text
   stack and font fallback.

## Decision

### The tree: `paged-math::model`

`Math { display, body: Vec<Node> }`; `Node` is `Run` (text plus a typeface `Variant`), `Frac`
(bar, no bar, skewed, linear), `Script` (sub, sup, both, or `pre`), `Rad` (optional degree),
`Nary` (operator, bounds, an explicit limits location or the operator's default, body), `Delim`
(open, close, separator, items), `Matrix`, `Func`, `Accent`, `Bar`, `Limit`, `EqArr`, `Group`.
It records structure and the author's explicit choices, never positions. It is the intersection of
OMML and presentation MathML; what neither side can say twice (borders, alignment points `&`,
phantoms that only take room, spacing overrides) is deferred, not approximated.

### The reader: `paged-ooxml::omml`

One reader in the shared foundation (it rides `paged-ooxml::tree`, with the math namespace `m:`,
transitional and strict). `read_all(root)` returns every equation in document order, display for
the children of an `m:oMathPara`, inline for a bare `m:oMath`. It is read-only and tolerant: an
unknown element is skipped, an absent operand is empty, an empty `m:begChr` means "no delimiter",
an absent one the default. `paged-ooxml` depends on `paged-math` for the tree, as it does on
`paged-colour-math` (ADR 1056); the engine does not depend on `paged-ooxml`.

**Unchanged parts stay byte-identical.** The reader never rewrites markup. An equation is carried
through by the OPC layer like any other unread element; only an edit of the equation (not part of
this slice) would splice its bytes (`paged-ooxml::splice`).

### The layout: `paged-math::layout`

TeX's rules (Appendix G) in the simplified form the OpenType MATH table also states, in em of the
equation's size, so it scales:

- **Styles.** Display, Text, Script (0.7), ScriptScript (0.5). Fraction parts go one style down;
  scripts one style down (to ScriptScript at the end); a display matrix sets its cells in text
  style.
- **Fractions.** Numerator and denominator shifted from the axis (0.25 em) by the display/text
  constants and pushed apart to the clearance (3θ display, θ text, θ the rule thickness); a
  bar centred on the axis; a binomial (`noBar`) keeps the stack clearance without a bar.
  Skewed and linear fractions are on one line.
- **Scripts.** Superscript and subscript shifts from the base's height and depth and the
  script size, the minimum shifts of the constants, and a 4θ gap between the two when both are
  present; a single-character base takes no drop. `sPre` puts them before the base.
- **Radicals.** A stroked sign (four points), a bar at the clearance above the body, the degree in
  ScriptScript size raised to 60 % of the height. Drawing the sign as a path (not a glyph) keeps it
  right at every height with no dependency on a font's radical variants.
- **N-ary operators.** The glyph is 1.4× in display style, centred on the axis. Sum, product and
  union-like operators put bounds under and over in display style, beside the operator otherwise;
  integrals keep them beside; `m:limLoc` overrides both.
- **Delimiters.** Stretched vertically (`scale_y`) to the TeX target (90.1 % of twice the content's
  distance from the axis, or the content less 0.4 em), centred on the axis.
- **Matrices and `eqArr`.** A grid on a baseline skip (1.2 em, at least the rows' extent plus
  0.2 em), 1 em column gap, cells centred (rows of `eqArr` left-aligned), centred on the axis.
- **Atom spacing.** Binary operators (medium, 4/18 em) and relations (thick, 5/18 em) are spaced
  in text and display style only; a binary operator with no left operand is a sign; punctuation is
  followed by a thin space (3/18 em); functions and big operators are separated from their
  argument by a thin space.
- **Accents, bars, limits, groups** as the reader names them.

The output is `Layout { width, ascent, descent, items }` with `Item::Glyphs` (a run at a
baseline origin, size, `Variant`, vertical stretch), `Item::Rule` and `Item::Stroke`: y-down from
the baseline. A pure function of the tree, the size and the metrics (deterministic, wasm-safe,
no I/O, ADR 109).

### The seam to the text stack

`MathMetrics { advance, extent }` is the only place a font enters. The renderer implements it over
its shaping for the math font (Cambria Math where present, otherwise STIX Two Math or the engine's
bundled fallback), mapping `Variant::Italic` and the other variants to the font's math-alphanumeric
code points. The default `extent` is a Latin estimate; the font-backed one returns glyph bounds. The
OpenType MATH constants, where the font has them, replace `Constants` (`layout_with`); without
them the TeX values stand. This keeps the layout testable on a fixed-advance fake and the numbers
the rules' own.

### Verification

The layout is held to its rules by geometry invariants (`tests/layout.rs`: bar on the axis,
numerator above, denominator below, scripts in script size and apart, radical bar spans the body,
limits centred over the operator, delimiters stretching, a matrix centred on the axis, spacing,
determinism). The reader is held to four fixture equations (quadratic formula, an inline sum with
limits, a bracketed matrix, an integral with a function) and the edge cases of its defaults.
**Not yet verified:** the match to Word's rendering. That comparison uses only PDFs the repository
already holds or ones saved headless from a generated `.docx` (`tooling/oracle/office/word`, never
the Word UI) and compares formula extents and baselines; no such PDF carries an equation yet, so
the layout constants are TeX's until one does (follow-up below).

## Next slices (documented, not built)

1. **Model and wire.** `StoryRun::Equation { math, display }` in `paged-model` (the `.paged`
   encoding gains it only when present, so existing documents' canonical hash does not move), an
   inline object of the story composer whose box is the layout's `width × (ascent + descent)` on
   the line's baseline (Word's inline-equation behaviour; display equations are their own
   paragraph, centred by default), and its wire/catalog entry: the full resync in one commit
   (catalog, vendored catalog, wire.d.ts, core-commands, coverage, canary).
2. **Render.** The renderer's `MathMetrics` over the shaper, painting `Glyphs` as text runs with
   the run's colour, `Rule` as fills and `Stroke` as strokes, in the display list (ADR 101).
3. **Doc and slide import.** `docx-*` lowers `m:oMath` inside `w:p` (and the `w:r`-level math of
   `m:oMathPara`); `slide-native` lowers `a14:m`, where the fallback picture of `mc:AlternateContent`
   is kept for the bytes and ignored for the page. Both through `paged_ooxml::omml`.
4. **Word oracle.** Generate a `.docx` of the fixture equations, save it as PDF headless, and add
   the extents to the fidelity set; tune the constants against it.
5. **Editing and MathML/LaTeX input**, `m:borderBox` borders, alignment points.
