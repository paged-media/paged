# ADR 346 — A page as layers

- **Status:** Accepted 2026-10-25.
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
