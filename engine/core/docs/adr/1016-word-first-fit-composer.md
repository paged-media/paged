# ADR 1016 — Word's first-fit is a composer of its own

- **Status:** Accepted 2026-10-24.
- **Scope:** `paged-model` (`Composer::WordFirstFit`, spelled `"Word First-fit"`,
  `Composer::is_word_first_fit`); `paged-text` (`SingleLineOptions::word`,
  `SingleLineOptions::word()`, `single_line.rs`, the item builder in `layout.rs`, the cache key
  in `cache.rs`); `paged-renderer` (`pipeline/compose_opts.rs`). No wire change: the
  `paragraphComposer` path already carries any composer name the model knows, and the mutation
  layer accepts every known variant. Amends [ADR 102](102-text-stack.md). Consumed by the doc
  module's ADR 617.

## Context

A Word document is laid out by this engine after the doc module lowers it onto the native
model. Until now the lowering chose InDesign's Single-line Composer (`"HL Single"`) as the
nearest native analogue of Word's line breaking. Both set a paragraph one line at a time, but
they disagree where it matters for pagination:

- **Justified lines.** The Single-line Composer may compress word spaces down to
  `MinimumWordSpacing` (80 % by default) and takes a compressed line when it deviates less than
  the uncompressed one. Word (2013+ layout) never compresses: a word that does not fit at
  natural spacing goes to the next line, and the line is then stretched.
- **Hyphenation.** InDesign hyphenates justified text by its own slack rules (an em plus 7.3 pt,
  60 % of a space) and ragged text by a 36 pt zone with at most three hyphens in a row. Word
  hyphenates when the line would otherwise end at least the hyphenation zone short of the margin
  (`w:hyphenationZone`, 0.25 in when absent), justified or not, at the last point that fits, with
  no limit on consecutive hyphens unless `w:consecutiveHyphenLimit` sets one.
- **A hyphen the text has.** Both break after it, but the Single-line Composer treats the break
  as a hyphenation point, gated by the zone and the ladder limit; for Word it is an ordinary
  break opportunity, like a space.
- **A word wider than the measure.** The engine's composers keep it whole and let it run past
  the margin. Word starts it on a line of its own and splits it at the character that overflows.

Every such difference moves a paragraph's line count by one, and a document's page starts drift
with the sum.

## Decision

1. **A model composer.** `Composer::WordFirstFit` is a variant of the composer enum, spelled
   `"Word First-fit"` in IDML and on the wire. It is not an Adobe composer: IDML carries it
   verbatim, as it carries any third-party composer name, and an unedited save writes it back.
   `is_single_line()` is true for it, so every place that treats one-line-at-a-time composers
   alike keeps doing so; `is_word_first_fit()` tells it apart.
2. **One breaker, a Word mode.** `single_line_breaks` keeps one loop. With
   `SingleLineOptions::word` set:
   - a line's candidates are measured at natural spacing only (no compressed candidate, no
     letter shrink), justified or not;
   - the word after the last fitting break is hyphenated only when the line would end `zone` or
     more short of the margin, at its last point that fits; the ladder limit applies only when
     the cascade sets `HyphenateLadderLimit` (Word's default is none);
   - the item builder gives a hyphen the text has an unflagged, zero-penalty break, so the
     breaker takes it like a space;
   - a word wider than the narrowest measure gets a last-resort break at every character
     boundary (`OVERFLOW_PENALTY`), taken only on a line that the word starts.
3. **Word's defaults where the document is silent.** `SingleLineOptions::word()` is an 18 pt
   zone and no hyphen limit; `compose_opts` takes `HyphenationZone` and `HyphenateLadderLimit`
   from the cascade when they are set, as for the Single-line Composer.
4. **IDML is untouched.** No IDML document names `"Word First-fit"`; every other composer
   resolves as before, and the item builder's Word branches are gated on the Word mode.

## Evidence

- `crates/paged-text/src/single_line.rs` — the Word mode; unit tests
  `word_first_fit_never_compresses_a_justified_line`,
  `word_first_fit_hyphenates_by_the_zone_justified_or_not`,
  `word_first_fit_splits_a_word_wider_than_the_measure_on_its_own_line`.
- `crates/paged-text/tests/word_first_fit.rs` — the rules on shaped text (JetBrains Mono, 0.6 em
  a glyph, so each measure sits a few tenths of a point either side of a word end): a word whose
  glyphs end inside the margin stays, the space after it may hang; a justified line 0.5 pt over
  is compressed by the Single-line Composer and wrapped by Word's; `well-` / `known`; a
  100-character word starts its own line and splits at 78 characters.
- `crates/paged-canvas/tests/it/paragraph_composer_path.rs` — `"Word First-fit"` is accepted on
  a style over the wire and kept.
- The doc module's `docx_conformance::first_fit_docx()` and `scripts/word-first-fit-probe.sh`
  ask Word the same questions in Courier New (every glyph 1229/2048 em); its answer is to be
  committed as `docx-conformance/fixtures/first-fit.word.json` (see Consequences).

## Consequences

- The rules above are Word's documented behaviour; the probe that confirms them case by case
  could not run when this was written (Word did not answer AppleEvents). When its answer is
  committed, `tests/word_first_fit.rs` should read it instead of its own expectations, and any
  case where Word disagrees is a dated amendment here.
- Word-specific rules not modelled yet: breaking after an en or em dash or a slash (the probe
  asks), Word's own hyphenation dictionary (the engine's hyphenator decides the points),
  `w:doNotExpandShiftReturn` and the WordPerfect-style justification compatibility options.
- A composer added to the enum is a model change other surfaces see as a new accepted value of
  `paragraphComposer`; the introspection catalog's open value list (`COMPOSERS`) does not list
  it yet.
