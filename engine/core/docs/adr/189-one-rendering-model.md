# ADR 189 — One rendering model: Vello on the GPU, vello_cpu on the CPU

- **Status:** Accepted 2026-10-19.
- **Scope:**
  - `crates/paged-gpu`: `vcpu.rs` (the CPU rasterizer), `vello_map.rs` (the mapping both lanes
    share, with stroke adjustment and curve flattening), `ink_planes.rs` (ink planes and
    overprint), `separations.rs`, `vello_rs.rs`; the tiny-skia rasterizer `cpu.rs` is deleted.
  - `crates/paged-renderer`: the Fancy corner (`pipeline/shapes.rs`), drawn as InDesign draws it.
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
0.6 and `kurbo` 0.13 types, so one mapping from the display list can drive both. It is the
latest release (crates.io, 2026-10-19).

The fidelity gate's references are InDesign's PDFs rasterized by poppler's Splash
(`pdftoppm`). Three things in Splash decide edge pixels, and the first switch to `vello_cpu`
missed all three, failing `corners`, `inline-objects` and `table-nested`:

- **Stroke adjustment.** Splash applies PDF's stroke adjustment on every page, whatever the
  `SA` flag says (poppler's own comment: Acrobat hardwires it on). A fill that is one
  four-cornered subpath along the axes, and a stroke whose every segment runs along an axis,
  have their edges rounded to pixel boundaries, keeping at least one pixel. tiny-skia's 4×4
  supersampling rounded every edge to a quarter pixel, which lands an edge near a boundary on
  it, so it matched by accident; exact area coverage leaves a row of part-covered pixels.
- **Text is FreeType's.** Splash draws text through FreeType, which follows a glyph's curves
  closely. Vello and `vello_cpu` flatten every curve to a fixed 0.25 px; chords cut inside a
  convex curve, so at text sizes a glyph comes out measurably thinner.
- **Vector curves** are flattened into segments a few pixels long, much finer than 0.25 px on a
  large curve.

## Decision

1. **The CPU lane is `vello_cpu`.** `paged_gpu::rasterize`, the command line, the fidelity
   gates, the renderer's pixel tests, ink coverage and the editor's CPU snapshots draw with it.
   It uses the u8 pipeline only, with no PNG or text features (the display list carries glyphs
   as outlines). Native builds use the SIMD level the CPU reports, wasm32 builds the baseline
   level, and every build renders single-threaded (measured below).
2. **One mapping for both lanes.** `vello_map.rs` turns paths, paints (solid, gradient, image),
   blend modes, strokes, caps and joins into `kurbo` and `peniko` values, and both rasterizers
   draw from it. What follows is done there, once, so the lanes draw the same geometry.
3. **Stroke adjustment, as Splash and Acrobat do it.** At the device transform of the surface
   drawn into, an axis-aligned rectangle fill has its edges rounded to pixel boundaries, and a
   stroke whose every segment (dashes included) runs along an axis is expanded to its outline
   with each side, and each butt or square cap, rounded the same way. A pair of edges that would
   meet keeps one pixel between them. Anything with a curve or a slanted segment is drawn as it
   is, as in Splash, which drops all of a path's adjustment when one segment is off the axes.
   Splash pulls the far edge 0.01 px back for its inclusive scan spans; with exact coverage
   the edge stays on the boundary. Glyph fills are not adjusted, because Splash renders text
   through its font engine; the display list says which fills are glyphs only in its glyph-run
   table (the gate's renders and the PDF export collect it), so without one a glyph that is
   exactly a rectangle is adjusted too, in both lanes alike.
4. **Filled curves are flattened to 0.1 device px** before either rasterizer sees them, in the
   path's own space and kept per path and linear transform, so every instance of a glyph at one
   size reuses one polyline. Strokes and clips keep the rasterizers' own 0.25 px.
5. **The page is one isolated group over the paper**, as the GPU lane draws it: a blend mode on
   blank paper blends with nothing, as in InDesign. A page whose commands are all plain draws
   (`Normal` fills and strokes, images and clips) reads no backdrop, so it is drawn straight
   onto the paper, which is the same composite; the others are drawn on transparent and
   composited over the paper at the end.
6. **Ink coverage keeps its exact arithmetic.** `ink_planes.rs` holds the per-ink 8-bit planes:
   a fill splats `max(plane, ink × coverage)`, an overprint composites
   `bottom + (top − bottom) × coverage`, and inks the document does not define are left out of
   the separated share. The planes take the same adjusted geometry as the colour image. Ink
   coverage stays on the CPU on both editor paths
   ([ADR 188](188-snapshots-draw-on-the-worker-gpu.md)).
7. **The Fancy corner is InDesign's.** Read from InDesign's own PDF of `corners` (a rectangle
   and a triangle): straight segments on a three-by-three grid across the corner, `(0,3) → (2,3)
   → (2,1) → (1,1) → (1,2) → (3,2) → (3,0)` in thirds of the way from the vertex toward each
   edge point, at any corner angle. It was three approximating arcs, so the frame's long sides
   were not adjusted where InDesign's were.
8. **tiny-skia is no longer a dependency of the engine.** `resvg` still brings tiny-skia
   (0.12, since resvg 0.48) for placed SVGs, until those are drawn as vectors.

## Evidence

Measured on an Apple M3 Max (Metal), 2026-10-19, on the shared machine under load (load
average 13 to 30), against main at the same engine sources (tiny-skia) and against the branch
before this work (`vello_cpu`, no adjustment, 0.25 px). Fidelity gate: `diff.sh`, Coated FOGRA39
required.

- **Fidelity against InDesign, 101 fixtures.** tiny-skia 101 pass; the first `vello_cpu`
  build 98; this one 101. Worst page per fixture, tiny-skia → first `vello_cpu` → this
  (threshold):

  | Fixture        | mean ΔE                        | p99 ΔE                        | ink ΔE                        |
  | -------------- | ------------------------------ | ----------------------------- | ----------------------------- |
  | corners        | 0.665 → 0.670 → 0.419 (0.798)  | 0.00 → 3.89 → 0.00 (0.30)     | 13.24 → 13.28 → 8.86 (15.89)  |
  | inline-objects | 0.197 → 0.213 → 0.085 (0.237)  | 5.14 → 6.93 → 1.07 (6.16)     | 4.00 → 4.44 → 1.76 (6.71)     |
  | table-nested   | 0.045 → 0.062 → 0.003 (0.055)  | 0.00 → 0.00 → 0.00 (0.30)     | 2.53 → 6.41 → 0.53 (3.03)     |
  | column-rules   | 0.331 → 0.243 → 0.101 (0.397)  | 7.28 → 6.82 → 1.52 (8.73)     | 3.41 → 2.52 → 1.05 (4.09)     |
  | text-wrap      | 0.541 → 0.491 → 0.335 (0.649)  | 12.61 → 13.87 → 11.22 (15.13) | 4.53 → 4.17 → 2.86 (8.07)     |
  | opentype       | 0.105 → 0.086 → 0.051          | 3.28 → 1.90 → 0.66            | 3.20 → 2.73 → 1.68            |
  | images         | 0.113 → 0.112 → 0.086          | 0.00 → 0.00 → 0.00            | 44.97 → 44.93 → 36.14         |
  | annual-base    | 0.058 → 0.053 → 0.053 (0.566)  | 1.00 → 0.40 → 0.32 (1.92)     | 13.94 → 13.19 → 13.10 (84.77) |

  Against tiny-skia, the worst-page mean ΔE is now better on 86 fixtures, the same within
  0.002 on 13 and worse on 2 (`text-on-path` 0.067 → 0.074, `gradients` 0.170 → 0.172); p99
  is better on 49 and worse on 5; ink ΔE better on 87 and worse on 12. Against the first
  `vello_cpu` build the mean is better on 83, the same on 15 and worse on 3 (`conditions`,
  `gradients`, `table-inline-text`, by at most 0.013). No threshold was touched.

  What each change did to the three failing fixtures: stroke adjustment alone passes
  `table-nested` (mean 0.062 → 0.006) and `inline-objects` (p99 6.93 → 5.78, its frames and
  rules); `corners` page 5 stays at 3.89, because the engine drew the Fancy frame with arcs and
  InDesign with straight segments, which Splash adjusts. InDesign's Fancy geometry passes it.
  Flattening then takes `inline-objects` to p99 1.07.

  Flattening tolerance (curves of fills, both lanes; worst page mean / p99):

  | Tolerance | inline-objects | column-rules | opentype    | text-wrap    | `text-wrap` raster |
  | --------- | -------------- | ------------ | ----------- | ------------ | ------------------ |
  | 0.25 px   | 0.171 / 5.78   | 0.233 / 6.55 | 0.086 / 1.90 | 0.466 / 12.96 | 31.5 ms           |
  | 0.15 px   | 0.111 / 3.25   | 0.152 / 4.18 | 0.062 / 0.82 | 0.365 / 11.14 | —                 |
  | 0.1 px    | 0.085 / 1.07   | 0.101 / 1.52 | 0.051 / 0.66 | 0.335 / 11.22 | 29.3 ms (cached)  |
  | 0.05 px   | 0.081 / 0.95   | 0.100 / 1.53 | 0.049 / 0.67 | 0.328 / 11.34 | 47.3 ms (uncached)|
  | 0.025 px  | 0.090 / 1.48   | 0.118 / 1.97 | 0.053 / 0.80 | 0.336 / 11.45 | 67.9 ms (uncached)|

  Below 0.1 px nothing improves (0.025 px is worse again), and 0.05 px has 1.4 times the
  segments, so 0.1 px it is. Without the cache, flattening cost 18 to 28 ms of a 50 ms
  `text-wrap` render.

  Where stroke adjustment costs: `conditions` and `text-advanced` print a paragraph rule that
  InDesign's reference does not show (a layout difference); adjusted, the rule is crisp and
  darker, so their ink ΔE rises (27.39 → 29.76, 62.74 → 67.05; thresholds 32.97 and 81.03).
  On `layout` page 4 a vertical stroke the engine places about half a pixel from InDesign's
  rounds to the next column (ink 14.1 → 18.5), while its other nine pages improve.
- **Text and export lanes.** `text-diff.sh`: 94 of 94 fixtures ok. `export-diff.sh` with the
  Ghostscript CMYK profile as CI runs it: 653 of 653 gated pages and `footnotes` ok, as before;
  the mean of the per-page means goes from 0.170 to 0.144, the worst page (`column-rules` 1)
  from 2.625 to 2.661.
- **Parity with the GPU lane** (`parity-diff.sh`, 101 fixtures, worst page per fixture): tiny-skia
  mean 0.0905 and median 0.0422; first `vello_cpu` build 0.0194 and 0.0059; this one 0.0169 and
  0.0034. No fixture rises by more than 0.005; 16 fall by more. The largest is
  `transparency-targets`, 0.720 (G-2: Vello layers are always isolated); every other fixture is
  at most 0.131. Fourteen of the fifteen former budget entries are dropped, so they fall to the
  0.2 default, which stays until lavapipe has measured this lane.
- **Ink coverage.** The ink tests, including
  `ink_coverage_numbers_are_exact_for_a_pixel_aligned_fill`, pass with the same numbers.
- **Tests.** `cargo nextest --workspace`: 4,056 tests, all passing with the CMYK test profile in
  place (`corpus/profiles`), none re-baselined. The 50 tests of `cpu.rs` were ported to
  `vcpu.rs`. Added: the adjustment and flattening rules (`vello_map`), whole-pixel rules and
  rectangles on the CPU lane, the same pixels on both lanes (`vello_rs`, on Metal), and the
  paper composite's rounding. `inline_objects` and `corner_options` count InDesign's Fancy
  geometry. A blend-group parity test draws its control edge with a clip, which, like a
  group's bounds, is not adjusted.
- **Size.** SIZE_TBD
- **Speed.** Natively, raster time per document at 144 dpi (`paged-inspect`, the rasterizer
  alone, best of five), tiny-skia → first `vello_cpu` build → this:

  | Fixture (pages)          | tiny-skia | first `vello_cpu` | this     |
  | ------------------------ | --------- | ----------------- | -------- |
  | annual-base (134, sparse) | 39.5 ms  | 332.5 ms          | 34.2 ms  |
  | strokes-fills (25)        | 25.2 ms  | 82.6 ms           | 11.9 ms  |
  | images (14)               | 19.3 ms  | 46.5 ms           | 6.6 ms   |
  | text-wrap (6, dense text) | 199.7 ms | 42.1 ms           | 30.0 ms  |
  | transparency-targets (4)  | 289.3 ms | 144.4 ms          | 142.2 ms |
  | effects (22)              | 298.2 ms | 302.9 ms          | 235.9 ms |
  | column-rules (1)          | 40.5 ms  | 8.2 ms            | 6.7 ms   |

  The sparse-page cost was the composite of the transparent page over the paper: a per-pixel
  loop with a division, 2.3 ms of a 2.5 ms `annual-base` page, against 0.05 ms for recording
  the commands and 0.2 ms for `vello_cpu`'s own pass. Rewritten branch-free it takes 0.5 ms (the
  pass is then bound by memory: 8 MB read and written at 144 dpi), and a plain page (decision
  5) skips it, leaving 0.26 ms a page.

  `vello_cpu`'s multithreading, natively, for the page buffer only (4 and 8 threads):
  `text-wrap` 30 → 20 ms and `transparency-targets` 122 → 93 ms, but `effects` 227 → 261 to
  319 ms, where every effect flushes the page and synchronises the pool, and `annual-base` 35 →
  40 to 48 ms, from a thread pool built per page. It stays off: a win would need a pool kept
  across pages and effects that do not flush, and the editor's wasm has no threads.
- **Editor snapshots** (`snapshot-backends.journey.spec.ts`, 72 dpi, GPU against CPU):
  JOURNEY_TBD

## Consequences

A display command has one meaning, written once. A difference between the lanes is a Vello
CPU/GPU difference, not two independent implementations, and the parity budgets shrink to what
remains: G-2 and the blur approximation.

Edges along the axes land on pixel boundaries in every render, on screen too, as in Acrobat:
a rule keeps at least a pixel at any zoom, and a frame edge does not blur between two columns.
A rule that is in the wrong place reads as more wrong for it, and an edge half a pixel from
InDesign's can round to the other column; both are layout differences, which the gate keeps
measuring.

InDesign's own screen rendering was not measured: the references are Splash renders of
InDesign's PDFs, and this follows Splash.

## Related

- [ADR 100](100-two-rasterisers-one-trait.md): the two rasterizers; this record replaces its
  tiny-skia lane.
- [ADR 146](146-the-gpu-lane-is-held-to-the-cpu-lane.md): the parity lane.
- [ADR 149](149-corners-are-read-per-corner.md): how corners are read.
- [ADR 188](188-snapshots-draw-on-the-worker-gpu.md): the editor's snapshot paths, whose CPU
  path this lane draws.
