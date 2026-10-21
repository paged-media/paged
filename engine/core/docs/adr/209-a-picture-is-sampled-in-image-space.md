# ADR 209 — A picture is sampled in image space, not where the atlas put it

- **Status:** Accepted 2026-10-21.
- **Scope:** `vendor/vello_shaders` (vello_shaders 0.11.0 with one change to
  `shader/fine.wgsl`) and the `[patch.crates-io]` entry that selects it
  (`engine/core/Cargo.toml`); the regression test
  `a_photo_samples_the_same_wherever_the_atlas_places_it`
  (`crates/paged-gpu/src/vello_rs.rs`). No model, wire, protocol or API change. Follows
  [ADR 188](188-snapshots-draw-on-the-worker-gpu.md).

## Context

Since ADR 188 a snapshot is drawn on the render worker's WebGPU device with the presenter's own
Vello renderer, the one that draws the screen. The same page of the same model, snapshotted twice
fifteen seconds apart, came back with 0.14 % of its pixels one colour level apart, in placed
photographs only. Stopping the camera (no screen draws in between) made it stable, and so did
snapshotting on the CPU rasterizer. The showcase's IDML parity gate compares two books rendered
minutes apart, so it reported photo pages at 0.07–0.13 % and was pinned to the CPU rasterizer.

The cause is Vello's image atlas and one line of its fine shader:

- A Vello `Renderer` keeps every placed picture resident in one atlas texture across renders
  (`vello_encoding::ImageCache`). Where a picture lands depends on what the renderer drew before:
  the screen's pictures, the atlas keep-alive image (`render_scene`), growth, which repacks every
  resident image, and eviction. On the worker the snapshot shares the renderer with the screen,
  so the camera's history decides where a snapshot's photographs sit.
- The fine shader's bilinear path computed the sample position as
  `local + atlas_offset - 0.5` in f32 and took the weights from `fract` of that sum
  (`IMAGE_QUALITY_MEDIUM`, peniko's default; the nearest and bicubic paths add the offset the same
  way). An f32 near 4,000 keeps 11 fraction bits; near 500 it keeps 14. The farther from the atlas
  origin a picture lies, the coarser its bilinear weights, and a weight off by 2⁻¹¹ moves a channel
  across a rounding boundary often enough to be seen: ±1 level, photographs only, more often the
  larger the offset.

Reproduced natively (Metal) with the regression test's page: a 700 × 500 photograph at a
non-integer scale, drawn by a fresh renderer and by one that drew something else first.

| Drawn first                      | Bytes differing (of 1,525,636) | Largest difference |
| -------------------------------- | -----------------------------: | -----------------: |
| an image-free page (keep-alive)  |                              1 |                  1 |
| one 2000 × 1900 photograph       |                          1,203 |                  1 |
| three                            |                          1,875 |                  1 |
| nine                             |                          2,492 |                  1 |
| fourteen (8192² atlas)           |                          4,000 |                  1 |

## Decision

1. **Sample in image space.** The patched `fine.wgsl` clamps, floors and takes `fract` of the
   image-local position, and adds the atlas offset, an integer, to the integer texel index only.
   The arithmetic is exact, so where the atlas puts a picture cannot change a sample. The
   nearest, bilinear and bicubic paths are all changed; their results are otherwise the same
   (the clamps are the same rectangle, expressed in image space).
2. **Vendor vello_shaders rather than give the snapshot its own renderer.** A second persistent
   renderer would still carry its own history (one snapshot's placement depends on the snapshots
   before it), and a fresh renderer per snapshot pays shader compilation and a new atlas for
   every thumbnail, eyedropper sample and page export. Fixing the sampling costs nothing at run
   time and also makes the screen, the native parity lane and every other Vello render
   placement-independent. The patch is the crate as published plus that one shader change;
   `[workspace] exclude` keeps it out of the workspace's lints and tests.
3. **Remove the patch when upstream samples in image space**: drop the `[patch.crates-io]`
   entry and `vendor/vello_shaders`, re-lock, and keep the regression test.

## Evidence

- `a_photo_samples_the_same_wherever_the_atlas_places_it` draws the photo page alone, then on
  renderers that first drew an image-free page or three large photographs, and requires byte
  equality, then draws the history and the page once more on the same renderer. Upstream shader:
  1 and 1,875 differing bytes. Patched: 0 and 0, on Metal and on lavapipe (`core / gpu`).
- **Parity lane** (`parity-diff.sh`, 144 dpi, Metal): 104 of 104 fixtures within budget before
  and after. 625 of 666 pages measure the same mean ΔE; the other 41 moved by at most 3 × 10⁻⁶.
- **Cost.** No extra pass, texture, buffer or renderer: GPU memory is unchanged, and so is the
  work per snapshot (the regression test's photo page renders in 1.4 ms on Metal). Per sample
  the shader does the same clamp, floor and `fract` plus at most four integer-valued adds. The
  alternative of item 2 measured 12 ms for each `Renderer::new` on the same machine, with the
  pipelines already in the driver's cache, before any picture is uploaded again. The wasm grows
  by the length of the edited WGSL text (see the commit for the canvas-wasm size).

## Consequences

- A GPU snapshot is a function of the document state, the page, the size and the options; the
  screen's history no longer reaches its pixels. The same holds for two renders of one page on
  the screen and for the native Vello lane.
- One residual history dependence remains, shared with the screen: when the pictures still in use
  by the last frame plus the snapshot's pictures exceed the largest atlas (8192², 256 MB of
  RGBA), Vello skips the pictures that do not fit. A picture larger than 8192 px on a side is
  skipped on every render, history or not.
- The showcase's IDML parity gate stays on the CPU rasterizer until a WebGPU run of it confirms
  the GPU path bit-stable across both books; it compares the IDML, not the rasterizer.

## Related

- [ADR 188](188-snapshots-draw-on-the-worker-gpu.md): snapshots draw on the worker's GPU.
- [ADR 146](146-the-gpu-lane-is-held-to-the-cpu-lane.md): the parity lane and its budgets.
