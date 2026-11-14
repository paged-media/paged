# ADR 1213 — Page lenses and semantic zoom

- **Status:** Accepted 2026-11-13.
- **Scope:** `apps/canvas/src/panels/cockpit/document-map-panel.tsx` and `page-lenses.tsx` (the
  lenses and the search), `panels/layer-objects.tsx` (the object tree, with names, shared with the
  Layers lens); `packages/shell/src/state/semantic-zoom.ts` (the tiers), `state/editing-aids.ts`
  and `overlays/overlay-host.tsx` (the overlay rule gains the tier), `overlays/page-decorations.tsx`
  (page names placed and translated), `overlays/selection-chrome.tsx`,
  `cockpit/canvas-frame/Rulers.tsx` and `ruler-marks.ts` (minor ticks).
- **Implements:** the redesign strategy's §4.3 (navigation lenses) and §4.4 (semantic zoom); the
  interaction contract's UXI-CAM-016 and UXI-CAM-017
  ([ADR 1200](1200-the-interaction-contract-is-adopted.md)). Amends
  [ADR 263](263-ruler-labels-thin-as-you-zoom-out.md). Closes UX audit F-57.

## Context

The Design mode's left panel, the document map, listed spreads with thumbnails, the sections as
chips and a search over spread names and page ranges. Finding a heading, a story, a named object
or the page an overset story ends on meant other panels, each with its own way of moving the
camera (or none: the Layers panel selects without showing). The canvas drew the same overlays at
every zoom: at 8 % a selected 72 pt frame was buried under its eight handles and its ports, and
the "page N" captions, drawn under each page, sat on the next page's content once the 24 pt gap
between stacked pages was 2 px on screen (F-57). Zoomed in to place something exactly, the rulers
showed only their labelled marks.

## Decision

**Lenses.** The document map has five lenses on one tab strip (roving arrows) and one search
field over all of them:

- **Pages** — the spreads and their pages, as before; the search also matches page names
  (folios).
- **Structure** — the sections (to their first page), the headings the resolver numbered
  (indented by level, to their page), the bookmarks with a page destination, and the stories
  (to their first frame, selected; an overset story marked).
- **Layers** — each layer (its colour, hidden and locked states) with its page items, a group's
  members indented, by the name the user gave them (Object options ▸ Name) or else their kind and
  id; a click selects the item and brings its page into view. The object tree is the Layers
  panel's (`useObjectTree`, now exported and reading `itemName`).
- **Issues** — one row per page with problems: missing links and images under 150 effective ppi
  (by their host frames), overset stories (by their last frame) and the last preflight's findings
  with a page; a click selects the problem's page items and shows their page (a page with only
  preflight findings is fitted). Missing fonts, which belong to no page, are one Document row; a
  preflight that has not run says so. This is the data DF7's issue markers will draw on the
  canvas.
- **Data** — shown only while the document has a data binding: the records its placements show,
  one row each; a click selects the page items the record landed in.

Every jump is an explicit navigation: it records the place it leaves for Back
([ADR 1211](1211-navigation-history-and-one-current-page.md)); a click never changes the
document. A lens reads only while it is shown.

**Semantic zoom.** Three tiers by the camera's scale (`semantic-zoom.ts`): **overview** below
15 % (a 72 pt frame is then under 11 CSS px, smaller than its handles), **page** up to 400 %,
**detail** from 400 %. In an overview the overlay host does not draw the resize and rotate
handles, the threading ports, the live-shape widgets, the content grabber or path points; the
selection's outline, the markers and the page names stay, at their screen size. In detail the
rulers draw minor ticks between their labelled marks (a tenth, a fifth or a quarter of the step
for steps of 1, 5 and 2, no closer than 4 px). The baseline grid is not drawn once its lines would
be closer than 3 px (ADR 1212). The tiers change what the overlays and the rulers draw, never the
selection, the tool or the document, and never the result of a click: a click in an overview
selects as it does at any zoom.

**Page names stay off the pages.** A page's caption ("Page 3", translated) sits under the page
while there are 18 px of pasteboard below it, else beside its top-left corner, outside the page,
so at no zoom does it cover the next page's content (F-57). Its anchor (`data-caption-place`) says
which.

## Consequences

- `apps/canvas/tests/e2e/page-lenses.spec.ts`: the Layers lens finds an object by the search,
  selects it and Back returns the view with the selection kept; Structure selects a story's
  frame; Issues lists the page with the overset story and selects its frame; the history and the
  document unchanged; zoomed to 8 % the handles go and the outline and the side-placed page names
  stay, at 800 % the rulers have minor ticks, and the selection and the tool are as they were. The
  lenses' helpers (search, headings, link problems, issues by page, records) in
  `apps/canvas/test/unit/page-lenses.test.ts`; the tiers and the overlay rule in
  `packages/shell/test/state/semantic-zoom.test.ts`; the minor ticks in
  `test/chrome/rulers.test.ts`.
- F-57 closes (its ruler half closed with ADR 263).
- Not taken: a heading's exact place on its page (the resolver gives its page only), the stories'
  names (a story has none; rows read "Story n"), unplaced data records (nowhere to go), and a
  zoom-dependent hit test.

## Related

- [ADR 263](263-ruler-labels-thin-as-you-zoom-out.md) — amended: minor ticks in detail.
- [ADR 1211](1211-navigation-history-and-one-current-page.md) — the lenses' jumps are recorded.
- [ADR 1212](1212-editing-aids-and-proof-view.md) — the overlay rule the tiers join.
