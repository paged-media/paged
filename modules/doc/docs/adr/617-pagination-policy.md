# ADR 617 — Pagination policy: Word's rules, the engine's first-fit composer

- **Status:** Accepted 2026-10-24.
- **Scope:** `docx-lower` (`WORD_FIRST_FIT_COMPOSER`, the docDefaults base style, a picture
  paragraph's leading); `docx-conformance` (`first_fit_docx()`, `first_fit_cases()`);
  `scripts/word-first-fit-probe.sh`; the headless measurement
  `packages/doc-bundle/test/headless/real-docx-measure.spec.ts`. Rests on engine
  [ADR 1016](../../../../engine/core/docs/adr/1016-word-first-fit-composer.md) and on
  [ADR 604](604-word-is-the-oracle.md).

## Context

A Word document opened standalone is paginated by the engine, so where its pages start depends on
how the lowering describes Word's layout rules. The pagination program (8 % of real documents'
page starts matching Word, target 95 %) works through them one rule at a time, each against a
Word probe. Three of its steps concern a paragraph's own lines:

1. fonts registered after the document is open must lay its text out again;
2. lines must break where Word breaks them;
3. a line holding an inline picture must take the picture's height.

Step 1 was already in place when this was written: the engine rebuilds its font table when the
registry changes or an edit brings in a face it has not seen (`refresh_font_table`, engine
`late_fonts.rs`), and the headless measurement registers Word's faces after the open. Step 3 was
in place for the picture's own line (engine `17d3d3d`: an inline object is a character of its
line and raises it under auto leading; the lowering gives a picture paragraph auto leading unless
its spacing is exact).

## Decision

1. **Every Word paragraph composes with Word's first-fit.** The docDefaults base style, which
   every lowered paragraph style roots in, sets `paragraphComposer = "Word First-fit"`
   (`WORD_FIRST_FIT_COMPOSER`), not InDesign's Single-line Composer. The two differ where Word
   does not compress a justified line, hyphenates by its zone, breaks after a hyphen like after
   a space, and splits a word wider than the measure (ADR 1016).
2. **A picture paragraph keeps Word's pitch.** Its auto leading is set to Word's pitch for its
   first run over that run's size (`paragraphAutoLeading`, e.g. 115 % for 12 pt Times New
   Roman's 13.8 pt), so its text lines step as Word's do while the picture's line still grows to
   the picture. Before, they stepped 1.2 × the size.
3. **Word answers, the fixtures record.** The breaking rules are asked of Word with
   `first_fit_docx()`: Courier New 10 pt (every glyph 1229/2048 em), each measure a few tenths of
   a point either side of a word end, plus inline pictures under single, 1.5-line, at-least and
   exact spacing. `scripts/word-first-fit-probe.sh` writes the answer as
   `docx-conformance/fixtures/first-fit.word.json` and the engine's copy (committed 2026-10-25,
   see the amendment).
4. **The measurement runs headless.** `real-docx-measure.spec.ts` opens a document through the
   bundle's standalone open on the real engine and docx-js and writes the same JSON as the
   editor-driven `scripts/real-docx/measure.spec.ts`, so `compare.py` and `line_geometry.py`
   read it. It needs no editor checkout and no browser.

## Evidence

- `docx-lower/src/lib.rs` — `install_doc_defaults`; the test
  `every_word_paragraph_style_inherits_the_word_first_fit_composer__feat__plugin_doc_read_path`.
- `docx-conformance/tests/it/pictures.rs` — a picture paragraph takes auto leading at Word's
  pitch.
- Measured 2026-10-24 (headless, Word's faces, Word's PDFs of 2026-10-02), Single-line Composer
  against Word's first-fit: paragraphs with Word's line count 796 → 801 of 813 (Bug50936_3),
  605 → 605 of 624 (parentinvguid); page starts unchanged (2 %, 13.1 %). See
  `../reference/acceptance-real-docx.md`, round 14.

## Consequences

- Line breaking is no longer what holds the page starts back: on both measured documents at
  least 97 % of paragraphs already take Word's line count. The next steps are vertical (line
  heights, spacing collapse, keeps, table rows, notes, headers).
- Word's own answer to `first_fit_docx()` is committed (amendment of 2026-10-25); the engine
  tests and this module's hold it.

## Amendment 2026-10-25 — Word answered the first-fit probe

Word 16 set `first_fit_docx()` (`fixtures/first-fit.word.json`). Where it disagreed with the
documented rules the engine's Word mode changed (engine ADR 1016, amendment of the same date):
a justified line compresses by up to one word space in all, an en or em dash is a break, and a
picture's line is the picture over the baseline and the rest of the auto-leaded line under it
(43 pt for a 40 pt picture at single spacing, 48.7 at 1.5 lines, where the engine set 42).

The lowering's part: a picture paragraph under **at-least** spacing above the face's single line
takes auto leading at the single line (Word puts at-least's extra above the text, so under a
picture only the descent remains: 43 pt at "at least 14 pt"), and its text runs carry the
at-least pitch, so its text lines keep it. Single and multiple spacing keep auto leading at
Word's pitch; exact spacing keeps the fixed leading (Word clips the picture).

Evidence:

- `docx-conformance/tests/it/first_fit.rs` — the answer is for the cases this crate builds (and
  the engine's copy is the same file); every case reaches the engine as `"Word First-fit"` at
  Word's measure and alignment; the picture paragraphs carry the leadings above.
- `packages/doc-bundle/test/headless/first-fit.spec.ts` — `first_fit_docx()` (as
  `test/fixtures/first-fit.docx`) through the bundle's standalone open on the real engine: every
  paragraph's lines hold Word's words, and, where Courier New is installed, the picture cases'
  line steps are Word's within 0.3 pt (steps into a picture on a paragraph's second line, and
  from a picture's line into the next paragraph in the same spacing).
- Not matched, and not a picture rule: the step INTO a paragraph from one in another line
  spacing (Word: the previous line's share below the baseline plus the new line's above it; the
  engine: the new paragraph's leading). Single → 1.5 lines differs by 5.67 pt. Next vertical
  step.
- The real-document measurement was not re-run: Word's PDFs of the measured documents are not
  in the corpus.
