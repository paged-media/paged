# ADR 370 — Vector editing with feedback: the Pen's named states, a precision magnifier, point-level controls, shape suggestions, and saying what a path operation takes

- **Status:** Accepted 2026-11-14.
- **Scope:** the editor's half of drawing, which this module's machines drive:
  `apps/editor/packages/tools/src/handlers/pen-states.ts` and `pen-tool.ts` (the Pen's states, cursors,
  hints and the finish click), `apps/editor/packages/shell/src/overlays/precision-magnifier.tsx` and
  `precision-magnifier-geometry.ts` (mounted by `overlay-host.tsx`),
  `apps/editor/apps/canvas/src/panels/anchor-points.ts` and `anchor-points-section.tsx` (Points),
  `shape-suggestions.ts` and `shape-suggestions-section.tsx` (Shape suggestions), both routed by
  `properties-panel.tsx`, and `pathfinder-preview.ts` with `pathfinder-panel.tsx`. Task CM5 (draw) of
  the editor's interaction plan; the UX strategy's §7.1; the interaction specification's §8.4
  (`UXI-DRW-001` to `UXI-DRW-006`) and §21.3. No contract change: the module's machines
  (`PenMachine`, `DirectSelectMachine`) and commands are used as they are.

## Context

The Pen said what a press would do only for some of its intents: closing and joining both showed a
plain pointer, a new path and the next anchor looked the same, nothing showed that a handle was
being pulled, and nothing said that Enter finishes (`UXI-DRW-003` asks for path-start, continue,
close, join, drag-handle and finish to be told apart by cursor and hover feedback). Placing an anchor
precisely meant zooming in and out. With anchors selected by Direct Selection, the inspector still
showed the frame's transform and stroke, not the points. A shape's useful operations (rounded
corners, offset, repeat) were in three menus. The Pathfinder applied on click with nothing saying so,
and the engine offers no dry run of a Boolean or region operation to preview its result.

## Decision

1. **The Pen has named states**, derived from the machine's intent plus what the host knows
   (`penStateOf`): `start` (nothing in progress), `draw` (the next anchor), `continue`, `close`,
   `join`, `dragHandle` (a press that placed an anchor, held past the drag threshold), `finish`
   (released over the run's last anchor), `add` and `delete`. Each has its own cursor — one pen-nib
   glyph with a badge per state (asterisk, none, slash, ring, joined strokes, caret, tick, plus,
   minus), through the cursor contract's `cursorAt` and the shared `resolveCursorCss` (there is no
   cursor controller yet; track IC moves this onto it) — and every state but `start` a short hint
   beside the pointer on an overlay layer of its own (`paged.tool.pen.hint`), in the editor's
   language. The tool-preview slot keeps the path alone.
2. **A click on the run's last anchor finishes the open path**, as Enter does: one `insertPath`, one
   undo step, and the Pen stays the Pen. (The machine would otherwise place a second anchor on top of
   the first; a closing click on the first anchor still wins.)
3. **A precision magnifier**: holding **Control** with a tool that places or drags anchors in hand
   (the Pen, Direct Selection, Curvature, the Add / Delete / Convert anchor tools) or with path
   editing on shows a round loupe beside the pointer — never over it — with the page at four times
   the view's scale, a crosshair on the point and the Pen's run drawn over it. Control because it is
   the one modifier the anchor tools leave free (Shift constrains, Alt breaks a handle pair, Cmd is
   Direct Selection and the snap bypass). The pixels are an engine snapshot of the page region
   (`requestSnapshot` with `clip` and `format: "rgba"`, the eyedropper's door), one request in flight
   and the newest position winning. It only reads: no point moves, no key is taken from the tool in
   hand, no undo step. Its key listener and its pointer are the editor's own (per instance).
4. **Points in the inspector.** With anchors selected inside the path being edited, the Properties
   panel's inspector is **Points**: the frame's Object and Stroke sections give way to the selected
   anchors' position (one anchor's point, several anchors' bounds), their type (Corner, Smooth,
   mixed), Align horizontally / vertically on their average (several), and Delete points. A typed
   position moves each selected anchor and its handles by the page delta taken through the inverse
   of the path's item transform. Every edit is one batch of the engine's point ops (`pathPointSet`,
   `pathPointCurveType`, `pathPointRemove`): one undo step (`UXI-DRW-005`, `UXI-DRW-006`).
5. **Shape suggestions.** One selected path (a polygon, rectangle or graphic line of three or more
   anchors, or with a curve) shows quick actions chosen from what it is: Round corners (a closed
   shape with corners; the host's `paged.corners.rounded`), Smooth (three or more corner points; one
   batch of `pathPointCurveType`), Simplify (twelve or more anchors; this module's
   `simplifyPath`), Offset path (closed; `offsetPath`), Repeat and Mirror (`makeRadialRepeat`,
   `makeMirrorRepeat`). Only operations the editor already has, each shown only while its command is
   registered, each one undo step, each labelled as applying on click.
6. **Before a Pathfinder click.** With no engine dry run there is no honest preview of the result,
   so the panel says that a button applies on click, to how many objects, as one undo step, and while
   a button is hovered or focused it outlines on the canvas what the button takes: the object that
   keeps the result of a shape mode (the first selected) or that Crop cuts with and Minus back keeps
   (the frontmost by the scene tree's order) solid and named, the others dashed. A dry run in the
   engine would turn this into a result preview; until then nothing is drawn that the click would
   not do.

## Interaction contract (the specification's §21.3)

| Item | Pen | Magnifier | Points / suggestions | Pathfinder outline |
|---|---|---|---|---|
| Owner | `canvas-draw` (the gesture spine's Pen handler) | none: a view, it owns no pointer | the inspector (a panel) | the panel |
| Cursor | a state cursor per state (point 1) | unchanged | n/a | n/a |
| Cancel | Escape drops the run, nothing commits (`UXI-DRW-001`, `UXI-DRW-004`) | releasing Control, a window blur | n/a (each edit is immediate) | leaving the button |
| Undo | one step per run or per edit (`UXI-DRW-006`) | none | one step per edit | none until the click |
| Permission refusal | the engine refuses the insert; the run is dropped and logged | none needed (a read) | the engine's refusal is shown in words (`data-points-error`) | the panel's status line (as before) |
| Keyboard | Enter finishes, Escape cancels, Shift / Alt modify | Control | the fields and buttons are focusable | focus shows the outline as hover does |

## Consequences

- Tests: `apps/editor/packages/tools/test/pen-states.test.ts` (the states, cursors, hints, the finish
  click as one commit), `apps/editor/packages/shell/test/overlays/precision-magnifier.test.ts`,
  `apps/editor/apps/canvas/test/unit/panels/draw-precision.test.ts` (Points, suggestions, the
  Pathfinder outline) and `apps/editor/apps/canvas/tests/e2e/draw-precision.spec.ts` (each on the
  real engine, asserting the model and the history).
- The close and join cursors are no longer the plain pointer; a test that compared them to it now
  compares to the state cursor.
- When track IC's cursor controller lands, the Pen's `cursorAt` answers through it unchanged.
- A dry-run door in the engine (a mutation applied to a copy and answered as geometry) would let the
  Pathfinder and the suggestions preview their results; it is not built.
