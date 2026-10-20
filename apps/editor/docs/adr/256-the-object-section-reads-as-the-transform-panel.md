# ADR 256 — The Object section reads as the Transform panel; type settings lead in text

- **Status:** Accepted 2026-10-20.
- **Scope:** `apps/canvas/src/panels/page-bounds-leaf.tsx` (`paged.input.pageBounds`, the Object
  section of Properties and the Control panel), `apps/canvas/src/panels/properties-panel.tsx`.

## Context

UX audit F-38 (PN-252): the Transform panel shows a frame as X / Y / W / H with a reference
point, while the Object section that Properties and the control strip render for the same frame
showed Top / Left / Bottom / Right with no reference point. The same geometry read two ways.
UX audit F-37 (PN-22): with a caret in a selected text frame, Properties rendered the Object and
Stroke sections before Character and Paragraph. InDesign's Properties panel puts the type
settings first in text context and the frame's settings after them.

## Decision

- The Object section's geometry row is X / Y / W / H with a reference point, as the Transform
  panel and InDesign's Control and Properties panels show it. X and Y move the selection rigidly
  (one undo step, any selection, the footprint on the page); W and H resize about the reference
  point and are editable only where an edge write is the edge the user sees (one rectangle,
  ellipse or text frame with no rotation, scale or shear). The row's `data-page-bounds` still
  says `edges` or `readout`.
- In text context (a caret or a text range) Properties renders Character and Paragraph first;
  Object and Stroke follow. A frame selection keeps Object first.

## Consequences

- PN-252 and PN-22 close (`object-transform-panel.dom.test.tsx`, `properties-panel.dom.test.tsx`;
  the Playwright `transform-readout.spec.ts` reads the new cells).
- Top / Left / Bottom / Right are no longer typed anywhere in the Object section; the edge values
  stay readable through `frameBounds` (Transform panel's inner box, scripting).
