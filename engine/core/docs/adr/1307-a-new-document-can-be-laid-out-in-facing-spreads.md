# ADR 1307 — A new document can be laid out in facing spreads

- **Status:** Accepted 2026-11-14.
- **Scope:** protocol v81. `paged-canvas` (`blank.rs`: `blank_idml_layout`; `model.rs`:
  `CanvasModel::new_blank_layout`; `channel.rs`: `NewBlankDocument.pages` / `facingPages`),
  `paged-canvas-wasm` (the dispatch), the editor's client (`newBlankDocument(…, layout)`) and shell
  (the New document dialog's Facing pages switch, `applyDocumentSetup`). Closes the gap editor
  ADR 1220 recorded ("Facing pages are said to be unavailable").

## Context

The New document dialog (editor ADR 1220) could not offer facing pages: a blank document was one
single page, and `InsertPage` mints a spread per page, so nothing in the engine laid pages out as
InDesign lays out a facing-pages document — page 1 alone on the right of the spine, then
left/right pairs — or wrote `FacingPages="true"` into the document's preferences.

## Decision

**`NewBlankDocument` takes the page count and the spreads.** `pages` (1 to 999; absent: one) and
`facingPages` (absent: single pages). The engine writes the blank package with every page:

- single pages: one page per spread, as `InsertPage` would have made them;
- facing pages: page 1 alone as a right-hand page (x 0…W, the spine at x = 0), then spreads of a
  left-hand page (x −W…0) and a right-hand page, the last spread a single left-hand page when the
  count is even. Each spread sits below the last on the pasteboard. `<DocumentPreference
  FacingPages="true" PagesPerDocument="n">`, so the IDML a save writes opens in InDesign as a
  facing-pages document.

The pages' sides follow from where they sit (`BindingEdge::of_page`): a right-hand page binds on
its left, a left-hand page on its right, so `PageSummary.bindingEdge`, the inside and outside
margins and everything that reads a page's side see the spreads. The default canvas layout
(engine ADR 1011) still stacks the pages one below the other, as it does for an opened facing
document.

**Not part of this decision:** turning facing pages on or off in an existing document (it would
move every page item between spreads), and keeping pairs when a page is inserted into or removed
from a facing document — `InsertPage` still adds a single-page spread and `RemovePage` still
refuses a page of a multi-page spread, as for any opened facing document.

## Consequences

- The New document dialog offers Facing pages; a facing setup has the engine make all its pages,
  and the setup's margins land on each page's own side (a left-hand page's inside margin on its
  right).
- Tests: `paged-canvas` `blank` unit tests and `it::relink_and_facing` (the sides, the spreads,
  the saved IDML), `paged-canvas-wasm` `it::dispatch` (`newBlankDocument` over the wire), the
  shell's `new-document-presets` and `new-document-dialog` tests, and
  `apps/canvas/tests/e2e/new-document-dialog.spec.ts`.
