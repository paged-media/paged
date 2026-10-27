# ADR 1016 — Word's first-fit is a composer of its own

- **Status:** Accepted 2026-10-24.
- **Scope:** `paged-model` (`Composer::WordFirstFit`, spelled `"Word First-fit"`,
  `Composer::is_word_first_fit`); `paged-text` (`SingleLineOptions::word`,
  `SingleLineOptions::word()`, `single_line.rs`, the item builder in `layout.rs`, the cache key
  in `cache.rs`); `paged-renderer` (`pipeline/compose_opts.rs`; since the 2026-10-25 amendment
  `pipeline/anchored.rs` `line_object_shift`/`WordLine` and `FontMetrics::hhea_ascender`). No wire change: the
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
  the uncompressed one. Word (2013+ layout) was documented as never compressing; its answer
  (amendment of 2026-10-25) shows it compresses a justified line by a small allowance per line.
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
   - a ragged line's candidates are measured at natural spacing only; a justified line with a
     word space on it keeps every word that fits compressed by at most one natural word space
     in all (`WORD_LINE_SHRINK_SPACES`), letters never (amended 2026-10-25, below);
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
  `word_first_fit_compresses_a_justified_line_only_by_its_own_limit`,
  `word_first_fit_hyphenates_by_the_zone_justified_or_not`,
  `word_first_fit_splits_a_word_wider_than_the_measure_on_its_own_line`.
- `crates/paged-text/tests/word_first_fit.rs` — every case of Word's answer composed in
  JetBrains Mono (0.6 em a glyph) at the case's measure scaled by Courier New's advance, its lines
  compared word for word with Word's (amendment of 2026-10-25), and the Single-line Composer seen
  to keep its own rules (J03 compressed, no break at a dash).
- `crates/paged-canvas/tests/it/paragraph_composer_path.rs` — `"Word First-fit"` is accepted on
  a style over the wire and kept.
- The doc module's `docx_conformance::first_fit_docx()` and `scripts/word-first-fit-probe.sh`
  ask Word the same questions in Courier New (every glyph 1229/2048 em); its answer is
  `docx-conformance/fixtures/first-fit.word.json` and this crate's copy.

## Consequences

- Word's answer to the probe is committed (`crates/paged-text/tests/fixtures/first-fit.word.json`,
  the doc module's `docx-conformance/fixtures/first-fit.word.json`); `tests/word_first_fit.rs`
  reads it, and where Word disagreed with the documented rules the amendment below says so.
- Word-specific rules not modelled yet: Word's own hyphenation dictionary (the engine's
  hyphenator decides the points; the probe set no automatic hyphenation, so only the composer
  rules were compared), `w:doNotExpandShiftReturn` and the WordPerfect-style justification
  compatibility options.
- A composer added to the enum is a model change other surfaces see as a new accepted value of
  `paragraphComposer`; the introspection catalog's open value list (`COMPOSERS`) does not list
  it yet.

## Amendment 2026-10-25 — Word's answer

Microsoft Word 16 (macOS, PDF export) answered `first_fit_docx()`: 33 paragraphs in Courier New
10 pt, every line with its words (`crates/paged-text/tests/fixtures/first-fit.word.json`).
Before this amendment the Word mode matched 27 of the 33 cases word for word; it now matches all
33 (`tests/word_first_fit.rs`).

- **A word ending on or inside the margin stays; the space after it may hang** (R01–R04), as
  documented.
- **Word compresses a justified line, a little, per line.** It keeps a word 0.5, 3 and 5.68 pt
  over the measure (J01, J02 on lines of 15 spaces; H06's last line, 6 spaces) and wraps it 8
  and 9 pt over (J03, J04, 15 spaces). That is not a share of each space (5.68 pt over 6 spaces
  is 16 % of each, 8 pt over 15 only 9 %) but one allowance per line between 5.68 and 8 pt.
  The Word mode lets a justified line with a word space on it compress by one natural word
  space in all (6.0 pt here, `WORD_LINE_SHRINK_SPACES`), the simplest value in that interval,
  and keeps every further word that fits so. Ragged lines never compress.
- **Word breaks after an en dash and an em dash** (H03 `1990–` / `2000`, H04 `word—` / `word`),
  which InDesign does not; the Word mode adds them as ordinary breaks
  (`hyphenate::word_dash_opportunities`). **Not after a slash** (H05 `and/or` wraps whole), as
  before. After a hyphen with a one-letter prefix (H07 `x-`) and before digits (H08 `page-`) as
  after any hyphen; a hyphen past the margin takes the compound whole (H02).
- **An over-wide word** starts its own line and splits at the last character that fits: 77
  characters of 468 pt (L01, L02).
- **A picture's line** (P01–P07, a 20 × 40 pt picture). Word sets a line as its text's ascent
  above the baseline and the rest of the line below it: the descent and, under multiple
  spacing, all of the extra. A picture replaces only the ascent: 43.0 pt for a 40 pt picture at
  single spacing (40 + the 3.0 pt descent; the InDesign rule gave 42), 48.7 at 1.5 lines (40 +
  3.0 + 5.67; InDesign's 42), 43.1 at "at least 14 pt" (at-least spacing puts its extra above
  the text); a 4 pt picture leaves the line alone; under exact spacing the line stays 14 pt and
  Word clips. The renderer's `anchored::line_object_shift` takes a `WordLine` in Word mode: the
  line needs `rise + (auto leading − ascent) × size`, the ascent being the face's `hhea` one
  (`FontMetrics::hhea_ascender`, the metric Word's single line is made of). The doc lowering
  gives an at-least picture paragraph auto leading at the single line and its text runs the
  at-least pitch (doc ADR 617). Unit tests: `anchored` tests
  `a_picture_line_under_word_first_fit_takes_words_height`,
  `a_picture_line_keeps_indesigns_rule_outside_word_first_fit`.
- **Not modelled: the step between paragraphs of different line spacing.** Word steps into a
  paragraph's first line by the previous line's share below the baseline plus the new line's
  above it; the engine steps it by the new paragraph's own leading. Single → 1.5 lines differs
  by 5.67 pt (P02's line, text alike), exact → single by about 0.3 pt (P05). It is a vertical
  rule of its own, for the pagination program's next steps.
