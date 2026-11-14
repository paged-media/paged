# ADR 725 — A deck names its slides, and a slide's actions stay on the slide

- **Status:** Accepted 2026-11-14 (UX audit F-47; task CM5 of the editor's interaction plan).
- **Scope:** `packages/slide-bundle/src/activate.ts` (the deck context's `pageNoun`),
  `src/messages.ts` and `locales/de.json` (the words), `src/panels/slides-panel.tsx` (the per-slide
  actions). On extensions [ADR 1111](../../../../platform/extensions/docs/adr/1111-a-document-names-its-pages.md)
  (the page noun) and extensions ADR 348 (the document context).

## Context

UX audit F-47: a deck behaved like a long document. It opened as a vertical page stack at 11 %,
the editor's captions said "page N" on top of the slides, the document map named slide 1 "Cover"
and the others "Page 2…", the Slides panel repeated Duplicate, Delete and Hide under every
thumbnail, and there was no sorter and no Play. Since then the editor fits page 1 when a document
loads (editor ADR 1208), draws a page's caption beside it when the gap below is too small (editor
ADR 1213), and paged.slide has a slide show, a presenter view and the slide sorter (ADR 716). The
names and the repeated actions were left: the editor had no door through which a module says what
its pages are.

## Decision

1. **A deck's pages are slides.** The deck's document context (`slideDeck`, held while the open
   document is a deck) declares `pageNoun: { one: "slide", other: "slides" }` in the editor's
   language ("Folie", "Folien" in German). The editor names the deck's pages with it (extensions
   ADR 1111): "Slide 1" (no "Cover") and "Slides 2–3" in the document map, its Slides lens and
   search, "Slide 4" in the page lenses, "Slide 3" beside each slide on the canvas, and "Go to
   slide 3" in the palette. A document that is not a deck keeps "Page".
2. **A slide's actions stay on the slide.** In the Slides panel, Duplicate, Delete and Hide show on
   the slide in view and on the slide the pointer or the keyboard is on — not under every
   thumbnail. Tab from a thumbnail reaches its actions; Delete on a focused thumbnail still deletes
   its slide.

## Consequences

- F-47 closes: slide naming (here), the sorter and Play (ADR 716), the first-slide fit and the
  captions beside the pages (editor ADRs 1208, 1213), and the per-slide actions (here).
- Tests: `test/headless/comments.spec.ts` (the deck context declares the noun),
  `test/panels/slides-panel.dom.test.tsx` (a slide not in view shows its actions under the
  pointer), the editor's `page-noun.test.ts` and `command-why.dom.test.tsx`, and
  `apps/editor/apps/canvas/tests/plugin-surface/slide.spec.ts` (the caption says "Slide 1", the
  lens "Slides"; the sorter test goes to a slide before its actions, as a user does — a hover
  can move to another row when the thumbnails below finish loading).
