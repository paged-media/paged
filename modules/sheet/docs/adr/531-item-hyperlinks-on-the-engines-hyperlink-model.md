# ADR 531 — Item hyperlinks: a picture's or shape's click action is the engine's link

- **Status:** Accepted, 2026-11-08. Extends 526 (hyperlinks; cell links stay sheet's) and 530.
  Builds on engine ADR 1026 (`insertItemHyperlink`) and the batch handles of RFI C-15.
- **Scope:** `sheet-xlsx/src/parts/{pictures,shapes}.rs` (`item_link`), `sheet-js` (`link` on
  `PictureInfo`, `PagePicture`, `PageShape`), the host model's `table-pictures.ts` and
  `table-shapes.ts`; engine: `paged-canvas/src/batch_handles.rs`.

## Context

A picture or shape in a drawing can carry a click action (`a:hlinkClick` on its `xdr:cNvPr`, with
a relationship of the drawing for an external URL). The page placed the picture or shape and
dropped the link. The engine has its own model for exactly this: a page item can be the source of
a hyperlink (`insertItemHyperlink`, listed in the document's hyperlinks with its source item,
exported to PDF as a link annotation and to IDML as a hyperlink page item source). A cell's link
is a different thing: it belongs to the worksheet (`<hyperlinks>`, ADR 526) and stays sheet's.

## Decision

1. **Read.** An item's `a:hlinkClick` is followed through the drawing's relationships to its
   target; an external target is the item's `link`. A link inside the workbook (`#Sheet1!A1`)
   or a show action has no URL the page can follow and is left out.
2. **Place on the engine's model.** The picture's and shape's ops end with an
   `insertItemHyperlink` on the item's batch handle (`$h:picN`, `$h:shpN` on a shape's first
   path), in the batch that makes the item: one undo step removes the item with its link, and the
   link is the engine's, so it exports as a link in the PDF and IDML like any other.
3. **The engine resolves `item`.** A batch handle resolved only in positions named `…Id` /
   `…Ids` (and a few others); `insertItemHyperlink` names its target `item`. `item` is now an
   address position (`paged-canvas`, `batch_handles::is_address_key`); no wire shape changes, so
   no resync. Only a reference string is ever rewritten.

## Consequences

- A linked picture or shape on a placed range is a clickable item in the exported PDF. Evidence:
  `paged-canvas/tests/it/item_hyperlink_in_batch.rs` (a frame and its link in one batch, one
  undo removes both), `batch_handles::an_item_hyperlink_takes_the_bound_item`,
  `sheet-js/tests/it/w3_shapes.rs` (`an_items_click_action_is_its_external_url`),
  `table-pictures.spec.ts`, `table-shapes.spec.ts`.
- The link is not written back to the workbook (the page's items are regenerated from the file).
- A link of a cell inside a placed table is still not clickable on the page (ADR 526): the wire's
  `insertHyperlink` takes a story range with no table-cell qualifier.
