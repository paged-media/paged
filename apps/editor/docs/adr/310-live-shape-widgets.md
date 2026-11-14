# ADR 310 — Live-shape widgets and the Transform panel's Shape section

- **Status:** Accepted 2026-10-30.
- **Scope:** `apps/canvas/src/overlays/live-shape-handles.tsx` (registered in `app/mount.tsx`),
  `apps/canvas/src/panels/object-shape-section.tsx` (in `object-transform-panel.tsx`),
  `packages/tools/src/live-shapes/geometry.ts`, `packages/tools/src/handlers/polygon-tool.ts`.
  The engine half is engine ADR 1047 (live shapes); paged.draw's Star tool makes live stars
  through the `document.liveShapes@1` flag. Gap D-2.

## Context

Engine ADR 1047 keeps a polygon's sides and star inset and an oval's pie angles on the item, and
the engine redraws the shape when they change. A rectangle's per-corner type and radius were
already the engine's (`frameCornerOption*`, `frameCornerRadius*`). What the editor lacked was
Illustrator's way of editing them: the Transform panel's Shape Properties and the widgets on the
selected shape. paged.draw's Corner Radius tool drags corners, but as a tool of its own, and
nothing edited sides or pies at all.

## Decision

- **A host overlay, under the host's selection.** The widgets are an overlay contribution of the
  editor (`paged.live-shape-handles`, above the resize and rotate handles), shown for ONE
  selected rectangle, oval or live polygon outside path-edit mode, under the Selection and
  Direct Selection tools (another tool's drag inside the shape — Free Transform, a drawing
  tool — must reach that tool), whatever module's context is active. They are not a bundle's `overlay.handles@1` set: that door reports hits to the bundle's
  OWN tools, while these widgets belong to the host's Selection tool, like its resize handles,
  and edit engine properties every module's output carries. A widget takes the pointer itself
  (it stops propagation), as the bundles' overlay contributions do.
- **The widgets.** A rectangle has one inside each corner, on its diagonal at the radius (never
  closer than 14 screen px): a drag sets all four corners' radius, Shift only this corner's, and
  a square corner given a radius turns round; Alt-click cycles this corner's type (rounded,
  inverse rounded, bevel, inset, fancy). A live polygon has a side widget right of its box (drag
  up for more sides, down for fewer, one per 12 screen px) and a star widget on its first inner
  point (where it would be at inset 0 on a plain polygon; drag in for a deeper star). An oval
  has a pie widget at each angle on the ellipse — both at three o'clock on a whole ellipse, the
  end one on top — dragged around the ellipse; Shift snaps to 15°.
- **One drag, one step.** A drag previews (a dashed outline drawn by the editor's twin of the
  engine's geometry, or the moving widget, with its value) and commits ONE mutation on release;
  the corners' several writes are one batch. The model under the widgets asks the engine for the
  parameters (`elementProperties`) and re-reads after every applied, undone or redone change; a
  late reply never overwrites a newer one, and it holds still while a drag is in flight.
- **The item's own space.** Widgets are placed in the item's inner coordinates and drawn through
  its transform; the pointer comes back through the overlay group's screen matrix (camera and
  view rotation) and the inverse of the transform, so a turned or scaled shape works.
- **The Shape section** of Object ▸ Transform: Sides (Points for a star) and Star inset for a
  live polygon; Pie start, Pie end and Invert pie for an oval; a rectangle's four corners, each
  a type and a radius, with a link (on by default) that writes all four. Reads and single writes
  go through `host.objects` (ADR 323) like the rest of the panel; a write of several paths — the
  linked corners, a radius that also rounds a square corner, Invert pie — is one batch through the
  canvas client, one undo step. A polygon that is not live answers no sides and shows nothing.
- **The Polygon tool makes live polygons.** It inserts the plain polygon inscribed in its drag
  box and writes its sides and inset in the same batch (`$created`), so the engine draws the star
  where the preview had it. Its inset setting stops at 99 %, the engine's limit.
- **One geometry, pinned twice.** `packages/tools/src/live-shapes/geometry.ts` is the editor's
  twin of `paged_model::live_shape` (the tool's preview and the widgets' places and previews);
  its specs pin the engine's definitions: the first point at twelve o'clock and clockwise, the
  fit to a box, the circle kept across a change, the pie's counter-clockwise angles from three
  o'clock.

## Evidence

- `packages/tools/test/live-shape-geometry.test.ts` and the Polygon rows of
  `packages/tools/test/shape-tools.test.ts` (the live insert batch, the clamps).
- `apps/canvas/test/panels/object-transform-panel.dom.test.tsx` (the Shape section on a live
  polygon, an oval and a rectangle, against the headless engine: the exact mutation, the model
  read back, the field showing it, one undo step).
- `apps/canvas/test/overlays/live-shape-handles.dom.test.tsx` (the widgets' places and the
  mutations a drag and an Alt-click commit).
- `apps/canvas/tests/e2e/live-shapes.spec.ts` (the widgets dragged in the running editor: sides,
  star inset, pie, corners; each one undo step).

## Consequences

- Illustrator's live polygon, star, pie and per-corner widgets work under the host's Selection
  tool in every context; the Transform panel shows and edits the same parameters.
- paged.draw's Corner Radius tool stays (it rounds a polygon's corners too, which these widgets do
  not); the rectangle widgets overlap its rectangle case.
- A polygon edited point by point stops being live (engine ADR 1047), and its widgets go away.

## Amendment (2026-11-11): polygon corners; one corner tool

The widgets now round a polygon's corners too, so paged.draw's Corner Radius tool and its
handler are gone (its id leaves through the deprecation window, replacement the Selection tool;
draw ADR 359 amended).

- A **polygon** (live or not: any closed path) shows a widget inside each corner the renderer
  rounds: both edges straight, a closed contour, a real turn (`@paged-media/vector-tools`
  `polygonCorners`, the renderer's rule). The widget sits on the corner's bisector at the centre of
  the arc (`polygonCornerWidgetPoint`; at 90° that is the rectangle's place), or 14 px in when the
  corner is square. A drag reads the tangent distance along the two edges and answers
  `r = d · tan(θ/2)` (`polygonRadiusFromDrag`); the polygon has ONE radius (the renderer reads the
  top-left slot for an N-gon), so the commit is the Corners presets' eight writes
  (`@paged-media/helpers` `cornerPresetOps`), one undo step. Alt-click gives every corner the next
  type. A corner too short on screen, or a path with more than 48 corners, gets no widget.
- A **text frame** has the rectangle's four corner widgets (the engine renders its corners).
- The box rule (`cornerRadiusAt`, `cornerWidgetPoint`) stays this ADR's; draw's box twins in
  vector-tools (`cornerAt`, `radiusFromDrag`, `cornerPreview`) are deleted with the tool.

The consequence above that "a polygon edited point by point … its widgets go away" now holds for
the side and star widgets only; the corner widgets stay on any closed polygon.

## Amendment (2026-11-12): the corner widgets under Direct Selection

The decision above shows the widgets "outside path-edit mode", and Direct Selection always puts the
one selected path in path-edit mode, so in practice only the Selection tool showed them. Inside an
edit context that restricts the rail (sheet, web and data declare no tools of their own; image and
draw declare theirs) the Selection tool is not there and picking it leaves the context, so once
paged.draw's Corner Radius tool went those contexts had no way to round a corner.

- In path-edit mode the overlay shows the **corner widgets only** (a rectangle's four, a polygon's
  per-corner ones), as Illustrator's Direct Selection shows Live Corners. Direct Selection is one of
  the tools every context keeps (ADR 311), so the corners are reached in every context. The side,
  star, pie and Office preset widgets stay the Selection tool's.
- A widget still takes the pointer itself, so a press on it never reaches Direct Selection's anchor
  and segment gestures; it sits at least 14 px inside its corner, clear of the anchor.
- Evidence: `apps/canvas/test/panels/live-shape-handles.dom.test.tsx` (a live square in path-edit
  mode: four corner widgets, no side or star widget, a drag rounds every corner in one step) and
  `apps/canvas/tests/host-panels-every-context.spec.ts` (`HPX-P2-*`: the drag in every module's
  context, which it does not leave).

## Amendment (2026-11-14): a widget takes only its own target (IC7)

A corner widget sat 14 px inside its corner with a 14 px hit circle, so its target reached the
corner's resize handle and the band where a press moves the shape: a press meant to move or
resize near a corner changed the corner radius instead, at 100 % and more so at 800 %. The
widgets now give the resize handles and the move interior a fixed priority (the interaction
specification's `UXI-HND-002`, `UXI-HND-004`; editor plan task IC7):

- a widget's hit target is 12 px across about its 7 px disc, the smallest a mouse target may be
  (`UXI-HND-001`), in screen pixels at every zoom;
- a corner widget sits 20 px inside its corner, so the corner's resize square and the band
  between them stay the resize's and the move's;
- beside a widget, a press moves the shape; on the corner's square it resizes; on the disc it
  changes the radius (`tests/e2e/uxi-geometry.spec.ts`, at 100 % and 800 %).
