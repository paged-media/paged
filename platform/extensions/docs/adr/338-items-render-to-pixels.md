# ADR 338 — Items render to pixels

- **Status:** Accepted 2026-10-24.
- **Scope:** `RenderSnapshotOptions`, `RenderedPage`, `RenderRect`, `RenderElementOptions`,
  `RenderedElement` and `RenderSurface.element` in `packages/plugin-api/src/host.ts`; the
  `render` doors in `packages/plugin-sdk/src/host-impl.ts`; `rasterizeElements`,
  `snapshotCropped` and `regionAround` in `packages/plugin-sdk/src/rasterize.ts`; the flag
  `render.snapshot@2`. The engine half is the additive `RequestSnapshot` fields on protocol 76
  (`engine/core/crates/paged-canvas/src/snapshot.rs`, `channel.rs`). Amends
  [ADR 323](323-page-navigation-and-page-images.md).

## Context

[ADR 323](323-page-navigation-and-page-images.md) gave plugins page images: a whole page as a
PNG, optionally with items left out. Several features need less than a page and more than a
PNG:

- **Rasterize** (Illustrator's Object ▸ Rasterize): the selection as one image, at a chosen
  resolution, on a transparent ground.
- **Image type layers** and **vector smart objects** in paged.image: a story or a draw item as
  pixels the image module composites.
- Anything that works on pixels (a filter, a trace, a hit mask) wants raw RGBA, not a PNG it
  must decode.

A plugin had no way to draw only some items, only a region, or without the paper. Drawing
them itself would be a second renderer that disagrees with the page.

## Decision

- **`host.render.snapshot` takes five more options** (`render.snapshot@2`):
  - `only` — draw nothing but these items, in their stacking order, on an otherwise empty page.
    A group draws its members, a container what is pasted into it, a masked item with its mask,
    a story (`{ kind: "storyRange" }`) every frame of its thread. The page's own layout is kept:
    a text wrap from an item left out still shapes the text.
  - `clip` — draw this region of the page (page pt; it may reach onto the pasteboard), grown
    outward to whole pixels. The reply's `region` is the region drawn, so the image maps onto
    the page exactly.
  - `dpi` — the resolution, 1 to 2400; it wins over `widthPx`, which becomes optional.
  - `format: "rgba"` — raw pixels in `rgba`: four bytes per pixel, rows top to bottom,
    straight (not premultiplied) alpha. A PNG of a transparent image is straight alpha too.
  - `background: "transparent"` — no paper under the content; and `trim`, which on a
    transparent ground crops the image to the pixels something was drawn on. That is the only
    way to learn what an item covers with its stroke and effects: no geometry read reports it.
- **`host.render.element(id, { dpi, format, background, marginPt })`** is the common case: one
  item, alone, cropped to what it draws within `marginPt` (default 72) of its geometric bounds.
  On paper the same pixel region is drawn again on white. `null` for an unknown item, one on
  the pasteboard, one that draws nothing.
- **`rasterizeElements(host, ids, { ppi })`** in plugin-sdk does the same for several items on
  one page and answers the image with its region and the `insertFrame` bounds that place it
  exactly. It uses only the public contract, so a community bundle uses it as a built-in does.
- **The engine draws these on the CPU rasterizer.** The worker's GPU snapshot path draws the
  page as the screen shows it; a request with any @2 option falls back to the CPU, which leaves
  straight alpha and an exact region. A region is drawn by moving the display list, not by
  cropping a page, so its cost follows the region.
- **The fields are additive on protocol 76: no bump.** An engine without them draws the whole
  page as a PNG. The SDK answers `null` wherever the reply cannot be what was asked (an `rgba`
  request without `rgba`, a `clip` or `trim` without `region`), never the wrong image. The flag
  is static, like `render.snapshot@1`.
- **A hidden frame draws no text.** `only` hides items by making them invisible in a copy of the
  scene. The renderer used to lay a hidden text frame's text out on page 0 and paint it there;
  it now lays it out in the frame, so the thread flows as InDesign flows it, and drops it.

## Consequences

- paged.draw's Object ▸ Rasterize… replaces the selection with one image frame in one undo
  step (`commands/rasterize.ts`). The image lands at the front of its layer, not at the
  topmost original's depth.
- paged.image can build type layers and vector smart objects on `rasterizeElements` (plan
  WP5.10, WP5.14).
- An `rgba` image crosses the worker channel as a JSON number array, as a PNG does. A binary
  lane for snapshot bytes is a later optimisation behind its own flag.
- `only` builds a copy of the document with the other items hidden, so its cost is a document
  build. The emit caches key on geometry, not visibility, so they cannot be reused for it
  safely.

## Related

- [ADR 323](323-page-navigation-and-page-images.md) — page images, `render.snapshot@1`.
- Core [ADR 205](../../../../engine/core/docs/adr/205-a-snapshot-is-drawn-as-the-exports-draw-it.md) — a snapshot is drawn as the exports draw it.
