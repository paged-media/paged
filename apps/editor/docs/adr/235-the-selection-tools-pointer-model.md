# ADR 235 — The Selection tools follow InDesign's pointer model

- **Status:** Accepted 2026-10-19.
- **Scope:** `apps/canvas/src/ui/ViewportCanvas.tsx` (press, click, double-click),
  `apps/canvas/src/panels/canvas-panel.tsx` (`onHit`), `apps/canvas/src/ui/useGestureSpine.ts`,
  `packages/shell/src/tools/gesture-spine.ts`, `packages/shell/src/overlays/resize-handles.tsx`,
  `packages/tools/src/handlers/` (the shape, Type and transform tools)

## Context

The Selection tool's press, click and double-click live in the canvas's own pointer path
(`ViewportCanvas`), not in a gesture handler. The UX audit and the gesture matrix found that
path departing from InDesign in five ways (root R24 of the conformance findings): a press-drag
on an unselected frame drew a marquee and moved nothing (F-26); a double-click on a grouped
shape or a placed image entered paged.draw's vector-graphic context, and Direct Selection
selected the whole group (F-29); just outside a corner the drag resized, and rotation was
reachable only from the top handle (F-30); a Hand-tool click ran the Selection click and
changed the selection (GT-5). The transform tools read the selection the tool was picked with
(GM-2). The drawing tools decided click versus drag in document points, so at low zoom a
click jitter drew a shape (R23: GT-1); the Type tool read a drag's release point off the page
under it (GT-3), and the transform tools began nothing on the pasteboard (GT-4).

## Decision

1. **A press decides by what it lands on.** A Selection or Direct Selection press off the
   current selection asks the engine what is under it. Once the drag passes the 4 px click
   threshold, it selects that item as a click would (the item, or its outermost group outside
   the active group) and moves the selection, in one gesture and one undo step. On empty
   space the drag draws the marquee. Cmd keeps the marquee (toggle-select). A drag released
   before the hit test answers is finished when the answer arrives.
2. **Double-click resolves by content.** Text puts the caret in the text, as before. A shape
   in a group the user has not entered selects that shape and enters the group. The next
   double-click, inside the group, reaches the shape's own context. A frame holding a placed
   image is content, not vector artwork: only the plugin that owns it by metadata (paged.image's
   raster context) may claim it. paged.draw's vector-graphic context claims the other
   path-bearing kinds by kind, as before.
3. **Direct Selection reaches the leaf.** A click selects the hit item itself, never its group,
   and leaves the active group as it is.
4. **A rotate band outside each corner.** Each corner handle's hit area now ends at the edge of
   its visible square. Beyond that, a 24 px band outside the corner carries
   `data-handle="rotate"` and a rotate cursor, so a drag there rotates the selection and keeps
   its size, as in InDesign and Illustrator. The top rotate handle stays.
5. **The Hand only pans.** A Hand click (or a click with Space held) selects nothing.
6. **Tool handlers hold a live editor.** The gesture spine activates each handler with a
   proxy that reads every member from the latest render's `PagedEditor`. A handler that holds
   it reads the current selection, camera and settings. This closes GM-2 for Rotate, Scale and
   Shear, and the same snapshot problem in every other handler that reads the selection (for
   example the Gradient tool).
7. **Drawing tools decide click versus drag in screen pixels (INV-6).** A release within
   `CLICK_DRAG_THRESHOLD_PX` of the press draws nothing, at any zoom. This applies to the
   Rectangle, Ellipse, Polygon, Line, Gradient and Type tools. A Type-tool drag resolves its
   release point against the page it started on, as the Rectangle tool does. A Rotate, Scale
   or Shear drag that starts on the pasteboard names its anchor on the page the selection
   sits on (pages laid out by `layoutPageRects`).

## Consequences

- One gesture moves an unselected item, which is the most frequent canvas gesture. The
  marquee needs a press on empty space or Cmd held.
- A placed image no longer opens vector editing. Until paged.image claims every placed photo
  (it does not yet see File ▸ Place frames, a separate open row), a double-click on such a
  frame leaves it selected.
- Alt-drag duplication of an unselected group now reaches the engine and stops there
  (GF-2), so the gesture matrix marks those two cells `known: GF-2` instead of F-26.
- The rotate band costs a few pixels of marquee start area around a selected item's corners,
  as it does in InDesign.
