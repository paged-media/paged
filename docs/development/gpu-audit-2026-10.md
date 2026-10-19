# GPU rendering audit, October 2026

An audit of the GPU rendering path after the `vello 0.10 → 0.11`,
`wgpu 29 → 30`, `naga 30`, `pollster 1` and `objc2 0.6.5` upgrade
(046531fa7, on main as d5df00f79). It covers the engine's Vello encoder
(`engine/core/crates/paged-gpu/src/vello_rs.rs`), the WebGPU surface the
editor and the viewer SDK present through (`paged-gpu/src/surface.rs`), the
editor's render worker (`apps/editor/apps/canvas/src/worker/`), the image
module's GPU kernels (`modules/image/image-gpu`) and the CI lanes that claim
GPU coverage.

Measured on an Apple M3 Max (Metal) and from the CI logs and artifacts of
main before (6c2ea3c5d, f7d90aeed) and after (d5df00f79) the upgrade. The
machine was shared with other builds during the measurements (load average
36–71), so the timings below compare like with like and are best read as
"no change", not as absolute numbers.

## Summary

- **The upgrade changed no rendering.** On lavapipe (CI) every one of the
  660 parity pages measures the same mean ΔE before and after (largest
  difference 9 × 10⁻⁶). On Metal, 589 of 660 Vello pages are byte-identical;
  the other 71 differ in a few anti-aliased pixels (largest ΔE 0.6, page
  means within 3 × 10⁻⁶). Vello is deterministic run to run on the same
  binary, so those 71 pages are the upgrade, and they are invisible.
- **The objc2 0.6.5 crash did not come back.** Eight full runs of the image
  module's tests on Metal (1,192 tests each) and the post-upgrade CI Metal
  run: no SIGSEGV. The local runs did surface a different, older failure:
  see I-1.
- **Every CI lane that claims GPU coverage on main got an adapter and ran
  its tests**, except one editor lane that has never run (L-4).
- **Two editor robustness bugs.** Without a WebGPU adapter the editor showed
  a blank canvas (fixed, E-1). After a GPU device loss it still shows a blank
  canvas with no message and no recovery (E-2, open).
- **No performance change** in the editor or natively.

## Findings

Severity: **high** — users see wrong or no output; **medium** — a fidelity or
coverage gap with a workaround; **low** — latent or cosmetic; **info** — no
action needed.

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Evidence                                                                                                                                                                                                                                                        | Severity       | Owner                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------------------------- |
| E-1 | Without a WebGPU adapter the editor canvas stayed blank. `initGpu` binds the OffscreenCanvas to a WebGPU context before it asks for an adapter; a canvas bound to WebGPU never returns a 2D context, so the CPU fallback had nothing to draw on. The HUD said "CPU". Affects every browser that has `navigator.gpu` but no adapter: a blocklisted GPU, a VM, `--disable-gpu`, Firefox with WebGPU blocklisted, Playwright's bundled Chromium.                                                                                                                                                                                                                                                                                                                                                                                                            | Chrome `--disable-gpu` and the bundled Chromium: 0 % of the canvas drawn, console `OffscreenCanvas 2D context unavailable — live tile compositor disabled`. Firefox reaches the same path.                                                                      | high           | **fixed** (this audit)      |
| E-2 | A lost GPU device is never noticed. Nothing registers `device.lost` or an uncaptured-error handler (`paged-gpu/src/surface.rs:154-247`); `presentFrame` returns `false` on error (`paged-canvas-wasm/src/lib.rs:616-700`) but the render loop ignores it (`apps/canvas/src/worker/render.ts:259`). After Chrome's GPU process crashes (CDP `Browser.crashGpuProcess`) the canvas is blank for the rest of the session, the HUD still reads "GPU 60 fps", and the console is silent. The viewer SDK presents through the same surface and has the same gap.                                                                                                                                                                                                                                                                                               | Device-loss probe: canvas fully blank after the crash, no console output. Not pinned by a test.                                                                                                                                                                 | high           | vello-cpu (surface), editor |
| E-3 | A device or renderer failure after the adapter is granted still binds the canvas to WebGPU and leaves it blank: the surface is created before the adapter and device (`surface.rs:159-198`). E-1's fix covers the no-adapter case only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Code reading.                                                                                                                                                                                                                                                   | low            | vello-cpu                   |
| E-4 | Heavy documents stall the present loop. A page whose Vello scene is not cached is built, its images decoded included, inside `presentFrame` (`paged-canvas-wasm/src/lib.rs:662`), so scrolling onto new pages of a 20-page magazine with 4–6 MB spreads gives 2.2–2.6 s frames and a 54–76 ms mean. Same before and after the upgrade.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Perf probe (below).                                                                                                                                                                                                                                             | medium         | editor / vello-cpu          |
| G-1 | Overprint is knockout in the editor and the viewer. `FillPathOverprint` / `StrokePathOverprint` draw as plain fills on the surface path (`vello_rs.rs:1022-1065`); the CMYK compute path exists only in the native `VelloRasterizer::rasterize` (`vello_rs.rs:179-212`). The parity lane cannot see this: pages with 1–8 overprints are handed to the CPU rasterizer (`vello_rs.rs:191-194`), so it compares CPU with CPU (`strokes-fills` has overprints). The editor's live view therefore disagrees with its own CPU snapshots and exports.                                                                                                                                                                                                                                                                                                           | Code reading; fixture `strokes-fills`. Not pinned for the surface.                                                                                                                                                                                              | medium         | vello-cpu                   |
| G-2 | Knockout groups and non-isolated groups below 100 % opacity draw as isolated groups (ADR 146); `BeginBlendGroup`'s `isolated` and `knockout` fields are dropped (`vello_rs.rs:873-908`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Pinned by the `transparency-targets` parity budget: 0.74 on Metal, 0.855 on lavapipe against 0.89 (96 % of the budget on CI).                                                                                                                                   | medium (known) | vello-cpu                   |
| G-3 | The Gaussian-blur layer's tap offsets are applied after `page_to_px` (`vello_rs.rs:1671-1675`), so they are device pixels, not points, whenever the page transform is not the identity: the native rasterizer at any dpi other than 72 blurs by σ·72/dpi. The surface path builds pages at the identity and is correct. Latent: no emitter produces `PushLayer { GaussianBlur }`, and the one GPU test (`push_layer_gaussian_blur_softens_edges_on_gpu`) renders at 72 dpi.                                                                                                                                                                                                                                                                                                                                                                              | Code reading (`Scene::append` composes the given transform outside the child's).                                                                                                                                                                                | low            | vello-cpu                   |
| G-4 | Other approximations, all documented in the module: 7×7-tap blur (`vello_rs.rs:1558-1683`); spot-on-same-spot overprint lost outside the compute path (`:2672-2688`); a soft mask over a blend group that only partly spans the masked content stays isolated (`:72-82`, pinned by `the_blend_group_fold_only_fires_on_an_exact_span`); luminosity mask coefficients round differently (`:65-67`); images sample bilinear on Vello and nearest on the CPU lane; radial gradients under a non-uniform transform use the averaged radius on both lanes (`:2716-2722`).                                                                                                                                                                                                                                                                                     | Parity budgets absorb all of them.                                                                                                                                                                                                                              | low            | vello-cpu                   |
| G-5 | A wgpu validation error panics natively (wgpu's default handler) and only reaches the browser console on the web; no error scopes are used anywhere.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `wgpu-30.0.1/src/backend/wgpu_core.rs:692`; I-1's panic.                                                                                                                                                                                                        | info           | vello-cpu                   |
| I-1 | A pre-existing image pipeline bug, found by proptest during the objc2 runs: `pipeline_resident::resident_chains_equal_the_per_tile_scheduler` fails with `Queue::write_texture: Copy at offset 0 for 14080 bytes would end up overrunning the bounds of the Source buffer of size 7680` (from `image_gpu::execute::prepare_tile` → `resident::write_whole`). `materialize_apply_async` (`image-pipeline/src/schedule.rs:405-447`, and its sync twin) uploads the upstream tile's bytes at its own work region's size, and at the image's bottom edge the upstream tile is shorter (40 × 24 against 40 × 44 at RGBA16F); a length check there would turn the wgpu panic into an error, the region mismatch is the cause. Same failure on wgpu 29 / objc2 0.6.4, so not the upgrade. Each CI run draws 16 random cases, so the GPU lanes go red at random. | Seed: `dims = (40, 300), seed = 0, stages = [Sharpen(0.1), Blur(0.5), Sharpen(0.1)], selection = false` (proptest `cc 5ed93a2254e521211a35e0933d8bf39e2895b3d904c9fdbc62dc2888ac7b2d58`). Found in 1 of 5 runs, then reproduced 3 of 3 on the pre-upgrade tree. | medium         | image module                |
| L-1 | `core / gpu` verifies its adapter and runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Before and after: `vulkaninfo` reports `llvmpipe (LLVM 20.1.2, 256 bits)`; 85 tests run, 0 skipped (27 of them Vello, the rest the CPU rasterizer and separations); parity 101/101 fixtures within budget.                                                      | info           | —                           |
| L-2 | The `paged-gpu` Vello tests that need a device returned early on an empty buffer when there was no adapter, and passed. The lane stayed honest because its `vulkaninfo` step fails without lavapipe and the parity step exits 2 when Vello renders nothing; since a71f7141f the tests report `unavailable: GPU adapter` and the lane sets `PAGED_REQUIRE_GPU=1`, so each one fails without a device.                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `vello_rs.rs` `gpu_path_ran`, `.github/workflows/core-gpu.yml`.                                                                                                                                                                                                 | resolved       | T3                          |
| L-3 | `image / ci`'s GPU lanes verify their adapter and run. 282 image tests skip without an adapter; the `rust engine` job runs them that way (said so in the workflow), and the `gpu-sw` and `gpu-metal` jobs run them with a skip turned into a failure (`REQUIRE_GPU=1`, `PAGED_REQUIRE_GPU=1` since 514b7f22c).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Before and after: lavapipe `test GPU: llvmpipe (LLVM 20.1.2, 256 bits) (Vulkan)`, Metal `test GPU: Apple Paravirtual device (Metal)`; 1,193 passed, 21 ignored, 0 failed in each.                                                                               | info           | —                           |
| L-4 | `editor / tests` "journeys (GPU, advisory)" claims GPU coverage it cannot have: it runs `--project=journeys` under xvfb with the bundled Chromium, no Vulkan driver is installed, the project's `testIgnore` excludes the only spec that asserts `gpuActive`, and nothing checks for an adapter. It is `workflow_dispatch`-only and has not run since the monorepo port. **Retired:** the step is removed; the workflow says where the WebGPU path does run.                                                                                                                                                                                                                                                                                                                                                                                             | `.github/workflows/editor-tests.yml`, step "journeys (GPU, advisory)".                                                                                                                                                                                          | low            | T3 / user                   |
| L-5 | The editor's real GPU lane (`journeys-gpu`) and the macOS WebGPU showcase nightly are the only places the WebGPU present path runs end to end; the first is local-only, the second has not run yet on the monorepo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `playwright.config.ts` (journeys-gpu header), `editor-showcase-nightly.yml`.                                                                                                                                                                                    | low            | user                        |
| R-1 | Limits: native and image devices request `Limits::default()` raised to the adapter's texture size (`vello_rs.rs:412`, `image-gpu/src/device.rs:83`), as Vello's own helper does; the surface requests `downlevel_webgl2_defaults()` (`surface.rs:191`), which browsers raise to the WebGPU defaults. Storage-buffer sizes therefore stay at the 128 MiB default even where the adapter allows more. No features are required (BGRA8 storage is taken when offered).                                                                                                                                                                                                                                                                                                                                                                                      | Code reading; no limit errors seen.                                                                                                                                                                                                                             | info           | vello-cpu                   |
| R-2 | Vello compiles its pipelines on one thread on native too (`vello_rs.rs:423`), which wasm needs but native does not. Startup (adapter, device, Vello and CMYK pipelines) costs 0.3–0.6 s natively; the editor attaches its GPU renderer 1.8–2.4 s after navigation, the same before and after.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Timings below.                                                                                                                                                                                                                                                  | info           | vello-cpu                   |
| R-3 | No wgpu 30 deprecation or other warnings: native `cargo clippy -p paged-gpu --features vello-backend --all-targets -D warnings` is clean, and the wasm builds (canvas-wasm, sdk, image) print no Rust warnings beyond a local toolchain failing to strip build-script binaries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Build logs.                                                                                                                                                                                                                                                     | info           | —                           |

## Measurements

### Parity (CPU ↔ Vello, 101 fixtures, 660 pages, 144 dpi)

| Lane                                    | Before                | After                                                                             |
| --------------------------------------- | --------------------- | --------------------------------------------------------------------------------- |
| lavapipe (CI, `vello-parity` artifacts) | 101/101 within budget | 101/101 within budget; per-page mean ΔE identical (max difference 9 × 10⁻⁶)       |
| Metal (local)                           | 101/101 within budget | 101/101; 589/660 Vello pages byte-identical, the rest max ΔE 0.6 on single pixels |

Closest to budget after the upgrade: `inline-objects` 0.176 of 0.20 on Metal
(0.193, 97 %, on lavapipe), `transparency-targets` 0.855 of 0.89 on lavapipe.
`footnote-keeps` measures 0.177 (Metal) and 0.193 (lavapipe), inside the
default budget, so its 0.31 entry can go once the CPU lane change below has
landed.

### Image module on Metal (`REQUIRE_GPU=1`, `cargo test --workspace`)

| Run                                             | Result                                                 |
| ----------------------------------------------- | ------------------------------------------------------ |
| CI `gpu-metal`, after                           | 1,193 passed, 21 ignored, 0 failed                     |
| local 1–2                                       | 1,192 passed, 21 ignored                               |
| local 3                                         | 1,191 passed, 1 failed (I-1, found by proptest)        |
| local 4–5                                       | 1,191 passed, 1 failed (I-1, the stored seed replayed) |
| local 6–8 (seed removed, `PAGED_REQUIRE_GPU=1`) | 1,192 passed, 21 ignored                               |

No run crashed. 282 of the tests need a device and skip without one.

### Editor on WebGPU (real Chrome, new headless, Metal)

Mean present time (the `worker.frame` rollups while the camera scrolls and
zooms), warm Vello readbacks of the first three pages at 144 dpi
(`requestVelloPng`: scene, GPU render, readback, PNG), and the GPU process
footprint after each document. Two runs each.

| Document                                             | Present mean (ms), before → after         | Readback (ms) | GPU process (MB)          |
| ---------------------------------------------------- | ----------------------------------------- | ------------- | ------------------------- |
| `text-wrap` (6 pages, dense text)                    | 1.24–1.30 → 1.19–1.20                     | 73–78 → 73    | 617–635 → 558–634         |
| `transparency-targets` (4 pages, blends and effects) | 0.38–0.39 → 0.32–0.44                     | 26–27 → 25–26 | 493–722 → 654–661         |
| `annual-base` (134 pages)                            | 0.42–0.44 → 0.38–0.46                     | 11–12 → 11    | 660–800 → 695–712         |
| a 20-page magazine with 4–6 MB spreads               | 70–76 (max 2.5 s) → 54–73 (max 2.2–2.5 s) | 38 → 37–39    | 1,049–1,217 → 1,063–1,207 |

Load times are unchanged (70–130 ms for the generated fixtures, 7.6–8.9 s
for the magazine). The canvas-wasm grew by 9 KB (28,892,802 → 28,902,154
bytes). Natively, rendering `annual-base` with Vello spends the same CPU
time before and after (user 2.3–2.5 s, sys 2.6–3.0 s); wall time varied
with the machine's load.

### Editor journeys

The focused GPU journeys (`gpu-backend`, both `gpu-reentrancy` cases) pass
on the upgraded wasm: the WebGPU backend claims the canvas, survives
`initGpu`'s await and keeps presenting during readbacks.

| Project                                 | Browser              | Passed | Failed | Skipped |
| --------------------------------------- | -------------------- | ------ | ------ | ------- |
| `journeys-gpu` (WebGPU over Metal)      | Chrome, new headless | 147    | 3      | 3       |
| `journeys` (no adapter, CPU compositor) | bundled Chromium     | 125    | 3      | 22      |

The three failures are the same in both lanes and have nothing to do with
rendering: the Properties-panel chrome checkpoints of the image, text-flow
and vector journeys (`properties-image.png`, `properties-text.png`,
`properties-frame.png`) no longer match their committed macOS baselines
because the panel got shorter. The 20 paged.image journeys that skip on the
bundled Chromium (GPU-only kernels) ran and passed on WebGPU, as did the
other 16 image journeys, so the image module's wgpu 30 build works in the
browser.

### Without WebGPU

| Browser                       | `navigator.gpu` | Adapter | Before                      | After the fix                      |
| ----------------------------- | --------------- | ------- | --------------------------- | ---------------------------------- |
| Chrome `--disable-gpu`        | yes             | none    | blank canvas, "CPU" badge   | page drawn on the CPU, "CPU" badge |
| Playwright's bundled Chromium | yes             | none    | blank canvas                | page drawn on the CPU              |
| Firefox (WebGPU blocklisted)  | yes             | none    | not run; the same code path | page drawn on the CPU              |

The image module already says "WebGPU unavailable — …" for its GPU-only
tools. The viewer SDK has no CPU path by design and reports
`GPU_UNAVAILABLE` (`engine/core/web/idml-viewer/src/viewer.ts:131`).

## Fixed in this audit

- E-1 (cf850361a): the render worker asks `navigator.gpu.requestAdapter()` before
  `initGpu` and goes straight to the CPU compositor when there is none
  (`apps/editor/apps/canvas/src/worker/worker.ts`).
  `tests/journey/focused/cpu-fallback.journey.spec.ts` asserts the page is
  drawn without an adapter; it failed before the fix (0 % of the canvas
  drawn) and passes after, and it skips where WebGPU engages.

## Recommendations

1. **Handle device loss (E-2, E-3).** Register `device.lost` on the surface
   device; on loss, drop the presenter, tell the worker, and let it call
   `initGpu` again on a fresh canvas (or fall back to the CPU compositor). At
   the least, have the render loop act on `presentFrame` returning `false`
   and the HUD stop reporting "GPU". Create the surface only after the
   device and the Vello renderer exist.
2. **Measure what the editor draws (G-1).** Either give the surface path the
   overprint compute pass or render overprint pages through the CPU lane in
   the editor too; and let the parity lane force the compute path
   (`FORCE_COMPUTE_PATH`) so it measures Vello on overprint pages instead of
   the CPU finisher.
3. **Fix I-1 and commit its seed.** Store
   `image-conformance/tests/proptest-regressions/pipeline_resident.txt` with
   the fix, not before, or the GPU lanes go red on every run.
4. **Build heavy page scenes off the present path (E-4)**, e.g. incrementally
   or ahead of the camera, so a scroll onto an uncached page does not stall
   the frame.
5. **Fix or retire L-4** (retired: the step is removed), and give the WebGPU path a CI lane that checks its
   adapter (a scheduled macOS runner with `journeys-gpu`, as the showcase
   nightly does).
6. When the CPU lane moves to `vello_cpu`, re-measure the parity budgets and
   drop `footnote-keeps`; fix G-3 before anything emits a blurred layer.
