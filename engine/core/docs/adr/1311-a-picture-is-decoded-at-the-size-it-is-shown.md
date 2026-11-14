# ADR 1311 — A picture is decoded at the size it is shown, from one store with a budget

- **Status:** Accepted 2026-11-14.
- **Scope:** `paged-gpu` (`image_store.rs`: the decoded-picture store, its levels, budget and
  statistics; `vcpu.rs` and `vello_rs.rs` draw placed pictures from it; `surface.rs` and
  `vello_rs::screen_page_scene` take the scale a page scene's pictures are decoded for),
  `paged-raster` (`decode_rgba8_at_with` decodes a large gray or YCbCr JPEG at its DCT scale),
  `paged-canvas` (`decoded_image_stats`, `clear_decoded_images`, `set_decoded_image_budget`;
  `decode_image_rgba8` decodes a large JPEG once), `paged-canvas-wasm` (`perfCounters` reports
  the store, a replaced document's pictures are dropped, the GPU scene of a page with pictures is
  keyed by the scale octave, `SceneView::Pictures`), the editor's worker (the `worker.caches`
  journal entry). Closes the editor's inventory exception `EXC-003` (editor ADR 1232), the
  decoded-image half of UX audit F-54 and the decoded-asset part of UXI-PRF-004.

## Context

The live canvas build in the browser keeps a placed picture lazy: the build records the size it
is placed at (a JPEG over 4 096 px at its DCT-reduced size) and its encoded bytes, and the
rasterizer decodes it when it draws (`peek_image_lazy`). Three things were wrong with how it was
drawn:

1. **Every draw decoded at full size.** The CPU lane (`vcpu.rs`, the editor's tiles and every
   page thumbnail) decoded each picture of a page on each render, kept nothing, and decoded it at
   the build's size: a page thumbnail 256 px wide decoded a 4 096 px photograph to 64 MB of
   pixels to draw it 60 px wide. `paged_raster::decode_rgba8_at_with` read a JPEG at full size
   even when asked for a smaller one, then resampled. On the large templates this was most of
   the time to the first visible page (editor ADR 1232: 8.6 s on the 54 MB template).
2. **No budget held what was kept.** The GPU lane kept its decodes in a 256 MiB LRU of its own
   (`DECODED_IMAGES`), at full size; the CPU lane kept none; the two never shared a decode, so a
   GPU session decoded every picture twice (its scenes and its thumbnails).
3. **Nothing reported it.** No statistic said how many bytes of decoded pixels a worker held.

## Decision

**One decoded-picture store per thread (`paged_gpu::image_store`).** Both lanes take a placed
picture's pixels from it. An entry is a picture at a *level*: level `k` is the picture at
`1 / 2^k` of its recorded size on both axes. A draw takes the deepest level that still has at
least as many pixels as the draw covers on the device on both axes (`level_for`, from the
picture's unit square mapped to device pixels), so a thumbnail takes a small level and a page at
400 % takes level 0. The store keeps the CPU lane's premultiplied pixmap; the GPU lane's image
shares its bytes (one decode, one copy, one blob id, so Vello uploads it once).

**Full resolution only where it is shown or kept.** A picture the build decoded itself — an
export build, the native command line, the fidelity gates — is always drawn at level 0: exports
and the fidelity references keep every pixel. A PDF export decodes from the encoded bytes as
before. A screen draw at a scale that needs every pixel gets level 0.

**A JPEG is decoded at the level, not resampled from full size.** `decode_rgba8_at_with` decodes
a gray or YCbCr JPEG at least twice the target on both axes at its DCT scale (an eighth, a
quarter or a half: the decoder skips the coefficients a smaller picture does not need) and
resamples from there; CMYK and YCCK JPEGs keep the decode that converts their inks. Other
formats decode as before (a TIFF or PSD shrinks while it decodes) and are resampled with the
filter's support scaled to the reduction. The module door `decodeImageDirect` decodes a large
JPEG once, at the size asked (it decoded it twice).

**An explicit byte budget, the oldest draw first.** The store holds at most its budget of pixel
bytes, 256 MiB by default (`DEFAULT_BUDGET_BYTES`, `set_budget`); past it the entries drawn
longest ago go. A decode larger than the whole budget is drawn and not kept. An entry holds a
clone of its picture, so the buffer whose address keys it cannot be freed and reused by another
picture while it exists. A replaced document's entries are dropped with it.

**GPU page scenes follow the octave.** A page scene is built in page space and presented at any
zoom; a page with placed pictures is cached per scale octave (`SceneView::Pictures`), its
pictures decoded for the octave's scale, so a zoom inside an octave keeps the scene and one past
it rebuilds it with the level it needs. A page without pictures keeps one scene at any zoom.

**Reported through the existing paths.** `perfCounters` (the worker's work counters) gains the
store's `imageStoreBytes`, `imageStorePeakBytes`, `imageStoreBudget`, `imageStoreEntries`,
`imageStoreDecodes`, `imageStoreHits` and `imageStoreEvictions`; every journal drain records
them as `worker.caches`, with the CPU tile bytes and the GPU scene count; the editor's
performance suite reports them.

## Consequences

- The live model's own decode cache (`image_decode_cache`) holds, in the browser, the encoded
  bytes and recorded sizes of the document's pictures (the document's own size, released with
  it) and the filter-stack twins of ADR 1037 (at most eight per picture); every decoded pixel of
  the screen is in the store, within its budget.
- Measured before and after in the editor's performance suite (editor
  `docs/reference/performance.md`): on the 54 MB template, whose spreads embed thirty RGB JPEGs,
  the first visible page came 4.4 s after the layout instead of 6.3 s (most of what is left is
  the first GPU present of a page of nineteen photographs), with 36 MB of decoded pictures held
  when opened and 62 MB after a minute of paging and zooming, within the 256 MiB budget.
- A screen draw of a lazy picture below its recorded size is a resampled level, as the GPU had
  it sampled before; exports are unchanged.
