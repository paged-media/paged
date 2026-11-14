# ADR 1312 — Facing pages on an existing document

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

## Amendment (2026-11-14): a page moved or duplicated; a one-page master

1. **A page moved or duplicated in a facing document re-pairs the pages**, as InDesign's default
   "allow document pages to shuffle" does. In a `FacingPages="true"` document `MovePage` takes the
   page out of its spread with what sits on it (the unit of decision 1) and puts it right after
   `afterPageId`, or first when there is none; `DuplicatePage` copies the page's unit only, not its
   spread (fresh ids, the frames' stories copied as paged.data D-23 says), and puts the copy right
   after its page. The pages then pair up again from the first spread the change touches (the
   earlier of the page's and the target's, stepped back as in decision 2): page 1 alone on the
   right, then left/right pairs. Every page keeps its items, their place on the page and its
   master; a copy applies its page's master. One `relayout` serves all five operations (it now puts
   a page first, too); there is no second implementation.
2. **Undo stays exact.** `MovePage`'s inverse is `RestoreSpreads`. `DuplicatePage`'s is a batch:
   `RestoreSpreads` puts the spreads back as they were with the copy alone in its spread, then
   `RemovePageClone` removes it with its stories and hyperlinks, so undo restores the canonical
   hash. Redo re-runs the forward op: `MovePage` on the same document, `DuplicatePage` from its
   echo, whose capture says it re-pairs (`pair`, a field of the internal capture JSON, written
   only when true). No wire shape changed: protocol 83 stands. A save writes the result through
   decision 5. A single-sided document keeps the old rule: only a page alone in its spread moves
   or duplicates.
3. **A one-page master stays one page, and applies whole to both sides.** Asked of InDesign
   20.0.1 (`tooling/oracle/indesign/facing-pages-probe`, its answers in
   `facing-pages-probe.json`): switching a single-sided document to facing pages leaves its
   one-page master one page; a one-page master made in a facing document is one page too; every
   page that applies one, left-hand or right-hand, shows all its items; and on the PDF a
   rectangle 5 pt from the master page's left edge prints 5 pt from the left edge of page 1 (a
   right-hand page), page 2 (left-hand) and page 3 (right-hand) alike. Nothing is mirrored and no
   left side is made. Switching facing pages off again keeps the masters as they are. The engine
   already draws it so: `master_page_index` routes a page to the master page on its side and
   falls back to the one page when the master has none there, and the master page is laid onto
   the body page by its origin. So neither `setFacingPages` nor applying a master in a facing
   document turns a one-page master into a two-page one (the brief that asked for it assumed
   InDesign did); the first consequence above is InDesign's behaviour, now measured and pinned by
   a test. A two-page master keeps giving a left-hand page its left page and a right-hand page its
   right page.
4. **Tests:** `paged-canvas` `it::facing_pages`: a page of a two-page spread moved after page 1
   and to the front (the order, the pairs and sides, every item's place, its master kept, one step,
   undo to the canonical hash, redo, the saved IDML reopened with the same pages, pairs, items and
   master); a left-hand page and page 1 duplicated (the copy right after its page, the reply naming
   it, the pairs and sides, the copy's frame at its page's place and its master, one step, undo to
   the canonical hash, redo making the same copy, the saved IDML); and a one-page master under
   facing pages (one page still, the left-hand page's render equal to the right-hand pages' and to
   the single-sided one, the master item drawn).
