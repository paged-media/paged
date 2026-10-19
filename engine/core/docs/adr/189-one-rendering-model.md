# ADR 189 — One rendering model: Vello on the GPU, vello_cpu on the CPU

- **Status:** Accepted 2026-10-19 on the `vello-cpu` branch. Not on main: the fidelity gate
  fails on three fixtures (see Evidence), and an InDesign threshold is never loosened to let a
  change through. The branch merges when they pass.
- **Scope:**
  - `crates/paged-gpu`: `vcpu.rs` (the CPU rasterizer), `vello_map.rs` (the mapping both lanes
    share), `ink_planes.rs` (ink planes and overprint), `separations.rs`, `vello_rs.rs`; the
    tiny-skia rasterizer `cpu.rs` is deleted.
  - `crates/paged-cli` (the `tiny-skia` backend name stays an alias of `cpu`).
  - `corpus/generated/parity-thresholds.json`.
  - Comments and documentation that named tiny-skia, across the engine and the editor.
  - No model, wire or protocol change. The `cpu` feature keeps its name.

## Context

The display list has two rasterizers ([ADR 100](100-two-rasterisers-one-trait.md)). The CPU
lane was tiny-skia 0.12 with its own 7,150-line mapping of every display command; the GPU lane
is Vello 0.11 on wgpu. They disagreed by construction: tiny-skia's antialiasing, curve
flattening, blend arithmetic, masks and image sampling are not Vello's. The parity lane
([ADR 146](146-the-gpu-lane-is-held-to-the-cpu-lane.md)) budgeted fifteen fixtures above its
default, fourteen of them for glyph-edge antialiasing alone, and every feature had to be written,
and kept right, twice.

`vello_cpu` 0.3 is Vello's CPU renderer. It ships with Vello 0.11 and uses the same `peniko`
0.6 and `kurbo` 0.13 types, so one mapping from the display list can drive both.

## Decision

1. **The CPU lane is `vello_cpu`.** `paged_gpu::rasterize`, the command line, the fidelity
   gates, the renderer's pixel tests, ink coverage and the editor's CPU snapshots draw with it.
   It uses the u8 pipeline only, with no PNG or text features (the display list carries glyphs
   as outlines). Native builds use the SIMD level the CPU reports. Every build renders
   single-threaded, and wasm32 builds at the baseline level.
2. **One mapping for both lanes.** `vello_map.rs` turns paths, paints (solid, gradient, image),
   blend modes, strokes, caps and joins into `kurbo` and `peniko` values, and both rasterizers
   draw from it.
3. **The page is drawn on transparent and composited over the paper**, as the GPU lane does.
   This replaces the old paper bypass. A blend mode on blank paper blends with nothing, as in
   InDesign.
4. **Ink coverage keeps its exact arithmetic.** `ink_planes.rs` holds the per-ink 8-bit planes:
   a fill splats `max(plane, ink × coverage)`, an overprint composites
   `bottom + (top − bottom) × coverage`, and inks the document does not define are left out of
   the separated share. Every existing ink test pins the same numbers, and ink coverage stays
   on the CPU on both editor paths ([ADR 188](188-snapshots-draw-on-the-worker-gpu.md)).
5. **tiny-skia is no longer a dependency of the engine.** `resvg` still brings tiny-skia 0.11
   for placed SVGs, until those are drawn as vectors.

## Evidence

Measured on an Apple M3 Max (Metal), 2026-10-19, against main at the same engine sources
(tiny-skia), on the shared machine under load. Fidelity gate: `diff.sh` with the Coated FOGRA39
profile required.

- **Fidelity against InDesign, 101 fixtures.** 98 pass, 3 fail. Against tiny-skia, the
  worst-page mean ΔE is better on 52 fixtures, the same within 0.002 on 37 and worse on 12;
  p99 is better on 33 and worse on 20. Some rows (worst page; tiny-skia → vello_cpu,
  threshold):

  | Fixture        | mean ΔE                  | p99 ΔE                  | ink ΔE                   | Result |
  | -------------- | ------------------------ | ----------------------- | ------------------------ | ------ |
  | annual-base    | 0.058 → 0.053 (0.566)    | 1.00 → 0.40 (1.92)      | 13.94 → 13.19 (84.77)    | pass   |
  | column-rules   | 0.331 → 0.243 (0.397)    | 7.28 → 6.82 (8.73)      | 3.41 → 2.52 (4.09)       | pass   |
  | text-wrap      | 0.541 → 0.491 (0.649)    | 12.61 → 13.87 (15.13)   | 4.53 → 4.17 (8.07)       | pass   |
  | corners        | 0.665 → 0.670 (0.798)    | 0.00 → **3.89** (0.30)  | 13.24 → 13.28 (15.89)    | fail   |
  | inline-objects | 0.197 → 0.213 (0.237)    | 5.14 → **6.93** (6.16)  | 4.00 → 4.44 (6.71)       | fail   |
  | table-nested   | 0.045 → **0.062** (0.055)| 0.00 → 0.00 (0.30)      | 2.53 → **6.41** (3.03)   | fail   |

  - `corners`, page 5: a straight-edged shape whose edge pixels pdftoppm renders with stroke
    adjustment and 4×4 supersampling. Exact area coverage puts a band of pixels a few levels
    apart, and the 0.30 p99 threshold sits on that cliff.
  - `table-nested`: the table rules. They are hairline straight edges, so the ink ΔE is
    measured on their edge pixels.
  - `inline-objects`: curves. `vello_cpu` and the Vello GPU shaders flatten at 0.25 px.
    Flattening paths to 0.05 px before drawing brings the fixture to p99 1.25 and mean 0.128
    (and improves others), but `corners` and `table-nested` still fail, and parity with the GPU
    lane, which keeps 0.25 px, falls from a median of 0.006 to 0.026. The branch keeps
    0.25 px.
- **Text and export lanes.** `text-diff.sh`: 94 of 94 fixtures ok on both. `export-diff.sh`:
  654 of 654 pages ok on both; the worst page mean ΔE goes from 2.713 to 2.625.
- **Parity with the GPU lane** (`parity-diff.sh`, 101 fixtures, worst page per fixture). The
  mean goes from 0.0905 to 0.0194 and the median from 0.0422 to 0.0059. The largest is
  `transparency-targets`, 0.740 → 0.720 (G-2: Vello layers are always isolated). `text-wrap`
  goes from 0.389 to 0.041 and `column-rules` from 0.373 to 0.036. One fixture rises: `effects`,
  0.025 → 0.039. Fourteen of the fifteen budget entries now measure 0.015 to 0.041 and are
  dropped, so they fall to the 0.2 default; only `transparency-targets` keeps one. The default
  stays 0.2 until lavapipe has measured this lane.
- **Ink coverage.** The ink tests, including
  `ink_coverage_numbers_are_exact_for_a_pixel_aligned_fill`, pass with the same numbers.
- **Tests.** `cargo nextest` over `paged-gpu`, `paged-canvas`, `paged-sdk`,
  `paged-canvas-wasm`, `paged-renderer` and `paged-cli` runs 1,775 tests on main and 1,776 on
  the branch, all passing, 9 skipped on both. The 50 tests of `cpu.rs` were ported to `vcpu.rs`;
  the one added is `ink_planes.rs`'s own. No golden image was re-baselined.
- **Size.** canvas-wasm grows from 29,090,655 to 29,267,037 bytes (+176 KB, 0.61 %). The viewer
  SDK, which links no CPU rasterizer, is unchanged (+90 bytes).
- **Speed** (the machine under load, load average 13 to 24, so read these as directions).
  Natively, `paged-inspect` raster time at 144 dpi (render minus build, best of three),
  tiny-skia → vello_cpu: `text-wrap` 268 → 95 ms (6 pages), `transparency-targets` 537 → 262 ms
  (4), `effects` 362 → 322 ms (22), `images` 65 → 96 ms (14), `strokes-fills` 73 → 128 ms (25),
  `annual-base` 231 → 510 ms (134 mostly sparse pages). In the editor, a CPU snapshot of the
  first pages at 144 dpi, PNG included: `text-wrap` 480 → 457 ms, `transparency-targets`
  440 → 314 ms, `effects` 85 → 92 ms, `images` 123 → 135 ms, `annual-base` 46 → 63 ms. Dense
  text and transparency get faster; sparse pages pay a per-page cost that is not profiled yet.
- **Editor snapshots** (`snapshot-backends.journey.spec.ts`, 72 dpi, GPU against CPU): the
  worst mean difference falls from 0.104 to 0.051 levels and the share of pixels more than 8
  levels apart from 0.574 % to 0.003 %; most pages differ by at most 4 levels anywhere. The
  budget tightens from 0.13 and 0.72 % to 0.064 and 0.004 %.

## Consequences

Once merged, a display command has one meaning, written once. A difference between the lanes
is a Vello CPU/GPU difference, not two independent implementations, and the parity budgets
shrink to what remains: G-2 and the blur approximation.

Until then, main keeps tiny-skia. The three failing fixtures are edge-coverage differences
from pdftoppm's rasterization of the reference PDFs, not layout. Closing them needs either a
reference rasterizer that does not stroke-adjust, thresholds re-measured from InDesign's own
renders, or straight-edge snapping in the CPU lane. None of these is decided here.

## Related

- [ADR 100](100-two-rasterisers-one-trait.md): the two rasterizers; this record replaces its
  tiny-skia lane.
- [ADR 146](146-the-gpu-lane-is-held-to-the-cpu-lane.md): the parity lane.
- [ADR 188](188-snapshots-draw-on-the-worker-gpu.md): the editor's snapshot paths, whose CPU
  path this lane draws.
