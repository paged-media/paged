# ADR 370 — Vector editing with feedback: the Pen's named states, a precision magnifier, point-level controls, shape suggestions, and saying what a path operation takes

- **Status:** Accepted 2026-11-14. Amended 2026-11-14: the Pathfinder previews its result through
  the engine's dry run (engine ADR 1310); see "Amendment (2026-11-14): the Pathfinder previews its result".
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
6. **Before a Pathfinder click** (as amended: the Pathfinder previews its result). While a button is hovered or
   focused, the canvas shows the operation's result from the engine's dry run — solid and named
   "Result", the operands it consumes dashed — and the click applies it as one undo step. Where no
   preview can be made (the engine refuses the write, the read fails) the canvas outlines what the
   button takes instead — the object that keeps the result of a shape mode (the first selected) or
   that Crop cuts with and Minus back keeps (the frontmost by the scene tree's order) solid and
   named, the others dashed — and the panel says the button applies on click, with the engine's
   reason. Nothing is drawn that the click would not do.

## Interaction contract (the specification's §21.3)

| Item | Pen | Magnifier | Points / suggestions | Pathfinder preview |
|---|---|---|---|---|
| Owner | `canvas-draw` (the gesture spine's Pen handler) | none: a view, it owns no pointer | the inspector (a panel) | the panel |
| Cursor | a state cursor per state (point 1) | unchanged | n/a | n/a |
| Cancel | Escape drops the run, nothing commits (`UXI-DRW-001`, `UXI-DRW-004`) | releasing Control, a window blur | n/a (each edit is immediate) | leaving the button |
| Undo | one step per run or per edit (`UXI-DRW-006`) | none | one step per edit | none until the click; the click is one step |
| Permission refusal | the engine refuses the insert; the run is dropped and logged | none needed (a read) | the engine's refusal is shown in words (`data-points-error`) | the panel's status line (as before) |
| Keyboard | Enter finishes, Escape cancels, Shift / Alt modify | Control | the fields and buttons are focusable | focus shows the preview as hover does |

## Consequences

- Tests: `apps/editor/packages/tools/test/pen-states.test.ts` (the states, cursors, hints, the finish
  click as one commit), `apps/editor/packages/shell/test/overlays/precision-magnifier.test.ts`,
  `apps/editor/apps/canvas/test/unit/panels/draw-precision.test.ts` (Points, suggestions, the
  Pathfinder outline) and `apps/editor/apps/canvas/tests/e2e/draw-precision.spec.ts` (each on the
  real engine, asserting the model and the history).
- The close and join cursors are no longer the plain pointer; a test that compared them to it now
  compares to the state cursor.
- When track IC's cursor controller lands, the Pen's `cursorAt` answers through it unchanged.
- The engine's dry run (engine ADR 1310) lets the Pathfinder preview its result (its amendment below); the
  shape suggestions still apply on click and could preview through the same door.

## Amendment (2026-11-14): the Pen's nine states on the cursor controller

Editor ADR 1227 gave the canvas one cursor controller. The Pen's states reach it through two of its
layers, and nothing else writes the canvas's cursor: between presses the handler's `cursorAt` (start,
draw, continue, close, join, finish, add, delete) is the hover layer, as before; while a press holds
the pointer the handler's `pressCursor` — the same state function, read with the button down — is
the session layer, set on the press and on each move of its drag and cleared when the press ends,
committed or rolled back (`apps/canvas/src/ui/useGestureSpine.ts`). So the ninth state, the handle
being pulled, now shows during the drag: before, the canvas asked for a cursor only while no drag
was in flight, and `dragHandle` never reached the screen. `pressCursor` is a shell-side member of
the gesture handler (as `busy` is), not the contract's. Test:
`apps/editor/apps/canvas/test/tools/pen-cursor.dom.test.tsx` (the mounted canvas over the real
engine: the session layer and the host's cursor during the pull, cleared on release).

## Amendment (2026-11-14): the Pathfinder previews its result

The engine now has the dry run point 6 waited for: `RequestPreview` (protocol 82, engine ADR 1310)
applies any write to a copy of the document in a model of its own, through the whole write path,
and answers the items it would create and remove and the outlines it would leave, the document and
its history untouched. The Pathfinder sends it the very write the button sends
(`shapeModeMutation`, `regionVerbMutation` in `apps/editor/apps/canvas/src/pathfinder-commands.ts`,
one value for both) and draws the answer on the panel's overlay layer (`resultPreview` in
`pathfinder-preview.ts`): every result contour solid, the first named "Result", the consumed
operands dashed. The panel's line reads "point at a button to preview its result; a click applies
it as one undo step". The operand outline and the "applies on click" wording stay only where no
preview can be made: a refused write (its reason shown) or a failed read. Tests:
`apps/editor/apps/canvas/tests/e2e/draw-precision.spec.ts` (the preview's contours are the engine's
dry run's, the consumed operand dashed, Divide's regions, the model and the history unchanged
before the click, the click one undo step) and the engine's `paged-canvas` `it::dry_run`.
