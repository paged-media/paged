# CLAUDE.md

Quick orientation for Claude sessions working on this repo. Covers
mechanics (commands, layout, conventions). This is the **public, open
engine**, at `engine/core` in the monorepo `paged-media/paged` (it was the
`paged-media/core` repository until 2026-10-18).

## What this is

Pixel-faithful Adobe IDML renderer in Rust. A 32-crate workspace (plus three
spikes; `Cargo.toml` lists the members) that parses
IDML packages, lays out text with InDesign-calibrated Knuth-Plass, emits a
versioned display list, rasterises through Vello: `vello_cpu` on the CPU
(default) or Vello on wgpu (GPU), from one mapping. Public APIs target both native and WASM.

```
idml-import → paged-scene → paged-text → paged-compose → paged-gpu
                                              ↘ paged-renderer (top)
                                                   ↘ paged-fidelity (diff)
```

**Engine/app split.** This repo is the open engine, dual-licensed
**AGPL-3.0-only OR PMEL** like the rest of the monorepo (ADR PM-0001;
every source file carries the AGPL/PMEL header; new files must too — copy
from any `crates/**/*.rs`). The editor (`apps/editor` in the same
repository, under the same licence) consumes the engine's wasm as workspace
packages (`packages/canvas-wasm`, ADR 185) across a package
boundary — there is **no Cargo path dependency** from the editor into this
code. Design documents,
decision records and status live in `docs/` (proposals and the ADR register
stay in a private notes repo); the full Envato
fidelity corpus lives in the private `paged-media/corpus` repo.

## Common commands

```bash
# Build / typecheck
cargo build --workspace
cargo check --workspace --all-targets

# Tests
moon run core:test                        # everything: fixtures, nextest, doctests
cargo test --workspace                    # the same without Moon (after scripts/regen-fixtures.sh)
cargo test -p paged-fidelity              # diff-harness unit + CLI

# Render a sample
cargo run --release --bin paged-inspect -- \
  --render /tmp/out corpus/generated/<name>.idml

# Diff harness (positional: REFERENCE then CANDIDATE)
cargo run --release -p paged-fidelity --bin paged-diff -- \
  --json --heatmap heat.png ref.png cand.png

# Hard fidelity gate over corpus/generated/*.idml + *.pdf
./corpus/generated/diff.sh
# Requires pdftoppm (poppler-utils): `brew install poppler` on macOS.

# Lint + dependency-license audit
cargo clippy --workspace --all-targets -- -D warnings
cargo deny check                          # licenses + advisories + sources
```

`cargo fmt --all` **is** clean across the workspace — keep it that way. CI
gates it (`ci.yml`'s `fmt` step), so an unformatted file fails the build.

This rule used to say the opposite ("do not run it, it drifts ~1000 lines on
unrelated files"), and everyone hand-formatted single files to work around it.
The claim decayed: by 2026-07-26 the real drift was 9 files / 68 hunks, while
the fmt step had been failing on EVERY run of `main` for weeks — so core's CI
carried a permanently-red gate nobody could act on, which is precisely how the
nextest evidence artifacts went unnoticed for a month. The 9 files were
formatted in one mechanical pass; the workaround is retired.

`Cargo.lock` **is** tracked here (reproducible public build).

## Layout

- `crates/idml-import/` / `crates/idml-export/` — the IDML reader and
  writer (ADR 022's adapter). Ordinary workspace members: every crate here
  that uses them names them by path, and `modules/publish` (pdf-import)
  path-depends on `idml-import` and the model crates, so an IDML change and
  its callers land in one commit. `crates/idml-coverage/` is the static
  inventory of both (`cargo run -p idml-coverage >
docs/reference/idml-coverage.json`; its tests fail when the committed file
  or the ratchet `docs/reference/idml-coverage-ratchet.json` is stale).
- `crates/paged-scene/` — `Document::open`. Resolves cascade,
  `frame_for_story`, `text_frame_index`, `frame_chain` (threading).
- `crates/paged-text/` — `shape_run`, `compose_paragraph`,
  `layout_paragraph` / `layout_runs` (multi-font). Knuth-Plass +
  hyphenation. `apply_tab_stops`.
- `crates/paged-compose/` — display list, `Transform::for_rect_in`, glyph
  cache, gradient/image pools.
- `crates/paged-gpu/` — `PathRasterizer` trait. CPU (`vello_cpu`, default) +
  Vello on wgpu, sharing `vello_map.rs` (paths, paints, blends, strokes).
- `crates/paged-renderer/` — top-level `pipeline::build` / `render`.
  `StoryEmitter` per-story state. `paged-inspect` CLI.
- `crates/paged-color/` — the CMS: lcms2 on native, qcms (pure Rust) on wasm32; the naive
  CMYK conversion is the fallback on both when no CMYK profile is configured.
- `crates/paged-raster/` — raster probe/decode/encode (ADR 1005): TIFF through `tiff`,
  PSD/PSB merged composites through paged-psd, EPS previews, DNG (a default develop), AVIF
  (rav1d) and JPEG XL (jxl-oxide) behind default features, the web and small formats through
  `image`; CMYK/Lab through paged-color. The renderer and paged-gpu's wasm32 raster-time decode both call
  `decode_rgba8`.
- `crates/paged-ps/` — a clean-room PostScript Level 2 interpreter for placed EPS (ADR 1033):
  `interpret` returns the art (fills, strokes, clips, images, gradients) in default user
  space; the renderer's `pipeline/placed_eps.rs` lays it into the display list. Geometry on
  kurbo, decode filters from `paged-raster::filters`, colour maths from `paged-color::math`.
- `crates/paged-geom/` — the path kernels (outline stroke, offset, simplify, the
  Pathfinder booleans, the planar arrangement, the `PathAnchor` ↔ kurbo/flo_curves
  converters), moved out of `paged-mutate` (which re-exports each module under its
  old path) so the renderer reaches them (plan C8, ADR 1042).
  `crates/paged-vector-fx/` — live vector effects (ADR 1042): the stack's vector
  entries run on an item's source outline, cached by hash; `bake` is the item the
  renderer draws, IDML export writes and `expandAppearance` keeps.
- `crates/paged-psd/` — PSD/PSB model, parser, preservation writer, composite decode,
  layer records (also of a layered TIFF's tag 37724). `crates/paged-pixel/` — the frozen
  pixel types (`PixelFormat`, tiles, regions). Both moved from paged.image (PM-0014,
  image ADR 466), which still names them `image-psd` / `image-core` through `package`
  aliases; they stay leaf crates (a core-ci `cargo tree` guard).
- `crates/paged-resample/` — the CPU resample of RGBA8 rasters (separable Lanczos-3 /
  bilinear, premultiplied; a bilinear rotate-and-crop): the supported backend of paged.image's
  headless and batch actions (image ADR 467). A leaf crate, under the same guard.
- `crates/paged-fidelity/` — ΔE2000 + SSIM diff library + `paged-diff` CLI.
  Reference is positional arg #1, candidate #2.
- `crates/paged-mutate/`, `paged-introspect/`, `paged-canvas/`,
  `paged-script/` — mutation ops, scene/property introspection, the
  interactive canvas model, and the embedded `paged.*` scripting API. These
  back the editor; `paged-canvas-wasm` / `paged-introspect-wasm` are the
  wasm-bindgen surfaces it consumes.
- `crates/paged-wire/` — the wire VOCABULARY: the identities (`PageId`,
  `ElementId`, `TextCellAddr`, `ByteBuf`) and the 148 `Mutation` ops, in one
  place so the CLI, the wasm wire, the Boa bridge, the plugin host and the
  editor speak one spelling. **Two halves, and the split is load-bearing:**
  the operations need `paged-mutate` for their payload types, the identities
  need nothing, and `paged-renderer` wants only `PageId`. So `mutations` is a
  DEFAULT FEATURE with `paged-mutate` optional behind it, and `paged-renderer`
  takes the crate `default-features = false` — otherwise the read-only
  `paged-sdk` links the mutation engine transitively, which the publish
  workflow's subset audit stops (it did, on v0.63.0). Check the off path with
  `cargo check -p paged-renderer` alone; a `--workspace` build unifies features
  and never compiles it.
  A third, off-by-default feature, `schema`, derives `schemars::JsonSchema`
  next to every `Tsify` derive `Mutation` reaches and writes the committed
  `crates/paged-wire/schema/mutation.schema.json` (ADR 187; the plugin SDK's
  typed core commands are generated from it). After changing a type the wire
  carries: `cargo run -p paged-wire --features schema --example emit-schema >
crates/paged-wire/schema/mutation.schema.json`; `cargo test -p paged-wire
--features schema` checks it is current and agrees with tsify.
- `crates/paged-data-*/` — paged.data's engine crates (PM-0015): the types and
  function registry (`paged-data-core`, rows in `functions/`), the binding language
  (`-expr`), query shaping, sync (`-bind`), lowering, barcodes, data sets, sources, the
  Turso store and its file readers (`-store`, data ADR 561), XLSX, batch planning, and the
  session that joins them with the reader of a document's binding labels (`-session`,
  ADR 1014). Library
  names stay `data_*`. Their docs and ADRs stay in `modules/data` (its CLAUDE.md governs
  them), as do their test fixtures (`modules/data/conformance`) and the wasm surface
  (`data-js`). `paged-data-expr` must not reach the sync, query, lowering or store crates
  (core / ci guard).
- `crates/paged-action/` — actions (ADR 1015): the registry, chains, the content-addressed
  cache key the SDK's `actions@1` shares (`tests/keys.json`), and JS actions in a bare Boa
  context with a fixed clock. Data transforms (data ADR 562) and paged.data's build scripts run
  on it; `paged-script` exposes it as `paged.actions.*`.
- `crates/paged-gen/` — IDML fixture generator (the `paged-gen` bin).
- `crates/paged-sdk/` — published SDK wasm surface: a WebGPU
  `ViewerSession` (load IDML → present to OffscreenCanvas/Canvas via
  Vello → headless RGBA readback); npm `@paged-media/viewer/session`
  (the `./session` entry, PM-0008; built into `web/idml-viewer/wasm/`). WebGPU-only
  (no CPU page rasterizer); see `crates/paged-sdk/WEBGPU.md`.
- `corpus/generated/` — license-clear generator fixtures (IDML + paired
  InDesign-exported PDF + meta JSON). Hard fidelity gate runs over these via
  `diff.sh` + `fidelity-thresholds.json`.
- `corpus/fonts/` — license-clear TTFs. `corpus/seeds/` — golden snapshot.
  `corpus/generated-fixtures/`, `corpus/calibration/` — more fixtures.
- `tools/indesign-export/` — drives InDesign to export the reference PDFs
  the fidelity harness consumes (Python/ExtendScript; outside the Cargo
  workspace, so core is polyglot — CI must not assume everything is Cargo).
- `spikes/` — Vello eval, composer calibration, WASM size.

## Conventions worth remembering

- **Don't loosen fidelity thresholds to make a failure go away.** The
  per-fixture thresholds in `corpus/generated/fidelity-thresholds.json` are
  sized to current measurements + ~15–25% headroom. If a regression trips
  them, fix the regression. Tighten _after_ fixing, never before.
- **CPU backend for headless / CI.** Vello on wgpu requires a GPU; the CI
  fidelity gate uses `vello_cpu`.
- **Reference PDFs are baked.** If a fixture's reference PDF was exported on
  a host without the IDML's declared font, InDesign falls back to its
  bundled serif and the PDF carries that serif baked in. Either re-export on
  a host with the font, or substitute in the renderer to match — pick one
  consciously and document it in the per-fixture `*.fonts.sh`.
- **Path: `subpath_starts` for compound paths.** A Polygon / TextFrame /
  GraphicLine with multiple `<GeometryPathType>` children must record
  per-contour boundaries, or the renderer joins contours into one polyline
  and silently mis-renders holes.
- **Per-paragraph state on `StoryEmitter`.** Vertical-justify distribute
  mode, numbering counter, frame-chain bookkeeping, and per-frame paragraph
  command ranges all live on `StoryEmitter` — add new per-story state there.
- **Keep the format/project naming line.** `idml` as the _project_ prefix
  was renamed to `paged`; `idml` as the _format_ (`.idml`, `idml_bytes`,
  "parses IDML", `designmap`, the `idml-package` mimetype) is kept. Don't
  blanket-rename across that line.
- **Comments earn their place.** Add one when the WHY is non-obvious (a
  hidden IDML constraint, a rasterizer invariant, an upstream-bug
  workaround). Otherwise let the code speak.
