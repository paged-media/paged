# ADR 366 — Brushes and width points are live stroke styles

- **Status:** Accepted 2026-10-31.
- **Scope:** `packages/draw-geometry/src/width-points.ts`; in `packages/draw-bundle/src`
  `commands/brushes.ts`, `panels/brushes-panel.tsx`, `handlers/width.ts`, `handlers/brush.ts`,
  the Width, Paintbrush and Blob Brush options in `tool-options.ts`, the Draw ▸ Stroke rows in
  `menu.ts`, the typed twins, the `brushLibrary` part type; the `brushes` oracle probe. Engine
  ADR 1053 (the `widthProfile` and `brush` stroke styles, host flag
  `document.strokeStyles@1`). Work package WP6.4 of the image/draw plan (gaps D-22, D-23,
  D-24, D-26).

## Context

The Width tool and the Paintbrush wrote `outlineStrokeVariable`: the centreline became its
filled outline, so a width could not be changed again and nothing remembered that the shape
had been a stroke. paged.draw had no brushes along a path at all. Engine ADR 1053 makes both
live: a page item's object stack takes a `widthProfile` entry (width points along each
contour) and a `brush` entry (Art, Scatter, Pattern or Bristle, its artwork in the brush
frame), and the engine draws the stroke from them.

## Decision

- **The Width tool edits width points live.** Its `mode` option, `live` first (the default):
  a press on the selected item's stroke (within the pick tolerance plus the band's half width
  there) finds the arc-length fraction on the nearest contour; the drag's distance from the
  path along its normal sets the width there (× the stroke weight, capped by `maxWidth`); the
  release moves the point within 0.02 of it or adds one (a profile without points starts
  uniform), and writes the stack — one batch, one undo step. The overlay previews the band as
  one polyline (`widthOutlinePolyline`, the engine's easing). `mode: outline`, a graphic line
  (no stack) and a host without `document.strokeStyles@1` keep the v0 bake.
- **The Paintbrush and the Blob Brush gain the live result.** Their `result` option keeps
  `outline` first (their behaviour, unchanged); `live` inserts the centreline stroked with the
  sweep's paint at the nib's widest and its per-stop widths as the width profile, in one
  batch, the creation defaults restored inside it. The Blob Brush's live result does not
  merge: a live stroke is not a fill to unite.
- **Brushes are data.** A brush is `{ id, name, library, type, options, art? }`; the
  built-in libraries (Basic, Artistic, Decorative) are constants, the document's brushes a
  container part (`brushes/library.json`, the `brushLibrary` part type) — like the graphic
  style library, a write that is not an undo step. Applying a brush writes its `brush`
  entry in place of any other, a width profile goes before the brush that reads it, and every
  other entry of the stack keeps its place. New brush maps the first selected outline's box
  onto the brush frame (`x` along 0..1, `y` across ±0.5, up the page to the left).
- **The Brushes panel is Illustrator's Brushes panel and Brush Options dialog in one.** A
  library and its brushes (a click applies), Remove, New brush of a type, Brush Options for
  the selection's brush (the fields its type reads; Apply is one undo step), and the width
  profile library. Draw ▸ Stroke has Brushes…, Brush options… (raises the panel; with a
  payload it sets the options), Remove brush and New brush from selection.

## Consequences

- A brushed or variable-width stroke stays a stroke: its path, its colour and its weight
  edit as before, Expand Appearance keeps the artwork, and IDML gets the artwork as a path
  with the brush in a label (engine ADR 1053).
- The oracle: Illustrator 30.1's default art brush, applied to 200, 303 and 420 pt lines and
  expanded, is a stretch of one artwork along the path; the engine, given the 200 pt result as
  its artwork, draws the other two anchor for anchor to 0.01 pt (`test/oracle/brushes.spec.ts`).
  The band's width is a convention: Illustrator's is the artwork's own height at a 1 pt
  stroke, ours the stroke weight × the brush's size. Scripting has no door to make a brush or
  read its options, and the default pattern and bristle brushes expand to images, so those
  and the width profiles are not recorded.
- Not done: per-side width points, Illustrator brush library import, pattern corner tiles,
  colourisation other than the stroke's colour, the Calligraphic brush.
