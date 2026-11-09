# ADR 1090 — Equations are a math tree the engine sets

- **Status:** Accepted 2026-11-08; **slice 1 built** (the tree, its layout and the shared OMML
  reader, with tests); **slice 2 built** (Amendment 1: the model, the renderer's metrics and
  paint, doc and slide import). Open, in this order: the Word-oracle comparison, equations in
  table cells, a wire door (insert/edit), MathML, write-back. Part of the capability layering
  of PM-0014 and PM-0017
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

## Amendment 1 — the model, the render and the doc import (2026-11-08)

**Model.** `Paragraph.equations: Vec<paged_model::equation::Equation>` (`{ offset, math }`),
skipped when empty, so a document without one keeps its bytes and state hash. An equation is an
inline object of its paragraph, like an inline anchored frame (ADR 1050): it stands at a
character offset and is no character of the paragraph's text, so a caret, a selection and the
text's bytes never see it. `Paragraph::shift_anchors` moves it with the text; the canvas's
paragraph split and cross-paragraph delete move it with the text after the cut and drop it with
deleted text. `paged-math` gained an optional `serde` feature for this; it stays a leaf crate.
The equation is **not on the wire yet**: no mutation creates or edits one (the doc import
reaches the engine through the `.paged` model, ADR 606), so the catalog and `wire.d.ts` are
unchanged. The `StoryRun::Equation` sketched under "Next slices" became this paragraph field:
the model has no run enum, and the inline-object machinery already does what an equation needs.

**Render.** `paged-renderer` `pipeline/equations.rs`:

- *Face.* The first of `Cambria Math`, `STIX Two Math`, `Latin Modern Math` the document's
  font resolver has as itself (the font table asks for them when a paragraph holds an equation),
  else the face of the run the equation stands in.
- *Metrics.* `MathMetrics` over the face: advances from shaping (`paged-text`), extents from the
  glyphs' bounding boxes. A run's `Variant` maps a letter to its Mathematical Alphanumeric code
  point (`paged_math::alphabet::styled`, the block's holes included) where the face has it; a
  face without math-italic letters draws the plain letter leaned 12°.
- *Constants.* The face's OpenType `MATH` table (`ttf-parser`) where present (axis, rule,
  fraction shifts, script shifts and drops, limit gap), TeX's otherwise.
- *Placement.* The equation is set before its paragraph is composed, at the resolved size of the
  run it stands in, and becomes an inline object: as wide as its layout, its box standing on the
  baseline lowered by its descent, so it rises its ascent (the line grows by the rise under auto
  leading, as any inline object). It is drawn where its character landed, in that character's
  paint: `Glyphs` through `emit_glyph_slice` (a stretched delimiter as the glyph's `y_scale`),
  `Rule` as a filled path, `Stroke` (the radical sign) as a stroked path.
- Not yet: equations in table cells (the cell path sets no equations), rotated frames' equations
  follow the anchored-object path, a descent does not push the next line.

**Doc import.** `docx-import` reads each part's equations once through
`paged_ooxml::omml::in_part` (every `m:oMathPara` as one display equation, its lines an `eqArr`;
every `m:oMath` outside one inline; what an `mc:Fallback` holds left out) and takes them in
order as its typed walk meets `m:oMath` / `m:oMathPara` in a paragraph, a hyperlink, a field, a
content control or a tracked insertion (a tracked deletion's is left out). The equation is a
text-less `docx_core::Run` with `math`; the lowering puts it on the paragraph
(`LoweredParagraph.equations`, `at` = the characters before it) and the native builder
(`docx-skeleton` `body.rs`) onto the model paragraph; a paragraph that is only display equations
is centred (Word's `centerGroup` default). The pour path (a deferred block) has no door for an
equation. The doc wasm grew past its 8 MiB manifest budget by 25 KB (8.02 MiB, measured by
`doc / bun test`); the manifest's `maxBytes` is 9 MiB now. **Unchanged parts stay byte-identical:** the reader never writes, the equation's run
has no `w:r` and is no run of the lowering, so the save-back's run bindings are unchanged; a
test edits the run beside an inline equation and holds the equations' markup and the paragraphs
after it to their bytes.

**Slide import.** PowerPoint writes an equation's shape as an `mc:AlternateContent` whose
choice holds the text with `a14:m` and whose fallback is a picture of the equation. The reader
(`pptx-import`) now takes the choice of a shape that holds an equation (any other alternate
content still takes its fallback), and reads an `a14:m` (alone or as the choice of a paragraph's
alternate content) through the shared OMML reader into `pptx_core::RunKind::Math`; the resolver
carries it on its `TextRun` (`math`), and `slide-native` puts it on the model paragraph at its
character, with its run's size (`Equation::point_size`, which a source states when it has one).
A slide nobody edited is written back as the deck had it (slide ADR 704), so its bytes hold.

**Verification.** `paged-math` (layout invariants, the alphabet's holes), `paged-ooxml`
(`in_part`: order, the fallback, a two-line display paragraph), the renderer
(`tests/it/equations_pipeline.rs`: the text after an inline fraction moves by its width, the bar
is TeX's rule on the axis at the pen, the glyphs are drawn, a display fraction grows its line),
doc (`docx-conformance` `equations.rs`: the runs, the lowering's offsets, the byte-identical
edit; `docx-skeleton` `equations.rs`: the model paragraphs), slide (`pptx-import` unit tests:
an `a14:m` paragraph, the choice over the fallback). Slide's resolver and native builder are
held by the compiler only: no deck fixture with an equation is committed yet. **Not verified:** any match to
Word's rendering. No fixture in the repository carries Word's picture of an equation (Word
writes no fallback image for `m:oMath` in a `.docx`), and no math face is committed, so the
public gate sets equations in a text face at TeX's constants; the `MATH`-table path is exercised
only where a math face is installed.

## Amendment 2 — the Word oracle (2026-11-09)

The comparison of slice "Word oracle" was run: generated `.docx` files (the fixture equations, an
inline nested fraction, an `m:oMathPara` with and without break runs; a styles part with Calibri
11 pt and single spacing) saved as PDF by Microsoft Word 16 for macOS
(`tooling/oracle/office/word/word-pagination-probe.sh`) and drawn by the doc bundle on the real
engine with Word's own Cambria Math face. Findings and what changed:

- **Size and shape match.** With the math face and the same base size, the quadratic formula is
  102 pt wide in Word and 97 pt in paged; the inline fraction, radical, scripts, matrix and
  delimiters have Word's proportions. (An earlier difference of 20 % came from the probe, not the
  engine: a package without a styles part, and Cambria Math registered from `Cambria.ttc`, whose
  face 0 is Cambria; see the open items.)
- **Lines of a display paragraph (fixed).** Word sets the `m:oMath` children of one
  `m:oMathPara` on ONE line when no break run stands between them (`y = 1z = 2`), and starts a
  new line at a break run (`m:r/w:br`), between them or inside one. `paged_ooxml::omml::read_para`
  now splits lines at break runs only (`tests/omml.rs`
  `a_display_paragraph_breaks_its_lines_where_word_does`); the doc fixture's two-line paragraph
  has the break run Word writes.
- **The line holds the equation (fixed).** The doc lowering kept a paragraph holding an equation
  at Word's fixed pitch, so a display fraction overlapped the lines around it. Such a paragraph
  now takes auto leading as a picture's does (`docx-lower`; `docx-conformance`
  `an_equation_paragraph_takes_auto_leading`), and under Word's first-fit an equation's depth
  below the baseline pushes the next line (`anchored::line_object_depth`; Word sets the line after
  a display fraction below its denominator). InDesign's rule is unchanged: only the rise moves a
  line (`equations_pipeline`
  `under_word_first_fit_an_equations_depth_pushes_the_next_line`).
- **Open: display n-ary operators.** Word draws a display `∑` and `∫` about twice the text's
  height (the face's display variant); paged scales the base glyph by 1.4, so a display sum or
  integral is shorter and its paragraph about 4 pt lower than Word's. Needs the `MATH` table's
  glyph variants (`MathVariants`).
- **Open: a math face inside a collection.** The renderer opens a face at index 0; Cambria Math is
  face 1 of `Cambria.ttc` (Windows and Office), so registering that file gives Cambria, without a
  `MATH` table. Font registration has no face index for a collection.
