# ADR 188 — Snapshots draw on the worker's GPU, and a lost device is replaced

- **Status:** Accepted 2026-10-19.
- **Scope:**
  - `crates/paged-gpu`: `surface.rs` (the device is asked for before the surface, the lost
    flag, `recover`, the offscreen snapshot render), `vello_rs.rs` (every overprint page on the
    compute path, the blur tap offsets).
  - `crates/paged-canvas`: `snapshot.rs` (`snapshot_page`, `encode_snapshot_png`, shared by
    both snapshot paths).
  - `crates/paged-canvas-wasm`: `renderSnapshotGpu`, `gpuReady`, `gpuLostReason`,
    `recoverGpu`, `simulateGpuLoss`.
  - `crates/paged-sdk` and `web/idml-viewer`: the `gpu_lost` diagnostic and `recoverGpu`.
  - The editor's render worker, `ViewportCanvas` and the client (`setSnapshotBackend`,
    `snapshotBackendInfo`).
  - `corpus/generated/parity-thresholds.json` (one entry dropped).
  - No model, wire or protocol change. Every addition is a wasm export, a worker message or a
    client method.

## Context

The editor draws its canvas with Vello on the render worker's WebGPU device
([ADR 100](100-two-rasterisers-one-trait.md)). Everything that reads pixels back went through
a different rasterizer: `RequestSnapshot` (the eyedropper, PNG export, AI page images, document
thumbnails) drew the page again with the CPU rasterizer. The eyedropper therefore sampled a
colour the screen did not show, a level or two off on anti-aliased or transparent artwork.

The GPU audit of October 2026 ([gpu-audit-2026-10.md](../../../../docs/development/gpu-audit-2026-10.md))
found four defects in the same code:

- **E-2.** A lost device (a GPU-process crash, a driver reset) went unnoticed. `presentFrame`
  returned `false` and the render loop ignored it; the canvas stayed blank under a "GPU" badge.
  The viewer SDK had the same gap.
- **E-3.** The surface was created before the adapter and the device, so a device or renderer
  failure left the canvas bound to WebGPU, with no 2D context left for the CPU fallback.
- **G-1.** On the screen, overprint draws as knockout. The parity lane could not see what Vello
  does with overprint: `VelloRasterizer::rasterize` handed every page with one to eight
  overprints to the CPU rasterizer.
- **G-3.** The Gaussian-blur layer's tap offsets were applied in device pixels, not points, so
  natively at any resolution other than 72 dpi a blur spread by σ·72/dpi.

## Decision

1. **A snapshot draws on the worker's GPU when it has a device.** `renderSnapshotGpu` resolves
   the page with the CPU path's own `paged_canvas::snapshot_page` (same page, size, resolution
   and hidden items), builds its scene as the screen does
   (`SurfacePresenter::build_snapshot_scene`), renders it to an offscreen texture on the
   presenter's device, reads it back and encodes it with the CPU path's `encode_snapshot_png`.
   It resolves to `undefined` when there is no device, no document or no snapshot request, and
   the worker then answers on the CPU rasterizer as before.
2. **The host can force either path.** `client.setSnapshotBackend("auto" | "gpu" | "cpu")`,
   `auto` by default; `gpu` without a device falls back to the CPU.
   `client.snapshotBackendInfo()` reports what was asked for, whether the worker has a device,
   and which path drew the last snapshot. Both are worker messages, not wire operations.
3. **Overprint: knockout on the screen, per ink everywhere else.** The screen draws overprint as
   knockout, as InDesign does with Overprint Preview off. A snapshot feeds exports and print
   checks, so a page that overprints is snapshotted on the CPU, which composites per ink.
   Natively, `VelloRasterizer::rasterize` sends every page that overprints through its GPU
   compute path, and the hand-off to the CPU rasterizer is gone. The parity lane now compares
   Vello's own overprint arithmetic with the CPU's, and the test-only `FORCE_COMPUTE_PATH` flag
   that forced the compute path is removed.
4. **Ink coverage stays on the CPU.** Its numbers have to be the same whichever path draws the
   screen. They are per-ink coverage sums over 8-bit ink planes. Vello's readback is a
   composited RGBA image, and its compute path keeps plane state per overprint batch, not the
   totals. The native headless lanes stay on the CPU rasterizer as well.
5. **The device is asked for before the surface (E-3).** `Gpu::request` gets the adapter, the
   device and the Vello renderer before the canvas is touched. A failure among them leaves the
   canvas without a WebGPU context, so the CPU fallback can draw on it.
6. **A lost device is noticed and replaced (E-2).** The device's lost callback sets a flag.
   From then on `presentFrame` returns `false` and `gpuReady()` is false, so snapshots fall to
   the CPU at once. `gpuLostReason()` says why. The worker reads the flag when a present fails
   and on every idle tick, because a crash blanks the canvas whether or not anything presents.
   It warns `gpuLost` and calls `recoverGpu()`, which requests a new adapter, device and
   renderer and reconfigures the same surface. Cached scenes stay valid because they are
   encodings, not GPU resources. On success it warns `gpuRecovered` and redraws. Otherwise the
   canvas is lost to WebGPU: the worker stops the renderer, reports `attachReady` with
   `gpuActive: false` and warns `canvasNeeded`. The viewport then mounts a new canvas, which
   attaches on the CPU path with no second `initGpu`, and the badge says "CPU".
   `simulateGpuLoss()` destroys the device, as a crash would, for the tests. In the viewer SDK,
   `present` reports the diagnostic `gpu_lost` and the session gains `recoverGpu()`.
   `@paged-media/idml-viewer` tries it once and redraws, or emits `GPU_UNAVAILABLE`.
7. **Blur offsets are in points (G-3).** Each tap's offset goes through the page transform's
   linear part before it translates the captured sub-scene.

## Evidence

Measured on an Apple M3 Max (Metal), Chrome with WebGPU, 2026-10-19.

- **GPU and CPU snapshots of the same page** (`snapshot-backends.journey.spec.ts`, 72 dpi, six
  pages each of `transparency`, `effects`, `gradients`, `strokes-fills`, `text` and `images`,
  every channel of every pixel). Against the CPU rasterizer of record, tiny-skia: the worst
  mean absolute difference is 0.104 levels (a gradients page), and the worst share of pixels
  more than 8 levels apart is 0.574 % (a text page, at glyph edges). Two runs gave the same
  numbers. The budget is the worst page × 1.25: 0.13 and 0.72 %.
- **The eyedropper** samples a 35 %-opacity fill over paper. The GPU path returns the screen's
  pixel exactly (tolerance 0), the CPU path within 2 levels.
- **Device loss** (`gpu-device-loss.journey.spec.ts`). After `simulateGpuLoss` the worker warns
  `gpuLost` then `gpuRecovered`, and the page draws again. With every later adapter request
  refused, it warns `gpuLost` then `canvasNeeded`, `gpuActive` turns false and the page is drawn
  on the CPU. The viewer's recovery is covered by two bun tests.
- **Blur.** `blur_spread_is_in_points_at_any_dpi` reads the halo 3, 6 and 9 pt outside a
  blurred rectangle at 72 and 144 dpi. Before the fix, the 3 pt sample read 181 at 72 dpi and
  242 at 144 dpi; after it, the two agree within 16 levels.
- **Overprint.** `vello_overprint_matches_the_cpu_lane` composites a cyan overprint on magenta
  through the compute path and through the CPU rasterizer and finds the same blue. On the
  corpus the change measures nothing, because no generated fixture overprints: the
  `strokes-fills` "overprint" case writes `StrokeOverprint`, which is not an InDesign attribute
  (InDesign's is `OverprintStroke`), so it imports as nothing. Correcting it means exporting
  that fixture's reference PDF from InDesign again.
- **Parity lane** (`parity-diff.sh`, 144 dpi): 101 of 101 fixtures within budget, the same
  numbers as before the change (largest difference 1 × 10⁻⁶). `footnote-keeps` measures 0.177 on Metal and 0.193 on lavapipe
  (three CI runs, identical), under the 0.2 default, so its 0.31 entry is dropped.
  `transparency-targets` stays at 0.740 on Metal and 0.855 on lavapipe against 0.89 (G-2, known
  since [ADR 146](146-the-gpu-lane-is-held-to-the-cpu-lane.md)).
- **Ink coverage.** `ink_coverage_numbers_are_exact_for_a_pixel_aligned_fill` pins the exact
  per-plate numbers of a pixel-aligned rich black.
- **canvas-wasm** grows from 29,076,983 to 29,090,647 bytes (+13.7 KB, 0.05 %).

## Consequences

On a machine with WebGPU the eyedropper, PNG export, AI page images and thumbnails show what
the screen shows. Without WebGPU nothing changes. A snapshot of a page that overprints differs
from the screen in the overprinted areas, by design (item 3).

A lost device costs a moment and a redraw instead of the rest of the session. When the browser
grants no new device, the editor keeps working on the CPU and says so.

The overprint compute path is now the only way native Vello draws overprint, so a defect in it
shows up in the parity lane once a fixture overprints. There is no such fixture until
`strokes-fills` is corrected and re-exported.

Not decided here:

- **E-4.** A page whose scene is not cached is built inside `presentFrame`, and its images
  are decoded there, at full size. On a 20-page magazine every stalled frame (0.75 to 2.4 s) is
  image decoding; the scene build itself takes under 5 ms. The audit's follow-up has the
  numbers and a proposal.
- **G-2.** Knockout groups and non-isolated groups draw as isolated groups on Vello.

## Related

- [ADR 100](100-two-rasterisers-one-trait.md): the two rasterizers. Snapshots and ink coverage
  were CPU-only there.
- [ADR 146](146-the-gpu-lane-is-held-to-the-cpu-lane.md): the parity lane and its budgets.
- [gpu-audit-2026-10.md](../../../../docs/development/gpu-audit-2026-10.md): the findings this
  record closes (E-2, E-3, G-1, G-3).
