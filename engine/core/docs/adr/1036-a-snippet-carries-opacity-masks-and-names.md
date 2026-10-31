# ADR 1036 — A snippet carries its opacity masks and item names; an inline PDF is readable

- **Status:** Accepted 2026-10-27.
- **Scope:** `paged-mutate` (`apply/snippet.rs`: `count_subtree`, `Graft::graft`;
  `apply/duplicate_nodes.rs`: `remove_minted`); `paged-renderer`
  (`pipeline/images.rs`: `resolve_inline_image_bytes`). No wire change, no protocol bump. Amends
  [ADR 193](193-page-item-snippets.md). Consumer: publish ADR 658 (place a PDF or Illustrator
  page as vectors). Gaps D-60, D-61.

## Context

A snippet (ADR 193) is the engine's one way to graft finished page items onto a spread in one
undoable operation: `pasteElements` → `InsertSnippet`. paged.pdf's place-as-vectors builds one
from a PDF page — paths, clip groups (ADR 1010), gradients, images, text frames — instead of
replaying hundreds of `insertPath`/`setElementProperty` writes, because the snippet holds the
native model exactly (every contour's open flag, `GradientFillStart`, the fill rule) where the
wire ops cannot. Two things a PDF page has did not survive the paste:

- **an opacity mask** (C-28, `Spread::opacity_masks`): the graft copied the items in the z-order
  and their side maps, but a mask item sits in no z-order, and the target's entry was keyed by
  its source id — so a soft-masked object pasted unmasked;
- **an item's name** (`Spread::item_names`, ADR 131/132): the placed artwork's group, named
  after the file, pasted nameless.

## Decision

- **The graft copies a masked item's mask.** When the source item has an
  `opacity_masks` entry, its mask item is grafted too (under the next minted id, listed in no
  z-order and no group, as in the source) and the copy's entry names the copied mask item, mask
  type and invert kept. `snippet_demand` counts the mask item, so the canvas mints its id with
  the rest; `snippet_roots` stays the roots.
- **The graft copies an item's name** from `item_names` to the copy's id.
- **Undo removes both.** `remove_minted` (the inverse of `InsertSnippet` and of a duplicate)
  drops the `opacity_masks` and `item_names` rows of every id it removes.
- **Copy is unchanged:** `extract_snippet` still refuses a masked item, as a duplicate does
  (ADR 193's refusals). Lifting that is a separate change; paste now reads what a copy would
  have to write.

- **An inline placed PDF is readable through the placed-asset door.** A linked PDF was already
  remembered encoded-only in the decode cache, so `placed_asset_bytes` (the SDK's
  `assets.getPlacedImage`) served it; a PDF held as the frame's own bytes (what
  `replaceImageBytes` writes) was not, so Convert Placed PDF to Vectors could not read it. The
  inline path now remembers it the same way.
- **A replaced inline image is not served stale.** The inline cache key is the element's id
  (C-26), so after `replaceImageBytes` (or its undo) the build found the previous file's entry and
  drew and served it. An entry whose original bytes are not the frame's bytes is dropped first.

## Consequences

- A PDF soft mask that the engine's model can say (one mask item over graphic items) lands as a
  native opacity mask, in the same single undo step as the rest of the page.
- A copy of a named item pasted through the clipboard keeps its name now (it lost it before).

## Evidence

- `crates/paged-canvas/src/model.rs`
  (`an_inline_placed_pdf_is_reachable_through_the_door__feat__editor_shell_import_svg_pdf_vectors`):
  a PDF written over a placed PNG is served, with its page size, after the build.

- `crates/paged-mutate/tests/it/item_snippet.rs`
  (`a_masked_named_item_pastes_with_its_mask_and_name__feat__editor_shell_import_svg_pdf_vectors`):
  the mask item is minted, unlisted in the z-order, named by the copy's entry with its type and
  invert; the name rides; undo restores the document exactly.
- `modules/publish/crates/pdf-import/tests/place_snippet.rs`
  (`a_soft_mask_lands_as_an_opacity_mask…`): a PDF luminosity soft mask pasted end to end.
