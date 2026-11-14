# ADR 1310 — A composed line keeps its evidence, and a write has a dry run

- **Status:** Accepted 2026-11-14.
- **Scope:** protocol v82. `paged-text` (`LaidOutLine::hyphenated`, `LayoutOptions::line_measure`),
  `paged-renderer` (`LineLayout::composition`, `LineComposition`, `LineComposer`; the public
  `hyphenation_limits` and `hyphenation_language` the composer reads its settings through),
  `paged-canvas` (`line_evidence.rs`: `CanvasModel::line_evidence`, `LineEvidenceQuery`,
  `LineEvidenceReport`; `preview.rs`: `CanvasModel::preview`, `PreviewQuery`, `PreviewReport`;
  `model.rs`: `CanvasModel::sandbox`, `from_scene` split out of `load`; `channel.rs`:
  `RequestLineEvidence`, `LineEvidence`, `RequestPreview`, `Previewed`), `paged-canvas-wasm` (the
  dispatch arms), the editor's client (`CanvasClient.lineEvidence`, `CanvasClient.preview`). Implements the engine half of task PX2 of
  `apps/editor/docs/interaction-plan.md` (the UX strategy's Concept E, the Typography
  Debugger); the editor's side is editor ADR 1234.

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
3. **A write has a dry run, and it never touches the document.** `CanvasModel::sandbox` makes a
   copy of the document in a model of its own: the scene cloned and built cold (the load's path
   after the parse, `from_scene`) with this model's fonts, profiles, colour settings, session
   policy and id floor. `RequestPreview { mutation, items?, story? }` applies **any** write — a
   batch, a Pathfinder Boolean or region verb, a property, a text edit — to the sandbox through the
   whole write path (lowering, permissions, the operation layer, the rebuild) and answers
   `Previewed(PreviewReport)`: whether it applied (else the engine's refusal in words), the page
   items it would create and the asked items it would remove (matched by `Self` id, so a write
   that changes an item's kind keeps it), the geometry and the outlines (`PathAnchorsResult`:
   anchors and the transform onto the page) it would leave for those and the asked items, the
   asked story's line evidence, and the revision the preview was made from.
   `RequestLineEvidence.preview` is the same sandbox, answered as line evidence. The document,
   its build, its undo history, its coalescing state, its revision and its build generation are
   untouched; making the write is the ordinary `Mutate`, one undo step, and leaves what the
   preview showed.

## Consequences

- The breaker's ratio is kept as each breaker computes it; its scale differs between the
  paragraph composer's breakers (the justified breaker reads 100 for a line it could only
  letter-space), so the measured spacing is the number a reader compares.
- The hyphenation points are the dictionary's under the paragraph's limits; the composer's own
  candidates also pass its zone and `NoBreak` gates, which the evidence does not repeat.
- A preview costs a cold build of the whole document and the write's rebuild; it suits a hover or
  a button, not a live scrub.
- paged.draw's Pathfinder previews its result through it (draw ADR 370, amendment 1).
- Tests: `crates/paged-canvas/tests/it/typography_evidence.rs` (a justified line's measure and
  spacing, a hyphenated break with its points, a forced break, a discretionary hyphen, an overset
  story, the baseline grid, a frame and a range, a preview that recomposes a copy and changes
  nothing and whose Apply equals it, a text edit previewed, a refused write) and
  `it::dry_run.rs` (a union's result outline, a region verb's minted items, a refused write, the
  document unchanged, the applied write equal to the preview); the wire in
  `crates/paged-canvas-wasm/tests/it/dispatch.rs`.
