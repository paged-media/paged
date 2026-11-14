# ADR 1111 — A document names its pages (`pageNoun`)

- **Status:** Accepted 2026-11-14.
- **Scope:** `packages/plugin-api/src/host.ts` (`EditContextContribution.pageNoun`, `PageNoun`),
  exported from the contract's index; the editor's `packages/shell/src/state/page-noun.ts`
  (`useDeclaredPageNoun`, `declaredPageNoun`, `capitalise`) and its readers: the spread grouping of
  the document map and the thumbnail rail (`cockpit/spread-grouping.ts`), the page lenses
  (`apps/canvas/src/panels/cockpit/page-lenses.tsx`), the document map's search
  (`document-map-panel.tsx`), the captions beside the pages (`overlays/page-decorations.tsx`) and
  the palette's Go to (`chrome/CommandPalette.tsx`). plugin-sdk passes the field through unchanged.
  plugin-sdk and plugin-api move to the next canary. Builds on
  [ADR 348](348-editing-doors.md) (the document context) and
  [ADR 1106](1106-an-edit-context-says-how-it-is-left.md) (`label`).

## Context

The editor called every page a page. A deck opened through paged.slide read "Cover", "Page 2",
"Page 3" in the document map and "Page 3" under each slide on the canvas, and the palette went to
"page 3" (UX audit F-47). The module knows what its pages are; the host did not, and had no door
through which a module could say it. A deck already holds the document context (ADR 348): the
module declares "this document is slide content" through an edit context it registered for that.

## Decision

One optional field on `EditContextContribution`:

- **`pageNoun?: { one: string; other: string }`** — what the pages of a document this context
  covers as a whole are called, in the editor's language, as the words read inside a sentence
  (`host.strings.t`): `{ one: "slide", other: "slides" }`. The host reads it only while the context
  is the document context (`host.shell.setDocumentContext`), and names the document's pages with
  it: the document map's rows ("Slide 1", "Slides 2–3", no "Cover") and its Pages lens and search
  ("Slides", "Search slides"), the page lenses' page references ("Slide 4"), the thumbnail rail,
  the caption beside each page on the canvas ("Slide 3"), and the palette's Go to ("Go to slide 3";
  "slide 3" and "go to slide 3" are understood beside the page words). Where a label starts the
  host capitalises the first letter. A blank declaration is none.
- Absent, or while no context with a noun holds the document context, everything reads exactly as
  before. The noun is a document's, not a frame's: a frame-level context's noun is not read.

No feature flag: a host that does not read the field says "page", as before.

## Consequences

- paged.slide declares `{ one: "slide", other: "slides" }` (German "Folie", "Folien") on its deck
  context (slide ADR 725); F-47's naming closes.
- A community module with a document context (a book of spreads, a set of labels) can name its
  pages the same way.
- Tests: `apps/editor/packages/shell/test/state/page-noun.test.ts` (the declaration, the
  capital, the document map's rows with and without a noun),
  `test/chrome/command-why.dom.test.tsx` (Go to slide 2, "No slide 40"),
  paged.slide's `test/headless/comments.spec.ts` (the deck context declares the noun).
