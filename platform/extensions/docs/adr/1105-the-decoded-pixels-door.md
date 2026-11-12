# ADR 1105 — The decoded-pixels door: `host.assets.decodeImage`

- **Status:** Accepted 2026-11-11.
- **Scope:** `AssetSurface.decodeImage` and `DecodedImage` in `packages/plugin-api/src/assets.ts`;
  the optional `PagedEditor.decodeImage` in `packages/plugin-api/src/editor.ts`; the SDK's
  `assets.decodeImage` and the flag `assets.decodeImage@1` in `packages/plugin-sdk/src/host-impl.ts`
  and the headless harness's engine lane. The engine half is `paged_canvas::decode_image_rgba8`
  and canvas-wasm's `decodeImageDirect` (engine/core); the editor half is the worker's
  `decodeImage` binary op and `CanvasClient.decodeImageBinary` (apps/editor).

## Context

paged.draw's Image Trace needs a placed picture's pixels. `host.assets.getPlacedImage` serves the
original encoded file, so draw decoded it with the browser's `createImageBitmap` and
`OffscreenCanvas` (`io/raster-decode.ts`): a second decoder beside the engine's, which refused what
the browser cannot read (a PSD, a CMYK TIFF), saw colours the page does not show (no colour
management of the placed file) and did not exist outside a browser realm (the headless harness,
Node). The engine already decodes every format it places (`paged-raster`), the way the page shows
it. paged.image has its own Rust decoder, but it is that module's session, not a door another
bundle may call.

## Decision

- **One decoder, the engine's, behind an asset door.** `host.assets.decodeImage(bytes, {
  maxDimension? })` answers `{ width, height, data }` (straight-alpha 8-bit sRGB) or `null`. It
  decodes as the renderer decodes a placed picture (`paged_raster::decode_rgba8`: colour converted
  to sRGB, a PSD's composite, a TIFF's first page) and shrinks so neither side exceeds
  `maxDimension` (a format the decoder reads at full size is resampled, premultiplied bilinear). A
  pure read with no capability gate: the bundle hands in bytes it already holds.
- **A binary lane, no protocol bump.** The editor's worker serves it as a direct op over the binary
  doors of protocol 66 (`decodeImageDirect`, the pixels transferred back); an older canvas-wasm
  answers that the door is missing and the SDK returns `null`. The flag `assets.decodeImage@1` is
  true when the editor offers `PagedEditor.decodeImage`; the headless harness offers it from its
  engine too.
- **draw's trace decodes through it.** `decodeRasterBytes(host, bytes, limits, natural?)` asks the
  engine for the size the tracer's caps allow (one decode when the natural size is known, as for a
  placed image); the browser path, its realm checks and the test realm that faked
  `createImageBitmap` are gone (the no-engine unit rigs hand the host a PNG decoder as their
  `decodeImage`).

## Consequences

- Image Trace reads a PSD, a CMYK TIFF, WebP and every other placed format, in the colours the page
  shows, and runs headlessly on the real engine.
- A host without the door refuses the trace with a sentence naming it, as before.
- Contract canary `0.74.3-canary.89` (with ADR 1104).
