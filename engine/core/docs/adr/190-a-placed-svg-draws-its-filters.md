# ADR 190 — A placed SVG draws its filters

- **Status:** Accepted 2026-10-19.
- **Scope:**
  - `crates/paged-gpu`: `svg_filter.rs` (new: the filter graph and its seventeen primitives),
    `svg.rs` (a filtered group, straight-alpha gradients, pattern tiles on whole pixels),
    `blur.rs` (new: the Gaussian kernels of `vcpu.rs`, moved, and the box blur);
    `tests/it/svg_reference.rs` (new).
  - `corpus/generated-fixtures/svg/`: eighteen SVG fixtures, their `resvg` renders and
    `svg-reference.json`.
  - `crates/paged-gen`: the `svg-filters` sample.
  - `corpus/generated/parity-diff.sh` and `parity-thresholds.json` (`parity_only` fixtures).
  - No model, wire or protocol change, and no new dependency.

## Context

[ADR 189](189-one-rendering-model.md) took `resvg`, and with it tiny-skia, out of the engine.
`usvg` still parses a placed SVG, and `paged_gpu::svg` draws the tree with `vello_cpu`, but a
group with a filter was drawn without it. `resvg` had applied SVG filters, so every placed SVG
with a blur, a drop shadow or a colour matrix lost it. No fixture held an SVG, so no gate saw it.

Where a placed SVG is drawn decides where its filters can run. `decode_svg_bytes`
(`paged-renderer`, `pipeline/image_decode.rs`) draws the SVG once, when the document is built,
at one pixel per user unit (the longest edge at most 4096), into a `DecodedImage`. The display
list holds an image command for those pixels, and both lanes draw it the way they draw a
photograph: `vello_cpu` on the CPU, Vello on the GPU (in the editor and the viewer too, which
decode SVGs eagerly on wasm32), and the PDF export embeds it. Nothing of the SVG reaches the
display list as vectors.

## Decision

1. **Filters run where the SVG is drawn, once, on the CPU.** A filtered group is drawn into a
   layer of its own over its filter region, each of its filters runs over that layer, and the
   result is composited like any other isolated group (opacity, blend mode, clip path, mask).
   Both lanes and the PDF export then draw the same filtered pixels; the GPU lane gains SVG
   filters without a line of its own.

   The display list's effect layers are not used for them. The SVG is not in the display list
   as vectors to put a layer around; the GPU lane's Gaussian is a 7 × 7-tap replay of the layer
   (`vello_rs.rs`), which would reopen the parity gap ADR 189 closed; and most primitives
   (colour matrix, component transfer, turbulence, lighting, displacement) have nothing in the
   display list to map onto. What the effects pipeline has, its blur, is shared: the exact
   Gaussian kernel and its separable pass moved from `vcpu.rs` to `blur.rs`, unchanged, and
   the SVG filters call them.

2. **The filter graph follows the Filter Effects specification**, with `resvg`'s pixel
   geometry where the specification leaves it open:
   - The layer and the filter region are whole device pixels, the origin floored and the size
     rounded up, as `resvg` sizes them; a primitive's result is cleared outside its subregion.
     The layer reaches at most a quarter of the canvas past each edge, so a region that names
     the whole plane does not allocate it (`resvg` allowed twice the canvas).
   - Every image is premultiplied RGBA8 over the layer and carries its colour space. A
     primitive converts its inputs into its `color-interpolation-filters` space (linearRGB by
     default) through 8-bit tables, and the result goes back to sRGB. A result is dropped after
     the last primitive that reads it.
   - All seventeen primitives apply: `feGaussianBlur`, `feOffset`, `feFlood`, `feComposite`
     (the five Porter-Duff operators and arithmetic), `feMerge`, `feBlend` (all sixteen modes),
     `feDropShadow`, `feColorMatrix`, `feComponentTransfer`, `feMorphology`, `feTurbulence`
     (the specification's reference noise), `feDisplacementMap`, `feConvolveMatrix`,
     `feDiffuseLighting`, `feSpecularLighting` (distant, point and spot lights), `feTile` and
     `feImage`.

3. **Blur**, per axis: below σ = 4 device pixels the exact Gaussian of the effects pipeline
   (truncated at 3σ), reading transparent black beyond the layer; from 4 px up, five box blurs
   whose variances add up to σ² (Kovesi), linear in σ. The specification allows any
   approximation and describes three boxes. Measured against the exact Gaussian on the `blur`
   fixture with boxes from σ = 2 (`resvg`'s threshold), five boxes came to a mean ΔE of 0.217,
   three to 0.347 and `resvg` to 0.341; below 4 px the boxes' whole-pixel widths miss σ² by up
   to a sixth, so the exact kernel takes those.

4. **Where the engine departs from `resvg`.** Each was checked against Chrome 155 (headless, at
   1×) and librsvg 2.62, measured the same way as the reference lane:
   - `feDisplacementMap` displaces by `scale · (C − ½)`. `resvg` multiplies by the scale twice,
     and its art leaves the canvas.
   - `feTile` keeps its input's colour space. `resvg` marks the result sRGB, so a linearRGB
     tile comes out dark.
   - `lighting-color` is an sRGB colour taken into the filter's space, as Chrome does; `resvg`
     and librsvg use it as if it were linear, and their light is paler.
   - `feMorphology`'s window is `2r + 1` pixels wide (r rounded up), as browsers and librsvg
     have it. `resvg` follows the specification's text, `2r`, a pixel narrower and off-centre.
   - A filter works in its group's own axes. Under a rotation or a skew the layer is laid out
     along the group's axes at the device resolution and drawn back through the rest of the
     transform, resampled; Chrome does the same. `resvg` and librsvg filter in device space,
     so a rotated group's flood stays upright. An axis-aligned group is filtered in device
     pixels and placed back pixel for pixel, as before.
   - `feImage` that names an element draws it offset by the primitive's subregion, as `resvg`
     does; Chrome draws nothing and librsvg draws it in place.

5. **Two fixes outside the filters**, found by the same fixtures:
   - SVG gradients interpolate their stops straight (unpremultiplied), as `resvg` and browsers
     do. `vello_cpu`'s default interpolates premultiplied, which shifted every stop with an
     opacity (`gradients`: mean ΔE 0.950 → 0.188).
   - A pattern tile that lands on whole device pixels is sampled nearest, as tiny-skia does;
     bicubic sampling at pixel centres softened it (`clip-mask`: 0.269 → 0.100).

6. **A placed SVG is still a raster, at one pixel per user unit.** It is not drawn as vectors at
   any zoom: the GPU lane, the editor's canvas at 400 % and the fidelity gate at 144 dpi all
   scale the decoded pixels. Drawing it as vectors means emitting its tree into the display
   list, as a placed PDF is ([ADR 154](154-a-placed-pdf-is-drawn-from-its-own-operations.md)),
   with filtered groups still drawn as rasters at a resolution the build does not know;
   decoding it at a higher resolution means giving `DecodedImage` a size in points apart from
   its pixel size and paying the pixels (four times the memory at 2×, on wasm32 where SVGs are
   decoded eagerly, and in every exported PDF). Neither is a small change; both are left to a
   record of their own.

7. **SVG text stays undrawn**, as before. `usvg` is built without its `text` feature (ADR 189:
   0.9 MB in every engine wasm), so it drops `<text>` when it parses; the `resvg` build had no
   font database either.

## Evidence

Measured on an Apple M3 Max (Metal), 2026-10-19, on the shared machine under load.

- **Against `resvg`** (`tests/it/svg_reference.rs`, every fixture at one pixel per user unit,
  over white, mean / p99 ΔE2000; Chrome and librsvg measured the same way):

  | Fixture            | before (no filters) | this           | Chrome: `resvg` | Chrome: this  | Chrome: librsvg |
  | ------------------ | ------------------- | -------------- | --------------- | ------------- | --------------- |
  | blend              | 12.148 / 47.39      | 0.243 / 6.85   | 0.281 / 6.78    | 0.168 / 3.48  | 0.279 / 6.12    |
  | blur               | 4.168 / 29.74       | 0.299 / 2.46   | 0.426 / 2.42    | 0.439 / 2.22  | 0.300 / 6.85    |
  | clip-mask          | 0.269 / 4.53        | 0.100 / 1.90   | 0.098 / 1.40    | 0.123 / 1.42  | 0.993 / 49.83   |
  | color-matrix       | 21.767 / 76.49      | 0.233 / 1.84   | 0.205 / 1.30    | 0.213 / 1.66  | 0.175 / 1.30    |
  | component-transfer | 19.155 / 97.81      | 0.137 / 0.96   | 0.126 / 0.90    | 0.165 / 0.89  | 0.150 / 0.94    |
  | composite          | 6.678 / 43.02       | 0.023 / 0.45   | 0.100 / 0.93    | 0.089 / 0.93  | 0.027 / 0.72    |
  | convolve           | 8.874 / 72.06       | 0.340 / 10.88  | 0.237 / 6.63    | 0.360 / 10.67 | 0.202 / 5.64    |
  | displacement       | 11.964 / 57.33      | 12.026 / 57.33 | 12.151 / 57.33  | 0.683 / 31.75 | 0.872 / 34.46   |
  | drop-shadow        | 2.184 / 30.29       | 0.200 / 3.28   | 0.194 / 3.42    | 0.144 / 2.95  | 0.118 / 3.56    |
  | gradients          | 0.950 / 15.23       | 0.188 / 3.55   | 0.154 / 2.27    | 0.169 / 1.83  | 0.152 / 2.35    |
  | lighting-color     | 53.887 / 100.00     | 4.590 / 12.60  | 4.581 / 12.60   | 0.081 / 0.87  | 4.581 / 12.60   |
  | lighting           | 38.758 / 100.00     | 0.212 / 3.22   | 0.188 / 3.53    | 0.144 / 2.82  | 0.105 / 1.72    |
  | merge              | 7.556 / 50.48       | 0.118 / 2.80   | 0.106 / 1.43    | 0.091 / 1.85  | 0.177 / 2.32    |
  | morphology         | 6.760 / 78.78       | 1.732 / 43.25  | 1.662 / 42.46   | 0.225 / 5.71  | 0.188 / 3.79    |
  | text               | 0.114 / 0.00        | 0.007 / 0.00   | 4.108 / 71.02   | 4.105 / 71.02 | 0.686 / 15.11   |
  | tile               | 26.669 / 93.80      | 3.926 / 25.81  | 3.916 / 25.81   | 0.040 / 1.90  | 0.071 / 2.19    |
  | transformed        | 5.616 / 69.60       | 1.069 / 29.05  | 1.177 / 29.05   | 0.347 / 3.02  | 1.268 / 29.05   |
  | turbulence         | 44.175 / 97.46      | 0.151 / 1.39   | 3.330 / 24.39   | 3.313 / 24.44 | 3.319 / 24.47   |

  Before this change every filtered fixture was off by a mean of 2 to 54 (the filters were
  missing). Now thirteen fixtures are within 0.35 of `resvg`; the five where `resvg` misreads the
  specification (decision 4) are as far from it as it is from Chrome, while the engine is within
  0.7 of Chrome on each. `turbulence` is within 0.15 of `resvg` and librsvg and 3.3 of Chrome,
  which samples the noise at pixel centres. `text` is a white page with two rectangles in all
  three engines without fonts; Chrome sets the text.
  `svg-reference.json` budgets each at its measurement plus 20 %.

- **Parity** (`parity-diff.sh svg-filters`, the eighteen fixtures on four pages, page 4 at 200 %,
  50 % and rotated 20°): worst page mean ΔE 0.051, within the default 0.2 budget. Both lanes
  draw the same pixels; what differs is how each samples them at 144 dpi.
- **Every other lane is unchanged**: on this tree against main at the same commit, `diff.sh`
  passes 101 of 101 fixtures with every page's report identical; `text-diff.sh` 94 of 94, the
  same lines; `export-diff.sh` (Ghostscript CMYK profile, as CI) 654 of 654 pages and the same
  numbers, plus the four `svg-filters` pages (worst mean ΔE 0.272); `parity-diff.sh` 101 of 101
  as before, plus `svg-filters`. Every CPU page render of the parity lane (660 pages) is
  byte-identical, so ink coverage is too; 77 Vello pages differ by at most 0.000008 in mean ΔE,
  the GPU's run-to-run noise. `cargo nextest --workspace` passes.
- **Speed.** Drawn at 8× (1920 × 1280), the engine against `resvg`: `blur` 87 ms (75),
  `drop-shadow` 125 ms (755), `turbulence` 147 ms (189), `lighting` 83 ms (75), `morphology`
  111 ms (1,339), `convolve` 30 ms (34), `tile` 9 ms (18), `displacement` 44 ms (68). Separable
  morphology and box blurs keep large radii linear.
- **Size** (`scripts/build-wasm-packages.sh`, against main at the same commit): `paged_canvas_wasm_bg.wasm` 28,778,611 → 28,819,200 bytes
  (+40,589), the viewer's `paged_sdk_bg.wasm` 11,519,215 → 11,561,905 (+42,690). No module
  links the engine's renderer, so the app-wide budget (100 MB, `wasm-budget.mjs`) grows by the
  canvas-wasm delta alone, 0.04 MB.

## Consequences

A placed SVG with a filter looks as it did before ADR 189, and as Chrome draws it where `resvg`
did not. The two lanes cannot disagree about a filter, because neither runs one: both draw what
the decoder filtered.

The reference lane holds the CPU lane to `resvg`'s renders, which are committed and do not
change; a change that moves a fixture past its budget is a change to how placed SVGs look.

The filters cost CPU time when a document is built, once per placed SVG, and nothing at render
time. A placed SVG stays a raster at one pixel per user unit (decision 6).

## Related

- [ADR 189](189-one-rendering-model.md): the SVG renderer this extends; its decision 8 said
  filters were not applied.
- [ADR 104](104-effects-follow-indesign-parameters.md): the effects pipeline whose blur is shared.
- [ADR 146](146-the-gpu-lane-is-held-to-the-cpu-lane.md): the parity lane, which now runs
  fixtures without an InDesign reference too.
- [ADR 154](154-a-placed-pdf-is-drawn-from-its-own-operations.md): a placed PDF, drawn as
  vectors.
