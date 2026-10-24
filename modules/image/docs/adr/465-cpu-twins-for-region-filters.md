# ADR 465 — Where no GPU exists, a region filter runs on shipped CPU twins

- **Status:** Accepted, 2026-10-23. An exception to [ADR 450](450-gpu-only-kernels.md), which it amends.
  Amended 2026-10-23: a mask given as data (below); the same day, fill rules and polygon ops,
  and the selection of a frame that is not the open image.
- **Scope:** `image-kernels` (feature `cpu`, `src/cpu.rs`), `image-js/src/region_filter.rs` and the
  chain it shares with the GPU (`ingest.rs`, `adjust_stages`), the wasm export
  `filter_region_rgba8`, the object model's layer `filter` row and the typed command
  `filterRegion` (`glue/src/object-model/`), `image-conformance/tests/it/cpu_twins.rs`, and the
  dependency guard in `.github/workflows/image-ci.yml`

## Context

ADR 450 ships no CPU path for a kernel: without a GPU device every call that dispatches one
returns an error. The object model made most of an image editable without a device anyway: a
layer stack is read and written as its stored manifest, canvas operations move pixels without
computing any, and a stack whose composite would need a kernel is stored `pending` until a GPU
realm bakes it.

A filter is different: its result is new pixels, and nothing can store it `pending` the way a
composite is, because the filtered pixels are the layer itself. The Node CLI (`paged-node`) and
the SDK's headless host have no `navigator.gpu`, so a script or a CLI call could not blur,
sharpen or adjust part of an image at all. The composable-editor plan names this gap for the
module: "filters with a region".

The scalar twins needed already exist as test references for every kernel of the adjustment
chain ([ADR 451](451-one-kernel-definition.md)), and the conformance suite already measures the
shader against them ([ADR 453](453-tolerance-not-golden-bytes.md)).

## Decision

The scalar twins of the kernels the adjustment chain dispatches ship as a CPU path, used only
where no GPU device exists.

- **Which kernels.** The nineteen the chain can dispatch, listed in `image_kernels::cpu::CPU_KERNELS`:
  `adjust.exposure`, `white_balance`, `levels`, `levels_rgb`, `brightness_contrast`,
  `color_balance`, `photo_filter`, `channel_mixer`, `vibrance`, `saturation`, `black_white`,
  `posterize`, `threshold`, `hue_rotate`, `hue_saturation` and `invert_rgb`, and
  `conv.gaussian_h`, `conv.gaussian_v` and `conv.unsharp`. Blur and sharpen are among them; the
  curves pass already ran on the CPU. No other kernel gets a twin through this record: a kernel
  joins the list only with its twin and its test.
- **Where they live.** `image-kernels` gains a feature `cpu`, separate from `reference`. It
  compiles `src/cpu.rs` (handwritten twins of the module kernels, each mirroring its WGSL term for
  term), the `Px` pixel type and the `kernel_family!` twin of `adjust.invert_rgb`. `image-js`
  turns `cpu` on. The `reference` feature stays test-only, enabled only by `image-conformance`.
- **One chain.** The chain's stages and their order are listed once (`adjust_stages`). The GPU
  pipeline and the CPU path both consume that list, so they cannot run different chains.
- **The CPU path models the GPU path.** Input is bridged to f16 as the pipeline does (`v / 255`),
  every stage's output is stored as f16, every stage is masked by the region (`mix(a, result, m)`
  with `m` 1 inside and 0 outside), a window repeats the image's edge pixel, and the result
  leaves through the sink's round.
- **When it runs.** `filter_region_rgba8` uses the GPU whenever `init_gpu` succeeded in the realm,
  and the CPU twins only when it did not. In the editor, where the session requests a device, the
  GPU stays the path. No other entry point reaches the twins: an adjustment preview, an Apply, the
  layer fold and every other kernel still return an error without a device.
- **Tolerance.** A twin is held to the same tolerance as the GPU: its kernel's declared
  `gpu_tolerance` against the test-only reference, over the conformance stimulus, in every lane
  (no device needed), and against the shader itself on the GPU lanes. The two region-filter
  paths must agree within one 8-bit level per channel on the GPU lanes.
- **The guard.** The CI guard on `image-js`'s wasm32 tree still fails on `image-conformance` and
  `proptest`, and now also fails when `image-kernels`'s `reference` feature is reached from
  `image-js`.

## Evidence

- `image-kernels/Cargo.toml` — the `cpu` feature beside `reference`; `image-kernels/src/lib.rs`,
  `src/family.rs`, `src/reference_prelude.rs` — what each feature compiles
- `image-kernels/src/cpu.rs` — the twins and `CPU_KERNELS`
- `image-js/src/ingest.rs` (`AdjustStage`, `adjust_stages`, `build_adjust_chain`) — the one chain
- `image-js/src/region_filter.rs` — the CPU path and the GPU path over a region
- `image-js/src/lib.rs` (`filter_region_rgba8`) — the choice of path
- `glue/src/object-model/image-objects.ts` (`filterRegion`), `contribute.ts` — the layer `filter`
  row and the typed command
- `image-conformance/tests/it/cpu_twins.rs` — the tolerance tests
- `glue/test/region-filter.spec.ts`, `apps/cli/test/cli-image.spec.ts` — the filter headless and
  through `paged-node invoke`
- `.github/workflows/image-ci.yml` — the guard

## Alternatives considered

- **Store the filter `pending`** and run it when a GPU realm opens the frame. The layer's pixels
  would be wrong in every export made before that, and a script reading the layer back would not
  get what it wrote.
- **A software GPU adapter in Node.** It would keep one execution path, but Node has no WebGPU in
  the realm the plugin runs in, and shipping an adapter means shipping a driver.
- **Move the test references into the shipped crate** and test the GPU against them only. Then
  the CPU path and its reference would be one function, and nothing would hold the shipped code
  to the reference by test; the references stay test-only and independent.

## Consequences

A script, the SDK's headless host and `paged-node invoke` can filter a region of a pixel layer:
`filterRegion { layer, params, region? }`, where `params` are adjustment-layer paths. The write
is one undo step; a one-layer stack bakes into the frame at once.

There are now two shipped implementations of nineteen kernels, the WGSL and the CPU twin, and a
third, the test reference. The tests above bind them; a change to a covered kernel's WGSL has
to change its twin too, or the GPU lanes fail.

The CPU path is slower than the GPU path, roughly linearly in the region's area and, for blur,
in its radius. It runs on the region only, grown by the widest window.

The selection is a session concept; headless there is none, so a headless region was a rectangle
and filtering within a selection stayed the editor's Apply. The amendment below lifts that.

## Amendment, 2026-10-23 — a mask given as data

`filterRegion` takes a selection as data, so a script and the CLI can filter within one, and the
editor's live selection:

- **`mask { polygons?, ops?, fillRule?, alpha?, feather? }`.** `polygons` are closed polygons of
  `[x, y]` image pixels, anti-aliased as the lasso is (four sub-scanlines a row, analytic
  coverage in x). Without `fillRule` each is filled even–odd on its own
  (`SelectionCoverage::rasterize_polygon`) and they are unioned, so overlapping polygons never
  cut each other. `fillRule: "evenodd" | "nonzero"` fills the polygons together as one path
  (`region_filter::rasterize_polygons`, crossings carrying their winding direction): an inner
  polygon cuts a hole, under non-zero only when wound the other way. `ops`, one
  `"add" | "subtract" | "intersect"` per polygon, splits them: the add polygons are the shape
  (filled under the rule), then each subtract polygon cuts it (`shape · (1 − p)`) and each
  intersect polygon keeps the overlap (`min`), in order, each filled alone. Without an add
  polygon the shape starts as the whole image, as a mask without polygons does, so a lone
  subtract polygon means "all but this". A wrong number of ops, an unknown op or rule, and a
  rule without polygons are refused. `alpha` is an 8-bit coverage, one byte per
  canvas pixel (or an encoded image of the canvas size, its luminance times its alpha),
  intersected; `feather` is a Gaussian on the mask (σ ≤ 250 px). The result is clipped hard to
  `region`. Rasterising is mask preparation, the CPU work ADR 450 allows; it happens once, in
  Rust (`region_filter::mask_coverage`), and both paths consume the same coverage.
- **`selection: true`** reads the editor session's selection of that frame as coverage bytes
  (`ImageSession.liveSelection`) and intersects it with any `mask`. The selection is session
  state: one coverage, at the resolution of the image open in the session, never written to the
  document. While the frame's image is open, its live selection counts. When another image
  opens, the session keeps the closing frame's selection (the last four frames, dropped when
  another document opens, since frame ids are per document), so a script can still filter
  within it. When that frame's image opens again, the kept selection is set back into the
  engine (`selection_set_coverage`: coverage bytes of the bound image's size, folded under a
  combine mode, `replace` making it exactly those bytes) and is the live selection again, as if
  the frame had never closed; the session then drops its copy. A frame that now holds the same
  image at another size gets it resampled as below; another crop of the image drops it, as a
  crop drops a live selection. The coverage is
  at the size of the image it was made on: when the object model's canvas is the same image at
  another resolution (the aspect agrees within a pixel) it is resampled bilinearly at pixel
  centres, as resizing an image resizes its selection; another aspect is another crop, where
  the selection's place on the canvas is not known, and is refused. A frame with no selection
  (headless, never selected in this session, nothing selected) is refused with the reason;
  "no selection" does not silently mean everything here.
- **One mask on both paths.** The GPU path gives the coverage to the pipeline as its selection;
  the CPU path applies it per stage as the ABI does, `mix(a, result, m)` with `m` the coverage
  byte lowered to f16 as `mask_window_f16` lowers it, the Gaussian passes and the unsharp
  included, and the curves table blends by the same coverage. Partial coverage blends filtered
  and original pixels. Neither path writes a pixel whose coverage is 0. The paths agree within
  one 8-bit level under a mask too.
- **Refusals.** A polygon of fewer than three points, an alpha of the wrong size, a feather out
  of range and a mask that covers no pixel are refused with the reason.

Evidence: `image-js/src/region_filter.rs` (`RegionMask`, `mask_coverage`, `filter_masked_cpu`,
`filter_masked_gpu`), `image-js/src/lib.rs` (`filter_region_rgba8`'s mask arguments),
`glue/src/object-model/image-objects.ts` (`FILTER_FIELDS`, the mask and selection checks),
`image-js/src/selection.rs` (`SessionSelection::apply_coverage`, behind `selection_set_coverage`),
`glue/src/session.ts` (`liveSelection`, the kept selections, `restoreSelection`), `glue/src/object-model/image-objects.ts`
(`coverageAt`); tests in `image-conformance/tests/it/cpu_twins.rs` (the rasteriser, the fill
rules and ops, the CPU path under a mask, the two paths under a mask),
`glue/test/region-filter.spec.ts` (a polygon and an alpha mask headless, fill rules and ops, the
selection source, a resampled and a refused selection), `glue/test/selection.spec.ts` (the
selection kept for a closed frame, set back when it reopens, resampled or dropped), the
`selection.rs` unit test of coverage bytes as the selection, `apps/cli/test/cli-image.spec.ts` (a polygon, a hole by fill
rule and by op, an alpha mask from `@path`, `selection: true` refused), and
`apps/editor/apps/canvas/tests/plugin-surface/image-filter-selection.spec.ts` (a marquee selection
in the running editor: only its pixels change, one undo restores them).

## Related

- [ADR 450](450-gpu-only-kernels.md) — the rule this is an exception to
- [ADR 451](451-one-kernel-definition.md) — where the twins come from
- [ADR 453](453-tolerance-not-golden-bytes.md) — the tolerance they are held to
