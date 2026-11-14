# ADR 1311 — Facing pages on an existing document

- **Status:** Accepted 2026-11-14.
- **Scope:** protocol v83. `paged-wire` (`Mutation::SetFacingPages`), `idml-export` (a re-laid-out
  spread written whole), `paged-mutate`
  (`Operation::SetFacingPages`, `Operation::RestoreSpreads`, `apply/page_layout.rs`, the facing
  paths of `InsertPage` and `RemovePage` in `apply/batch_page.rs`, the permit classes),
  `paged-canvas` (the lowering, the `doc.facingPages` path, `DocumentMeta.facingPages`, the pages a
  facing insert made, the undo label), `paged-introspect` (the virtual path, the catalog),
  `paged-script` (`paged.setFacingPages`), the editor (Document Setup's Facing pages row and
  `paged.insert.facingPages`). Closes what engine ADR 1307 left out.

## Context

Engine ADR 1307 laid a NEW document out in facing spreads and left two things out: turning facing
pages on or off in an existing document, and keeping the pairs when a page is inserted into or
removed from a facing document — `InsertPage` added a single-page spread and `RemovePage` refused a
page of a multi-page spread, so after one insert every later page stood on the wrong side of the
spine.

## Decision

1. **`setFacingPages { facing }` lays every page out again, as one undo step.** Each spread is cut
   into one unit per page: the page, every page item whose centre lies on it (an item on the
   pasteboard goes with the nearest page), with the group members, pasted-in children and mask
   items it brings, and every side-map entry keyed by those ids or the page's (margins, labels,
   names, image metadata, opacity masks, endnote frames, guides). The units are joined again in
   page order — facing: page 1 alone as a right-hand page, then a left-hand and a right-hand page
   per spread (a right-to-left binding mirrors both); single: one page per spread. Each page moves
   to its side of the spine (a right-hand page starts at x = 0, a left-hand page ends there; a
   single page that already binds on its left keeps its place, another starts at 0), and every item
   on it moves by the same offset, so nothing changes on the page. The pages of a spread share the
   first one's top; the spreads stack down the pasteboard. The spreads keep their ids in order; a
   spread more than before takes a fresh `u<hex>` id. `FacingPages` is written, so the IDML a save
   writes opens in InDesign as what the editor shows.
2. **Pairs hold when the page count changes.** In a document whose preferences say
   `FacingPages="true"`, `InsertPage` puts the new page right after `afterPageId` (inside its
   spread if need be) and `RemovePage` takes the page out with everything on it — a page of a
   two-page spread too — and the pages after it pair up again from the first spread that changes
   (stepped back so the pages before it end a pair). The only page stays. A document that never
   said, or says single pages, keeps one spread per inserted page, as before.
3. **Undo is exact.** The inverse of all three is `RestoreSpreads { first, capture }`: the spreads
   from the first one touched, captured whole (and the facing flag when it changed), put back
   verbatim; its own inverse captures what it replaced, so undo and redo restore the document's
   canonical hash. Redo re-runs the forward op, which mints the same ids on the same document. The
   reply of a facing insert names the page it made (`createdPages`, read from the forward echo).
4. **One door per caller.** `doc.facingPages` (bool) is a virtual path whose write resolves to
   `setFacingPages`, so Document Setup's row writes `set("doc", "facingPages", …)` like its other
   fields; `DocumentMeta.facingPages` reads the flag; scripts call `paged.setFacingPages(facing)`.
   The permit is `document.pages`, as for the other page-structure operations.
5. **A save writes what the spreads hold.** `idml-export` writes a source spread whose pages the
   model changed whole from the model (`emit::spread_part`), as it writes a spread `InsertPage`
   minted: the rewrite that patches a source spread keeps the source's `<Page>` elements and has
   no lane for a page that joined it, so a re-laid-out document saved one page per spread.

## Consequences

- The masters keep their pages: a one-page master applies to both sides, as it did; turning a
  master into a two-page master is not part of this.
- A spread of more than two pages (a gatefold) from the first changed spread on is laid out again
  as pairs; `MovePage` and `DuplicatePage` still act on single-page spreads only.
- A new spread takes the linear part of its transform (a rotated spread) from the spread its first
  page came from; the layout itself is computed on the pages' boxes in their spreads.
- Tests: `paged-canvas` `it::facing_pages` (pairs and sides, every item's place on its page, one
  undo step and the canonical hash after undo, redo, back to single pages, the saved IDML; an insert
  after a left-hand page and its reply; a page of a two-page spread removed with its frame, the
  others in place, undo; the only page kept), the editor's Document Setup DOM test and its command.
