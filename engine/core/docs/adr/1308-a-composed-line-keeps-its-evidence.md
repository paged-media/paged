# ADR 1308 — A composed line keeps its evidence

- **Status:** Accepted 2026-11-14.
- **Scope:** protocol v82. `paged-text` (`LaidOutLine::hyphenated`, `LayoutOptions::line_measure`),
  `paged-renderer` (`LineLayout::composition`, `LineComposition`, `LineComposer`; the public
  `hyphenation_limits` and `hyphenation_language` the composer reads its settings through),
  `paged-canvas` (`line_evidence.rs`: `CanvasModel::line_evidence`, `LineEvidenceQuery`,
  `LineEvidenceReport`; `CanvasModel::cold_build_of`, `preview_operation`; `channel.rs`:
  `RequestLineEvidence`, `LineEvidence`), `paged-canvas-wasm` (the dispatch arm), the editor's
  client (`CanvasClient.lineEvidence`). Implements the engine half of task PX2 of
  `apps/editor/docs/interaction-plan.md` (the UX strategy's Concept E, the Typography
  Debugger); the editor's side is editor ADR 1227.

## Context

The composer decides, for every line, which break to take among the ones the text and the
dictionary offer, and how far to stretch or shrink the spaces to fill the measure. The build kept
the result — each line's glyph positions (`LineLayout`) — and dropped the reasons: the measure the
line was composed into, its natural width, the breaker's ratio, whether the composer added a
hyphen, which composer ran, how far the baseline grid moved the line. A question such as "why did
this line break here?" or "why is this line so loose?" could only be answered by composing the
paragraph again outside the build, a second implementation bound to drift from the first.

## Decision

1. **The build keeps the composer's record of every line.** `LineLayout` gains `composition:
   LineComposition { available_pt, natural_pt, ratio, hyphenated, composer, justified,
   grid_shift_pt }`, filled where the renderer places the line from the options it composed the
   paragraph with: the measure is `LayoutOptions::line_measure(i)` (the per-line width a wrap or
   a drop cap carved, which the alignment pass now reads through the same function), the natural
   width and the ratio are `LaidOutLine`'s, `hyphenated` is the breaker's flag (newly kept on
   `LaidOutLine`), the composer is the one the options chose, the grid shift the snap the emitter
   applied (in the continuation frame too). A blank line carries an empty record; a table cell's
   line carries its own. A few numbers per line, on every build: nothing is recomposed to answer.
2. **`RequestLineEvidence { story, frame?, range?, preview? }` answers
   `LineEvidence(LineEvidenceReport)`**, a read of the build. Per line: its page, frame,
   paragraph and line, its characters (story character offsets, and the same in the editor's
   caret units), its text, its baseline and extent, the measure, the natural width, the ratio,
   the word spaces as set (each measured from the letter before it to the letter after it, in %
   of the space glyph's advance — the scale of the paragraph's word spacing settings; mean,
   smallest, largest), the space added between letters, **why it broke** (`wordSpace`, `hyphen`,
   `discretionaryHyphen`, `hardHyphen`, `forcedLineBreak`, `paragraphEnd`, `storyEnd`,
   `emergency`), whether the next line is in another frame or the story is overset after it, the
   **hyphenation points** of the word at the break (the broken word, or the word that went to the
   next line whole) with the one used and, when it offers none, why (`short`, `capitalized`,
   `lastWord`, `noLanguage`, `off`, `noPattern`), its **tightness** against the paragraph's word
   spacing (`veryTight` below the minimum, `tight`, `normal`, `loose`, `veryLoose` above the
   maximum; a line stretched by its letters alone is loose by how far they moved), the
   **outliers** (`wordSpacingAboveMaximum`, `wordSpacingBelowMinimum`, `letterSpacing`,
   `overfull`), the composer, whether it is justified, and the grid shift. Per paragraph: the
   composer, the alignment, the hyphenation settings (the limits through the composer's own
   `hyphenation_limits`, the dictionary through `hyphenation_language`), the hyphenation zone,
   the word, letter and glyph scaling bands, the grid alignment. The story's overset: from where
   and how many characters.
3. **A preview never touches the document.** With `preview`, the write is lowered to its
   operation exactly as an applied write would be (`preview_operation`, the model's own lowering
   and refusals) and applied, with the session's permissions, to a **copy** of the scene; the copy
   is built cold (`cold_build_of`, the cold build of the digest gate on another scene: fonts,
   profiles and settings shared, no cache the live build writes back) and the evidence is read
   from that build against that copy. The document, its build, its undo history, its coalescing
   state, its revision and its build generation are untouched. A write the operation layer does
   not apply on its own (a text insertion, a structural edit) is refused with `refused:
   "unsupported"` and the document's own evidence. Applying the change is the ordinary write: one
   undo step.

## Consequences

- The breaker's ratio is kept as each breaker computes it; its scale differs between the
  paragraph composer's breakers (the justified breaker reads 100 for a line it could only
  letter-space), so the measured spacing is the number a reader compares.
- The hyphenation points are the dictionary's under the paragraph's limits; the composer's own
  candidates also pass its zone and `NoBreak` gates, which the evidence does not repeat.
- A preview costs a cold build of the whole document; it is a deliberate action, not a live
  scrub.
- Tests: `crates/paged-canvas/tests/it/typography_evidence.rs` (a justified line's measure and
  spacing, a hyphenated break with its points, a forced break, a discretionary hyphen, an overset
  story, the baseline grid, a frame and a range, a preview that recomposes a copy and changes
  nothing and whose Apply equals it, an unsupported write); the wire in
  `crates/paged-canvas-wasm/tests/it/dispatch.rs`.
