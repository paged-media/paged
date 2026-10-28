# ADR 346 — A page as layers

- **Status:** Accepted 2026-10-25; amended 2026-10-28 (C4, paragraph layers).
- **Scope:** `RenderSurface.layers`, `RenderLayersOptions`, `RenderedLayer` and `RenderedLayers`
  in `packages/plugin-api/src/host.ts`; `render.layers` in `packages/plugin-sdk/src/host-impl.ts`;
  the flag `render.layers@1`. Contract C2 of the PowerPoint parity program (slide ADR 711).
  Builds on [ADR 338](338-items-render-to-pixels.md).

## Context

A slide show composites a slide from layers: the static background, and every item that animates
as an image of its own it can move, fade and wipe. ADR 338 can already draw a page without some
items (`hideItems`) and one item alone, cropped to what it draws (`render.element`). A show needs
both at once, at one scale, so the layers fit back onto the background exactly, and decoded, so
they go to the GPU without a decode per frame.

## Decision

- **`host.render.layers(pageId, { items?, hideItems?, scale?, format?, marginPt? })`** answers
  the page's `background` (the page without `items` and `hideItems`) and one layer per item of
  `items` (the item alone on a transparent ground, cropped to what it draws within `marginPt` of
  its bounds), all at `scale` pixels per pt (72 dpi at 1).
- **Every layer says where it goes.** `region` is the page area it covers, in page pt; the
  background's is the whole page.
- **Formats.** `"bitmap"` (the default where `createImageBitmap` exists) answers decoded
  `ImageBitmap`s the caller owns; `"png"` PNG bytes; `"rgba"` straight-alpha pixels.
- **Built on the snapshot doors.** The background is one `render.snapshot` with the layered and
  hidden items left out; each item is one `render.element`. An item on another page, one that
  draws nothing, or every item on an engine without `render.snapshot@2` is left out of `items`;
  an unknown page answers `null`.
- **Drawn as the exports draw.** No layer carries the canvas's markers (the pink highlight behind
  text in a substitute face): the snapshot doors never ask the engine for them (engine ADR 205).
- **Static flag**, like `render.snapshot@2`: `render.layers@1`.

## Consequences

- paged.slide's show draws every slide from its background layer, prefetched a slide ahead;
  animated items become layers of their own with the animation wave.
- A layer per item costs a document build each (ADR 338's `only`). A batched engine request is a
  later optimisation behind its own flag.

## Amendment 2026-10-28 — paragraph layers (C4)

paged.slide builds a list paragraph by paragraph (slide ADR 714): each paragraph of a text frame
moves, fades and wipes on its own, so the show needs the frame's paragraphs as layers. The engine
can draw an item alone but not part of a story, so the cut is made from what it can say: where
each paragraph's lines are.

- **`paragraphs?: ElementId[]`** on `RenderLayersOptions`: text frames whose paragraphs come
  back in `RenderedLayers.paragraphs`, each a `RenderedLayer` with `paragraph` (its index in the
  story, 0-based) and `id` the frame. A frame named here is left out of the background.
- **How a paragraph is cut.** The frame's story is its `elementGeometry` row's `storyId`; each
  paragraph's content range goes to the engine's selection geometry (`requestSelectionGeometry`),
  whose line rectangles in this frame give the paragraph's band: from its first line to the next
  paragraph's first line (the first band from the frame's top, the last to its bottom, the frame's
  width; all grown by `marginPt`). The layer is the frame alone (`only`), clipped to the band and
  trimmed. An empty paragraph, or one the frame does not show, has no layer.
- **Static flag** `render.layers.paragraphs@1`.

Consequence: a glyph that reaches past its line box into the next paragraph's band (a deep
descender in tight leading) is cut at the band; the band boundary sits at the next paragraph's
line top, so this needs negative leading to show.
