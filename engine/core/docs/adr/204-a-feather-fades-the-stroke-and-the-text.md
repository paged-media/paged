# ADR 204 — A feather fades the frame's stroke and a text frame's text

- **Status:** Accepted 2026-10-20. Amends [ADR 203](203-a-frames-effects-apply-to-its-picture.md).
- **Scope:** the frame emitters in `crates/paged-renderer/src/pipeline/{shapes,text_path,text_frame}.rs`
  and `module/effects.rs` (`feather_outline`, `emit_interior_effects`, `emit_feathers`,
  `shape_feathers_by_content`); the text slot in `pipeline/build_engine.rs`;
  `DisplayCommand::BeginFeatheredObject::content_shaped`; the marker-opened run of the PDF
  exporter (`paged-export-pdf/src/page.rs`). The two raster lanes are unchanged: they take their
  runs from `paged_compose::mask::feather_run_starts` and build every mask from the feather's
  path, as before.

## Context

ADR 203 put a frame's picture inside its feathered run and left two gaps:

- **The stroke.** The feathers were emitted before the stroke, so the stroke painted after the
  feather, at full strength, and the mask was built on the frame's own path.
- **Text frames.** A text frame's text is emitted by the story pass, after every page item, and
  moved to its frame's z-slot afterwards. The slot sat after the frame's feathers, so a feather on
  a text frame faded its box and never its text. A text frame did not emit the run marker at all.

Asked of InDesign (20.0.1; the `feather-strokes` fixture, a page of nine feathered frames over a
yellow band, exported to PDF):

1. A basic feather on a frame with an 8 pt black stroke fades the stroke as well. Its band is
   measured from the stroke's **outer** edge: 4 pt outside the path for a centred stroke, 8 pt for
   an outside-aligned one, on the path itself for an inside-aligned one. The same holds for an
   oval, a directional feather and a gradient feather.
2. A feather on a filled text frame fades the text with the box.
3. A feather on a text frame with neither a fill nor a stroke follows the glyphs: a 10 pt feather on
   30 pt text leaves every stem a light grey, wherever it sits in the frame. InDesign feathers an
   object by its own coverage, and such a frame covers only its text.

`Size`-style widths keep the meaning ADR 104 measured; nothing here changes how wide a feather's
band is, only where it starts and what it masks.

## Decision

1. **The feathers come last.** A frame emits, in order: outer glow, the run marker, fill, picture,
   interior effects (inner shadow, inner glow, bevel and emboss, satin), stroke and line ends, then
   its feathers, inside its object group. `emit_effects_post_fill` is split into
   `emit_interior_effects` (before the stroke) and `emit_feathers` (after it). A frame without a
   feather emits the same commands in the same order as before.
2. **The feathers are built on the stroke's outer edge.** `feather_outline` grows the frame's
   effects path by `stroke_outset_pt` (half the weight centred, all of it outside, none inside;
   nothing when no stroke paints), mitred, in the frame's inner coordinates where the weight is
   measured, and interns the result. The marker and all three feathers carry that path; the
   interior effects keep the frame's own. A frame whose stroke reaches nowhere outside the path
   keeps its path id, so its display list is unchanged. Because every lane builds its mask from
   the feather's path, the CPU lane, the Vello lane and the PDF exporter take the grown outline
   with no change of their own.
3. **A text frame's text goes inside the run.** A feathered text frame emits the marker before its
   fill and returns a text slot after its stroke and before its feathers (`BodyTextSlot`), so the
   story's glyphs are moved between them. `in_object_group` keeps its meaning: the slot sits in the
   body's object group only when the frame has one.
4. **An unfilled, unstroked text frame is shaped by its text.** Its marker carries
   `content_shaped: true`. After the text is relocated, `shape_feathers_by_content` joins the
   outlines of the fills between such a marker and its feathers, carried into the feathers'
   coordinates, and puts that path on the marker and the feathers. A run that paints anything other
   than fills (a stroke, an image), or nothing, keeps the frame's outline.
5. **The PDF run opens at the marker and closes at the first feather** on the marker's path; the
   interior effects, the stroke and the text in between are walked under the soft mask.

## Consequences

- On `feather-strokes` (gated from this change) the page reads mean ΔE 1.806 → 0.519, p99 61.47 →
  16.95, SSIM 0.9552 → 0.9883, ink mean 10.77 → 2.56 against InDesign. The generated gate's other
  fixtures and the CPU/Vello parity gate are unchanged, and so is every gated vendor pack; an
  annual-report pack's three pages with feathered stroked frames improve (mean ΔE 2.89/3.09/2.74 →
  2.40/2.85/2.50).
- On a stroked frame, the outer glow before the marker no longer joins the raster lanes' run: the
  walk back from the marker follows the marker's path, which is now the grown outline. The PDF
  lane never put the glow under the mask, so the lanes now agree on a stroked frame. An unstroked
  frame keeps ADR 203's reading.
- Text that is not moved into its frame's slot — a master frame's, or any with
  `text_at_frame_z` off — stays outside the run and is not faded.
- A filled text frame's text that overflows the frame is masked by the frame's outline, where
  InDesign would include the overflow in the object's coverage. The content-shaped outline is a
  union of fills under one fill rule per lane (nonzero on the CPU canvas, even-odd in the shared
  mask builder), which differs only where two glyphs overlap.
- Case 6, a linear gradient feather over a stroked frame, still differs from InDesign at the far
  stroke, which InDesign leaves a light grey; the gradient's span over the stroke box is not
  measured yet.
- Tests: `paged-renderer` `tests/it/feathered_stroke_and_text.rs` (order, the grown outline for
  rectangles and ovals and all three alignments, the stroke fading from its outer edge, text
  inside the run, the content-shaped outline and its pixels); `paged-export-pdf`
  `tests/it/feathered_stroke_and_text.rs` (the stroke and the text paint under the soft mask);
  the `feather-strokes` generated fixture and its InDesign reference.
