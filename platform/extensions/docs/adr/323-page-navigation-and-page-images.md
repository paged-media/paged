# ADR 323 — Page navigation and page images

- **Status:** Accepted, 2026-10-06.
- **Scope:** `ViewportSurface.goToPage`, `activePage` and `onDidChangeActivePage`;
  `BundleHost.render` (`RenderSurface`, `RenderSnapshotOptions`, `RenderedPage`); the `pages`
  option (`PagesBackend`) in `packages/plugin-sdk/src/host-impl.ts`; the flags
  `viewport.pages@1` and `render.snapshot@1`.

## Context

A presentation plugin shows a slide sorter, a notes view and a slideshow over the document's
pages. Three things it needs had no door:

- **Going to a page.** The editor moves its camera to a page for its own thumbnail rail and
  navigator. A plugin could not ask for that.
- **Knowing the page the user is on, and when it changes.** `host.document.meta().activePage`
  answers on request. A sorter that highlights the current slide would have to poll it.
- **Page images.** Thumbnails and slideshow frames are images of whole pages, and a build step
  is a page with some items not yet shown. The engine renders a page to a PNG
  (`requestSnapshot`, with `hideItems` since protocol 70), but only through the
  `host.editor.client` escape hatch.

## Decision

- **`host.viewport.goToPage(pageId, { fit })`** asks the editor to bring a page into view,
  fitted to the page or to its width. It answers `false` for an unknown page.
  **`activePage()`** answers synchronously and **`onDidChangeActivePage`** fires on every
  change. All three are backed by a `PagesBackend` the editor injects, because the camera and
  the page layout are the editor's. Without one they answer `false`, `null` and never, and
  `viewport.pages@1` is false.
- **`host.render.snapshot(pageId, { widthPx, hideItems })`** returns the page as a PNG with its
  size and layout generation, or `null` for an unknown page. It goes straight to the engine,
  because rendering is the engine's, and is gated like the other document reads. The width is
  a request: the engine renders at a resolution derived from it, so the image can be a pixel
  off, and the reply carries the exact size. `hideItems` affects that image only. The document
  is not changed and no undo step is recorded.

## Consequences

- A slideshow can prefetch every frame of a slide (one per build step) without touching the
  document.
- A frame is PNG bytes, so a plugin decodes it (`createImageBitmap`) before drawing. A
  transfer-friendly raw form can be added later behind its own flag if decoding shows up in
  profiles.
- Fullscreen presenting and a presenter window are not part of this. They need a shell
  surface, which is a separate decision.
