# ADR 1047 — A polygon, a star and a pie stay live shapes

- **Status:** Accepted 2026-10-30.
- **Scope:** protocol v78 (additive: four property paths, two `serde(default)` model fields; no
  bump). `paged-model` (`live_shape`: `PolygonShape`, `PieAngles`, the generators, the
  `paged:liveShape` label; `Polygon::live_shape`, `Oval::pie`); `paged-mutate`
  (`PropertyPath::{FrameShapeSides, FrameShapeStarInset, FrameShapePieStart, FrameShapePieEnd}`,
  `apply/live_shape.rs`, the lock and permission tables); `paged-renderer` (a pie is drawn as the
  polygon of its wedge); `paged-canvas` (the reads, `live_shape_losses`); `idml-export` (a pie
  oval's path is its wedge; the label is stamped); `idml-import` (the label is lifted);
  `paged-introspect` (the four catalog rows). Gap D-2. The editor half is editor ADR 310.

## Context

Illustrator keeps a polygon's side count, a star's inner radius, an ellipse's pie angles and a
rectangle's per-corner radii and types editable after the shape is drawn: the Transform panel
shows them and on-canvas widgets drag them. The engine had only the last of these. A rectangle's
four corners (`CornerSpec`, Q-16) are InDesign's own and already read, write and render per
corner. A polygon, though, was its anchors and nothing else: the Polygon tool wrote an N-gon or a
star as a plain `insertPath`, and from then on it was a path. An oval was always the whole
ellipse inscribed in its bounds.

IDML keeps none of the three. InDesign has a polygon's sides and star inset only as the Polygon
tool's preference (`PolygonPreference`); a polygon on the page is its path. An `<Oval>` is drawn
by its path too (the writer's `oval_anchors` note): InDesign draws whatever `<PathGeometry>` it
carries.

## Decision

**The parameters live on the item; the geometry stays the truth every consumer reads.**

- `Polygon::live_shape: Option<PolygonShape>` holds `sides` (3..=100, InDesign's limit) and
  `star_inset` (0..=99 percent; 0 is the plain polygon). The anchors are what the parameters make
  (`polygon_anchors` / `polygon_anchors_in`): the first point at twelve o'clock, the points
  clockwise on the page, a star's inner points between them at `1 − inset/100` of the outer
  radius — the Polygon tool's construction and draw-geometry's `starPath`. The renderer, the
  hit test, PDF and IDML go on reading the anchors.
- **Live while the anchors are its shape.** `live_polygon` answers the parameters only while the
  anchors are still exactly what they make in their own bounding box (to 0.001 pt, or a
  ten-thousandth of the box): one closed contour of corner points. The shape is fitted to its
  box, so a resize (any axis-aligned scale of the points) keeps it live. A point edit, a reversal,
  an offset or anything else that reshapes the path ends it — without a write, so no geometry op
  has to know about live shapes. A stale `live_shape` stays in the model and reads as nothing.
- `Oval::pie: Option<PieAngles>` holds Illustrator's Pie Start and Pie End: degrees
  counter-clockwise on the page from three o'clock, the wedge swept counter-clockwise from start
  to end. `start` is stored in `[0, 360)` and `end` in `[0, 360]`. Two angles in one direction
  (a zero sweep) draw the whole ellipse but are both KEPT — a widget dragged onto the other one
  and on again, or Invert pie's two writes, must not lose the other angle; only the default pair
  0 / 360 is stored as `None`. `cut_pie` is the pie that draws a wedge. The oval's
  bounds stay the whole ellipse's: a gradient or a placed picture does not move as the angles
  change.

**The writes.** `frameShapeSides` (`Value::Length`, a whole number 3..=100) on a Polygon that is
one closed contour makes it live and redraws its anchors; on a polygon that is already live it
keeps the star inset and the CIRCLE — the ellipse the outer points lie on, so the outer radius
stays where it was, as in Illustrator — and on any other path it fits the new shape to the path's
own box. `Length(None)` ends the live shape and keeps the path (Illustrator's Expand Shape).
`frameShapeStarInset` (0..=99) needs a live polygon and redraws in the same circle. The frame box
follows the redrawn anchors, as it does after any whole-path rewrite. A polygon write's inverse
is a batch — the parameters as they were (cleared, or set back), then the anchors and the box as
they were — so undo restores the model exactly ([ADR 197](197-undo-restores-the-model-exactly.md))
whether the path was live, stale or never a live shape. `frameShapePieStart` / `frameShapePieEnd`
on an Oval set one angle (`None`: 0 and 360); the inverse is the angle replaced. All four are
`frame_geometry` invalidations, reshape a locked item no more than a resize does (the lock table)
and need `item.resize`.

The Polygon tool's own flow follows from this: it inserts the plain polygon inscribed in its drag
box, then writes the sides and the inset in the same batch (`$created`); the star the engine draws
has its outer points where the tool's preview had them. paged.draw's Star tool does the same with
its Radius 1 polygon and an inset of `1 − Radius 2 ÷ Radius 1` when the star is upright and its
inner radius the smaller one.

**The reads.** A Polygon reads `frameShapeSides` (`None` for a path that is not a live polygon)
and, when live, `frameShapeStarInset`; an Oval reads both pie angles (0 and 360 for the whole
ellipse).

**A pie is drawn as the polygon of its wedge.** `pie_polygon` builds the polygon a pie oval is:
its anchors are `pie_anchors` (the centre, then the arc in cubic segments of at most a quarter
turn), everything else the oval's paint, stroke, effects and picture. The renderer routes a pie
oval through the polygon emitters at the two entry points (`emit_oval_into`, `emit_oval_image`),
so fills, strokes, effects, a placed picture's clip, the GPU and CPU lanes and PDF all see one
outline and no back end changes; a whole ellipse takes the oval path it always took, and its
display list digests as before ([ADR 101](101-display-list-single-intermediate.md)). The hit test
keeps the ellipse's box.

**IDML: the outline natively, the parameters in a label.** Following the effect stack
([ADR 1008](1008-an-items-effects-are-an-ordered-stack.md)): `live_shape::label::stamp` writes
`paged:liveShape` on every live polygon (`{"polygon":{"sides":…,"starInset":…}}`) and pie oval
(`{"pie":{"start":…,"end":…},"ellipse":[t,l,b,r]}`) when the IDML is written, and the reader's
`lift` takes them back into the model and drops the label. A live polygon's anchors are exact in
IDML; the reader gives it its parameters back only while its path is still that shape (InDesign
may have reshaped it). A pie oval's `<PathGeometry>` is its wedge — on both lanes, the patch lane
(`model_geometry`) and the inserted-item lane — which InDesign draws, so InDesign shows the pie;
the reader's box is then the wedge's, and the lift puts the ellipse back by mapping it the way the
wedge's box became the box read (so a pie InDesign moved or scaled keeps its place and size). A
pie is named in `idml_export_losses`: InDesign shows it but cannot edit its angles. A live polygon
is not — InDesign keeps no polygon's sides either, and nothing on the page is lost. `.paged`
keeps both fields (`serde(default)`, absent when `None`, so a document without live shapes
writes and hashes as before).

**Rectangles need nothing new.** Their per-corner options and radii are the existing
`frameCornerOption*` / `frameCornerRadius*` paths; the editor's widgets and Shape section write
them (editor ADR 310).

## Evidence

- `crates/paged-model/src/live_shape.rs`: the generators (first point, direction, inner radius,
  fit to a box, the circle kept), the validity rule, pie normalisation and outline, the label's
  stamp and lift (including a reshaped polygon that does not take its label back).
- `crates/paged-canvas/tests/it/live_shapes.rs` (`*__feat__plugin_draw_live_shapes`): sides and
  inset redraw and undo exactly (anchors and box); a point edit ends the live shape; bad values
  and open paths are refused; pie angles cut the oval (the display list changes, undo restores
  its digest); the Polygon tool's insert becomes a live star in its drag ellipse; the IDML export
  writes the wedge and both labels, names the pie once in the losses, and the re-import lifts the
  parameters and the ellipse back; an inserted pie round-trips through the inserted-item lane; a
  `.paged` file keeps both.
- `crates/paged-introspect`: the catalog's 269 settable paths, the apply-parity probes (an oval
  fixture joins them for the pie paths).

## Consequences

- A polygon, a star and a pie are editable after they are drawn, in the editor's Transform panel
  and on the canvas (editor ADR 310), through scripts (`paged.set`) and through any host.
- InDesign shows them and keeps their parameters, but edits them as paths.
- Illustrator's other live shapes are not here: a rounded rectangle is InDesign's corners already;
  a line segment's length and angle, and corner widgets on a polygon (the polygon has one uniform
  corner, which paged.draw's Corner Radius tool already drags) are left to later work.
- The polygon geometry is the second copy of the Polygon tool's; the TypeScript twin the widgets
  draw their previews with (`@paged-media/tools`' `live-shapes/geometry.ts`) is pinned to this
  one by its specs. Arc maths here is a candidate for the shared geometry crate (PM-0014 C8).
