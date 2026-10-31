# ADR 1011 — A page has a place on the canvas (artboards)

- **Status:** Accepted 2026-10-25.
- **Scope:** protocol v77 (one new Mutation kind, rides v77 — see Consequences).
  `paged-model` (`Page::canvas_origin`, `canvas_layout`, `CANVAS_PAGE_GAP_PT`);
  `paged-mutate` (`PropertyPath::PageCanvasOrigin`, the copy of a placed page in
  `apply/duplicate_page.rs`); `paged-wire` (`Mutation::PlacePage`); `paged-renderer`
  (`BuiltPage::canvas_origin`); `paged-canvas` (the handle, the pages collection, the
  reply grid, the IDML loss); `paged-canvas-wasm` and `paged-sdk` (the presenters);
  `paged-script` (`paged.placePage`); `paged-introspect` (`pageCanvasOrigin`). Gap D-45.

## Context

Every presenter stacked the pages down the canvas with a hard-coded 24 pt gap: the
editor canvas's GPU pass (`paged-canvas-wasm` `present_frame`), the viewer session
(`paged-sdk` `page_layout` / `present`) and every editor surface that maps a pointer to a
page (`layoutPages`, mirrored in the shell). The model stores IDML's own placement
(`Page::item_transform` inside its spread, `Spread::item_transform` on the pasteboard),
but each page is built as its own display list in page coordinates, and InDesign's
spreads are constrained anyway: the pages of a spread sit side by side and the spreads
stack. Illustrator-style artboards — boards anywhere on the canvas, moved, resized and
exported one by one — had nowhere to live.

## Decision

**A page has a canvas origin.** `Page::canvas_origin: Option<[f32; 2]>` is the page's
top-left on the canvas in document points. It is NATIVE: IDML import leaves it `None`,
the `.paged` model part stores it only when set (`skip_serializing_if`), so a document
nobody arranged is byte- and hash-identical to before and no `PGM_FORMAT_VERSION` step is
needed.

**The default slot.** `paged_model::canvas_layout` resolves every page: a placed page
sits at its origin; an unplaced one at `x = 0`, `y =` the heights of the pages before it
plus one `CANVAS_PAGE_GAP_PT` (24) each — the stack every presenter drew. The slot does
not depend on where other pages were placed, so placing one page never moves another,
and an imported document looks exactly as it did.

**The build carries it.** `BuiltPage::canvas_origin` is resolved once per build
(`build_engine`, generated pages included). Display lists stay page-relative; the
presenters place each page at its origin: the canvas GPU pass (its visibility cull and
per-page transform), `pageInfo` (`[id, w, h, x, y]`, the CPU lane), the viewer session's
`PageRect.xPt`/`yPt` and its `present`.

**Placing is a mutation.** `placePage { page, originPt? }` lowers to
`set(page, page.canvasOrigin)` (`Value::Lengths([x, y])`, `[]` = the default slot; a
non-finite or malformed value is refused). One undo step; a `batch` of them (rearranging
every board) is one too. It is a page-structure change: `mutationApplied`,
`undoApplied` and `redoApplied` carry `pageOriginsPt` beside `pageSizesPt`, the
`DocumentHandle` carries `pageOriginsPt`, and the pages collection carries
`canvasOriginPt`, `canvasPlaced` and `boundsPt` (the page's own `GeometricBounds`, so a
host resizing from any edge writes the edges it means). The page ORDER stays
`movePage`'s; a board is resized with `resizePage` (its content keeps its coordinates)
plus a `placePage` that moves its top-left by the same amount, so the content stays where
it is on the canvas. A placed page's `duplicatePage` copy lands one gap to its right.

**IDML has no free placement.** The export keeps the spreads and the page order as they
are — a board alone in its spread stays its own spread, pages sharing a spread stay
adjacent — and the measured loss list (`export_losses.rs`) names every placed page:
"IDML has no free page placement … opens in its default slot". InDesign stacks the
spreads; re-imported, the pages take their default slots.

**Editor.** The Artboard tool (`shift+o`, the one free key) selects, moves (snapping to
the other boards' edges, centres and default-gap neighbours), Alt-drag duplicates
(`duplicatePage` with the copy's `placePage` amended into the same step, ADR 1004),
resizes from eight handles and nudges; the Artboards panel lists, renames (page metadata
`x-paged:paged.artboard`, which travels with the page and through IDML as a Label),
reorders, deletes, sets size presets and orientation, rearranges every board into a grid,
and exports each board as a PNG or PDF named after it. Every editor surface that mapped a
point to a page reads the origins (`layoutPages(sizes, origins)`).

## Alternatives considered

- **Spread placement** (the spread's `ItemTransform` translation): InDesign ignores it
  for layout and every page of a spread would move together; a board is a page.
- **Materialising every origin on the first move**: it would make an unrelated insert or
  delete restack nothing, but every arranged document would store every page's origin and
  a newly inserted page would land on top of a moved one at the old stack's end anyway.
  The independent default slot keeps unplaced pages exactly where they always were.
- **A native artboard name field**: the page Label already round-trips through `.paged`,
  IDML and duplicate, and needs no wire or format change.

## Consequences

- Objects spanning pages keep working: each page draws its part of them, in spread space,
  wherever the page is placed.
- The protocol step was taken from a v76 base while another unpublished v77 was being
  integrated; `placePage` rides that v77 (governance rule 4) and the merge reconciles the
  number.
- A placed document opened by an older editor shows its pages stacked (the extra fields
  are additive and ignored).
