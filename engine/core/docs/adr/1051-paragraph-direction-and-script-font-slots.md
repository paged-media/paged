# ADR 1051 — A paragraph's base direction and a run's script font slots

- **Status:** Accepted 2026-10-30.
- **Scope:** protocol v78 (a rider: every addition is optional on the wire and skipped in the
  model when unset). Part of engine wave W4 of the paged.doc Word-parity program; the Word
  mapping is paged.doc work (doc ADR 620).
  - `paged-model`: module `script` (`ParagraphDirection`, `ResolvedDirection`,
    `CharacterDirection`, `FontHint`, `ScriptClass`, `ScriptProperties`, `first_strong`);
    `Paragraph.direction`, `ParagraphStyleDef.direction`, `ResolvedParagraph.direction`;
    `CharacterRun.script`, `CharacterStyleDef.script`, `ParagraphStyleDef.script` and the
    resolved forms.
  - `paged-scene`: `ResolvedParagraphAttrs.direction`, `ResolvedRunAttrs.script`, cascaded
    direct > character style > paragraph style.
  - `paged-text`: `LayoutOptions.bidi` (`BidiLayout`), `set_stated_bidi`.
  - `paged-renderer`: `pipeline/direction.rs`; body, table-cell and footnote paragraphs set a
    stated direction; `nested_styles::split_runs_for_scripts`.
  - `paged-mutate`: `apply/script.rs`; the property paths `paragraphDirection`,
    `characterDirection`, `characterEastAsianFont`, `characterComplexFont`,
    `characterComplexFontSize`, `characterComplexBold`, `characterComplexItalic`,
    `characterComplexScript`, `characterFontHint` (on a `StoryRange` and on the styles).
  - `paged-canvas`: the story read's `ParagraphContent.direction` and `RunContent.script`
    (`RunScriptContent`); the paths read back on ranges and styles.
  - `idml-import` / `idml-export`: `ParagraphDirection` and `CharacterDirection`.

## Context

The text engine shaped right-to-left scripts and reordered a line holding right-to-left
characters with UAX #9 (`apply_bidi_reorder`), but a paragraph had no base direction: the
level came from the paragraph's first strong character, the line stayed where the left-aligned
layout put it, and its glyphs were re-packed from the line's left edge, so a justified or
tabbed right-to-left line lost its spacing. A run had one face, so a Word run's East Asian and
complex-script fonts (`w:rFonts/@w:eastAsia`, `@w:cs`) had no slot, and neither did Word's
complex-script size and weight (`w:szCs`, `w:bCs`, `w:iCs`) or a run's own direction
(`w:rtl`).

## Decision

**A paragraph states its direction.** `ParagraphDirection` is left to right, right to left,
or `Auto` (the first strong character's, UAX #9 P2/P3; left to right when there is none). In a
right-to-left paragraph the alignment, the indents, the tab ruler and the list marker are
**logical**: the start edge is the right one. `LeftAlign` sets a line at the right,
`LeftIndent` is the start indent (on the right), a first-line indent indents the line's right
end, tab stops are measured from the right edge, and the list marker (the paragraph's first
characters) stands at the right. Word's alignment and indents read the same way (its `w:jc`
`left`/`start` and `w:ind/@w:left`/`@w:start` are the start edge in a `w:bidi` paragraph);
InDesign's Middle Eastern edition was not measured (no corpus document sets
`RightToLeftDirection`), so an imported right-to-left IDML paragraph is read the same way.

**How a stated paragraph is set.** The composer lays the paragraph out left to right in
logical order, exactly as before: breaks, alignment, justification, indents, tabs and leaders
all read from the start edge (`LayoutOptions.bidi` only keeps the older reordering out). Once
every pass that reads logical positions is done, `set_stated_bidi` puts each line in visual
order: every cluster keeps the room it took (its advance plus what the line put after it — a
justified space's stretch, a tab's jump to its stop), the clusters are reordered by UAX #9 at
the paragraph's level (a tab resets to that level, so each tab-delimited stretch reorders on
its own), and they are laid side by side again — right to left from the mirrored edge of the
line's measure, so what the logical layout put at the start edge stands at the right. Justified
spacing, tab stops and alignment survive the reorder.

**Left to right keeps the older pass.** Every IDML paragraph style says
`ParagraphDirection="LeftToRightDirection"`; a left-to-right paragraph whose runs state no
direction therefore keeps the older reordering (first strong character, not mirrored), so
every IDML document draws exactly as before. A paragraph that states nothing does too.

**A run states its direction.** `CharacterDirection` (`w:rtl`, IDML's `CharacterDirection`)
embeds the run's weak and neutral characters — digits, punctuation, spaces — at that
direction: their UAX #9 level is raised to odd (right to left) or even (left to right), as an
embedding would set it; strong characters keep their level. A right-to-left run is also
complex script throughout (below).

**Script slots.** `ScriptProperties` gives a run up to two faces beside its own: East Asian
(Han, Kana, Hangul, Bopomofo, CJK punctuation, full-width forms) and complex script (Arabic,
Hebrew, Syriac, Thaana, Thai, Lao, the Indic scripts, Khmer, Myanmar, Tibetan and the other
complex scripts), with the complex-script size and bold / italic. Which slot a character takes
(`ScriptProperties::segments`): a right-to-left or `w:cs` run is complex script throughout;
otherwise a character's script decides and a neutral one (spaces, shared punctuation,
combining marks) follows its neighbour; the hint (`w:hint`) sends shared non-ASCII characters
to its slot. An unset slot falls back to the run's own font; an unset complex-script weight
takes the run's own style. The renderer cuts a run at its script changes before anything else
reads it (`split_runs_for_scripts`, beside the nested-style split every emitter already
calls), each piece carrying its slot's face, size and style as its own formatting, so the font
harvest, shaping, kinsoku, the line breaker and the emitters see ordinary runs. Runs whose text
is generated at emit (fields, variables, placeholders) are not cut; a ruby run is kept whole in
its first piece's face.

**Property paths** (on a `StoryRange`, and on character / paragraph styles through
`SetStyleProperty`; `""` or `None` clears, which is what an inverse over an unset field
carries, so every undo restores the model exactly): `paragraphDirection` (`ltr`, `rtl`,
`auto`), `characterDirection` (`ltr`, `rtl`), `characterEastAsianFont`,
`characterComplexFont`, `characterComplexFontSize`, `characterComplexBold`,
`characterComplexItalic`, `characterComplexScript`, `characterFontHint` (`default`,
`eastAsia`, `cs`). A bad value is refused before any run splits.

**IDML.** `ParagraphDirection` and `CharacterDirection` are read on ranges and styles and
written where the model changed them (a source spelling that reads as the model's value keeps
its bytes; `Auto` is written left to right). The script slots have no IDML attribute (InDesign
sets them through composite fonts) and live in the `.paged` model part.

## Evidence

- `crates/paged-model/src/script.rs` tests: script classes, segments with direction and hint,
  direction names and `Auto`.
- `crates/paged-text/src/layout.rs` tests (`stated_*`, `a_right_to_left_run_embeds_…`): a
  right-to-left line set from the right edge, a Latin word keeping its order, tabs measured
  from the right, a right-to-left run embedding its neutrals.
- `crates/paged-renderer/tests/it/word_direction.rs`: a right-to-left paragraph set from the
  right edge, its start indent on the right, a logical right-align at the left edge, a
  paragraph that states nothing drawing as before, a right-to-left run's neutrals; East Asian
  characters drawn in the East Asian face, complex script in its face and size, a
  right-to-left run complex script throughout.
- `crates/paged-mutate/tests/it/word_model.rs`: every path on runs and styles, exact undo, bad
  values refused.
- `crates/idml-export/tests/it/word_direction.rs`: the directions read, written and kept byte
  for byte unedited.

## Consequences

- paged.doc lowers `w:bidi`, `w:rtl`, `w:rFonts` eastAsia / cs / hint, `w:szCs`, `w:bCs`,
  `w:iCs` and `w:cs` onto these slots (doc ADR 620).
- Residuals: neutral characters at an odd level are not mirrored (`(` stays `(`; shaping
  mirrors only inside a right-to-left run); the drop cap and a text wrap's per-line shifts are
  not mirrored in a right-to-left paragraph; `ToBindingSide` / `AwayFromBindingSide` stay
  absolute; a left-to-right paragraph whose runs state nothing keeps the older first-strong
  reordering; Word's rule that `w:b` does not bolden complex script unless `w:bCs` says so is
  not modelled (an unset complex weight takes the run's style).
