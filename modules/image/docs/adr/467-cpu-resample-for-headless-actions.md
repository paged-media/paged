# ADR 467 — The CPU resample is a supported backend for headless and batch actions

- **Status:** Accepted 2026-10-25. A second exception to [ADR 450](450-gpu-only-kernels.md),
  beside [ADR 465](465-cpu-twins-for-region-filters.md). Settles the open point of
  [PM-0015](../../../../docs/adr/PM-0015-data-and-actions-are-platform-layers.md) on headless
  image actions.
- **Scope:** the engine crate `paged-resample` (`engine/core/crates/paged-resample`), the wasm
  exports `resize_image_cpu` and `straighten_crop_image_cpu` (`image-js/src/lib.rs`), the engine
  facade's `resizeCpu` / `straightenCropCpu` (`glue/src/engine.ts`) and the actions
  `media.paged.image/resize`, `/fit` and `/crop`'s `angle` (`glue/src/actions.ts`)

## Context

The module's actions (extensions ADR 344, PM-0015) are pure steps over an encoded picture that
another bundle runs alone or chained, data's asset columns among them (data ADR 563). They run in
the editor, in a worker and on the SDK's headless host, and an action may not depend on whether
the realm happens to have a GPU device: the same input has to give the same output, or the
action cache key (core ADR 1015) names two results.

The actions that shipped first were the ones the CPU lane could already do: decode, the
axis-aligned crop, the adjustment chain on the CPU twins (ADR 465), encode. A resize, a fit to a
box and a straightened crop are resamples, and the resample kernels (`resample.*`,
`geom.rotate_bilinear`) are GPU-only by ADR 450: `resize_image` and a non-zero angle in
`straighten_crop_image` refuse without `init_gpu`. So the three were held back, and PM-0015 left
open whether headless image actions need a GPU-capable host or a CPU backend.

A GPU-capable host is not available where the actions are needed most: Node (the CLI, the
server, batch jobs) has no WebGPU in the realm the bundle runs in, and shipping an adapter means
shipping a driver (the alternative ADR 465 already rejected).

## Decision

**A CPU resample is a supported backend: the backend of the headless and batch actions.** The
GPU path stays the editor's interactive one; the two may differ by the tolerance below.

- **Where it lives.** A leaf engine crate, `paged-resample`: pure Rust, no dependencies,
  wasm-safe, under core-ci's leaf-crate guard beside `paged-pixel` and `paged-psd`. It is not in
  `paged-raster` (whose codec dependencies the module's wasm does not carry) and not a kernel
  twin in `image-kernels` (it is not a term-for-term mirror of a WGSL kernel, and it is meant for
  the engine's own raster work too, PM-0014). A later `paged-kernels` (core ADR 1013) may take it
  in; the decision here is the backend, not the crate's final home.
- **What it does.**
  - `resize_rgba8` — separable, Lanczos-3 (the default) or bilinear. The coordinate model is the
    GPU kernels': output pixel `o` samples `s = (o + 0.5) · src/dst − 0.5`, a tap weighs
    `k((s − i) / f)` with the filter scale `f = max(src/dst, 1)`, so a reduction widens the
    filter and averages instead of aliasing; taps clamp to the edge and are normalised. Unlike
    the GPU kernels, `f` is not capped at 16. An axis whose size does not change is copied.
  - `rotate_crop_rgba8` — the straightened crop: each output pixel's centre mapped back through
    the turn about the crop rectangle's centre and sampled bilinearly, clamp-to-edge, as
    `geom.rotate_bilinear` does; a quarter turn is exact (a pixel permutation), 0° the plain
    crop.
  - Both filter **premultiplied** (`c · a / 255`), so a colour beside a transparent pixel keeps
    its hue, and are deterministic: single-threaded, a fixed summation order, f32 accumulation
    over f64 weights.
- **Where it runs.** `resize_image_cpu` and `straighten_crop_image_cpu`, new wasm exports. The
  actions call them in every realm, with or without a device, so an action's result does not
  depend on the realm. `resize_image` and `straighten_crop_image` are unchanged: the editor's
  resize dialog and crop tool stay on the GPU kernels and still refuse without a device.
- **The actions.** `resize` (`width` and/or `height`, one alone keeping the aspect, or `scale`;
  `filter` `"lanczos3"` | `"bilinear"`), `fit` (a `width` × `height` box, `mode` `"contain"` |
  `"cover"` with the overflow cut centred, `enlarge`, `filter`) and `crop`'s `angle` (degrees,
  clockwise: the content inside the rectangle turned by `angle` lands upright). An edge is at
  most 16384 pixels and a result at most 2²⁸ pixels; beyond that the action refuses.
- **Tolerance.** On an opaque picture the CPU and GPU backends agree within **one 8-bit level
  per channel** (the GPU carries f16 working values, the CPU f32; both sample the same points),
  held on the GPU lanes by `image-conformance/tests/it/cpu_resample.rs` for Lanczos-3 resizes
  from a 12× reduction to a 2.3× enlargement and for straightened crops at 4.5°, −12° and 33.3°.
  Measured on a local Metal adapter (2026-10-25): a worst difference of exactly 1 level in every
  case, most pixels equal. Where translucent pixels are filtered the backends differ by design,
  since the GPU kernels filter straight values and the CPU premultiplied ones: on that test's
  translucent stimulus (a saw-tooth alpha) the worst difference is up to 255 levels on nearly
  transparent output pixels, whose straight colour the GPU takes from invisible neighbours, and
  up to 47 levels on opaque output pixels whose footprint holds translucent ones. That
  difference is printed there, not bounded. Past a 16× reduction the GPU kernels alias and the
  CPU resample does not.

## Evidence

- `engine/core/crates/paged-resample/src/lib.rs` — the resampler and its unit tests (identity,
  constant colour, hand-computed bilinear values, Lanczos-3 values evaluated independently, a
  reduction of a checkerboard, premultiplied alpha, the quarter turn as a transpose of the
  mirrored picture, refusals)
- `image-js/src/lib.rs` — `resize_image_cpu`, `straighten_crop_image_cpu`
- `image-conformance/tests/it/cpu_resample.rs` — the two backends against each other
- `glue/test/actions.spec.ts` — resize, fit and the straightened crop on the shared registry,
  headless, decoded again by the real engine; a chain of `fit` → `greyscale` → JPEG
- `.github/workflows/core-ci.yml` — the leaf-crate guard

## Alternatives considered

- **Fall back inside `resize_image`** when no device exists. The editor and a headless run
  would then take different paths for one action, and the result would depend on the realm;
  the editor's surfaces that report GPU-only state honestly would change underneath them too.
- **A CPU twin of the resample kernels in `image-kernels`** (the ADR 465 route): a twin mirrors
  its WGSL, including the f16 working values, the 16× cap and straight alpha. The actions want
  the better resample, not the mirror, and the engine wants it outside the module.
- **A permissive crate** (`fast_image_resize` and the like). It would bring SIMD code paths whose
  results differ between targets, and the resampler is small enough to own and test.
- **Wait for a GPU-capable headless host.** Node has none in the bundle's realm; the actions
  that need a resample are exactly the batch ones.

## Consequences

- A data asset column can resize, fit and straighten pictures headless, on the CLI and the
  server, and the cache key names one result everywhere.
- There are two shipped resamplers, the WGSL kernels and `paged-resample`, with different alpha
  handling. A pixel the editor resizes and the same pixel an action resizes may differ by the
  tolerance above; nothing compares them byte for byte.
- The CPU resample costs time linear in the output and in the filter's reach (`support · f` taps
  a side, so a large reduction costs more per output pixel than an enlargement). Its working
  memory is the output plus a window of horizontally filtered rows.

## Related

- [ADR 450](450-gpu-only-kernels.md) — the rule this is an exception to
- [ADR 465](465-cpu-twins-for-region-filters.md) — the other exception, for the region filter
- [PM-0014](../../../../docs/adr/PM-0014-capability-layering.md),
  [PM-0015](../../../../docs/adr/PM-0015-data-and-actions-are-platform-layers.md) — the layering
  and the open point this settles
- core [ADR 1015](../../../../engine/core/docs/adr/1015-paged-action-the-action-registry.md) — the
  action registry and its cache key
