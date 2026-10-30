# ADR 310 — Live-shape widgets and the Transform panel's Shape section

- **Status:** Accepted 2026-10-30.
- **Scope:** `apps/canvas/src/overlays/live-shape-handles.tsx` (registered in `app/mount.tsx`),
  `apps/canvas/src/panels/object-shape-section.tsx` (in `object-transform-panel.tsx`),
  `packages/tools/src/live-shapes/geometry.ts`, `packages/tools/src/handlers/polygon-tool.ts`.
  The engine half is engine ADR 10XX (live shapes); paged.draw's Star tool makes live stars
  through the `document.liveShapes@1` flag. Gap D-2.

## Context

Engine ADR 10XX keeps a polygon's sides and star inset and an oval's pie angles on the item, and
the engine redraws the shape when they change. A rectangle's per-corner type and radius were
already the engine's (`frameCornerOption*`, `frameCornerRadius*`). What the editor lacked was
Illustrator's way of editing them: the Transform panel's Shape Properties and the widgets on the
selected shape. paged.draw's Corner Radius tool drags corners, but as a tool of its own, and
nothing edited sides or pies at all.

## Decision

- **A host overlay, under the host's selection.** The widgets are an overlay contribution of the
  editor (`paged.live-shape-handles`, above the resize and rotate handles), shown for ONE
  selected rectangle, oval or live polygon outside path-edit mode, whatever module's context is
  active. They are not a bundle's `overlay.handles@1` set: that door reports hits to the bundle's
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
- A polygon edited point by point stops being live (engine ADR 10XX), and its widgets go away.
