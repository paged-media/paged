# ADR 300 — The markup margin band: balloons beside the page follow their anchors

- **Status:** Accepted 2026-10-29.
- **Scope:** `packages/shell/src/registries/context-bar.ts` (`createMarginBandRegistry`),
  `packages/shell/src/state/registries-context.tsx` (`marginBands`),
  `packages/shell/src/overlays/margin-band.tsx` (`marginBandContribution`, `MarginBandView`,
  `layoutBalloons`, `anchorTouched`), `apps/canvas/src/app/mount.tsx`,
  `apps/canvas/src/ui/useTextEditing.ts` (forward Delete over tracked text, `textStays`).
  Contract: extensions ADR 349 amendment 1 (C5). Engine: ADRs 1037 (change tracking) and
  1020 (range comments). First consumer: paged.doc (doc ADR 613).

## Context

Word shows a document under review with a markup area to the right of the page: a balloon per
deletion, formatting change and comment thread, level with the line it belongs to, joined to
it by a dotted line, pushed down when balloons would overlap, and staying with its text as the
document reflows. paged.doc can read the changes and the comments from the engine, but the
editor had no place beside a page for a bundle to put anything, and an overlay a bundle draws
for itself would have to re-derive the page geometry, the camera and the text's lines.

## Decision

- **The host owns the geometry, the bundle the content.** A bundle contributes a band
  (`contribute.marginBand`, extensions ADR 349 amendment 1) with items anchored to a story's
  content range, and a React component that draws one balloon. The band applies while its
  edit context is the active scope context (the frame-level context, else the document
  context, ADR 298), like a status item.
- **Placement.** Each item's anchor is read through the engine's selection geometry (the line
  rects the selection highlight uses; the caret's for an empty range): the first rect names the
  page and the line. The balloon stands in a column starting just right of that page (bands in
  `order`, each its own column), its top level with the line. In text order (top, then left)
  a balloon that would overlap the one above it moves down below it, with a gap; heights are
  measured (`ResizeObserver`) so a thread that grows pushes the next one. A leader line runs
  from the anchor's line end across the page edge to the balloon, in the item's colour, solid
  for the current balloon.
- **Kept on screen.** A balloon never leaves the canvas to the right: when the page is wider
  than the view, the column is moved left to the canvas's edge (it may then cover the page's
  margin), so the panels beside the canvas never hide a balloon.
- **Screen-constant size.** Balloons scale by the camera's inverse (as the sub-context bar,
  ADR 301), so they stay readable at any zoom; their place is in document space, so they pan
  and zoom with the page.
- **Following the text.** The anchors are read again when the bundle reports its items
  changed (`onDidChange`) and on every push that moves text: `mutationApplied`,
  `undoApplied`, `redoApplied`, `documentLoaded`. A read that a newer one overtook is dropped.
- **Current balloon.** A balloon whose anchor the caret or the selection touches is
  `active`: the bundle draws it emphasised, the host draws its leader solid.
- **Input inside a balloon** (a reply field) is the balloon's: pointer and key events stop at
  the balloon, so typing a reply never reaches the canvas text input.
- **Tracked deletions and the caret.** With Track Changes on, deleted text stays in the story
  (struck through, engine ADR 1037). Backspace already left the caret before the struck
  character; forward Delete left it in front of it, so the next Delete struck the same
  character again. The text input now measures the story around a forward Delete
  (`textStays`): when the delete was applied and the story kept its length, the caret steps
  past the deleted range, as Word's does.

## Consequences

- A content type gets Word's review layout without drawing on the canvas; the host stays
  format-neutral (an item is an anchor, a kind and a colour).
- The band sits in the canvas's overlay space beside each page: pages laid out side by side
  leave it no room, and a balloon may cover the neighbouring spread there. Word's own option
  (balloons in a wider markup area that shrinks the page) is not built.
- Each anchor costs one geometry read per refresh; a document with hundreds of balloons reads
  them in sequence. Batching the reads (one request for many ranges) is an engine follow-up.
- Tests: `packages/shell/test/overlays/margin-band.dom.test.tsx` (the layout and the touched
  test as functions; balloons beside the page level with their anchors, pushed down, leader in
  the item's colour, following a mutation, re-read on the bundle's change, the current balloon,
  nothing for another context).
