# ADR PM-0014 — A capability lives at the lowest layer every consumer can reach

- **Status:** Accepted 2026-10-24.
- **Amends:** [PM-0002](PM-0002-built-ins-and-extensions.md) (its consequence that merging the
  image codecs with the engine's decoders "is left for later" is decided here).
- **Scope:** `engine/core` (model, renderer and `crates/paged-*`), `modules/*` (their Rust
  dependencies on the engine), `apps/editor` (host tools and panels), `platform/extensions` (the
  doors a module reaches the lower layers through). Component records that follow from it:
  image ADR 466, draw ADR 361.

## Context

The built-in modules lower to native page items: doc, slide, sheet, data and publish build
frames, paths, stories and image frames. Whatever the engine models natively is drawn in every
module's output, exported to PDF and edited by the host's panels; whatever a module models on
its own is drawn only where that module runs.

Several capabilities exist twice or in the wrong place:
- **Raster.** The engine decodes TIFF through the `image` crate and loses ICC, CMYK and 16-bit;
  a placed PSD does not decode. The image module has a dependency-free PSD reader
  (`image-psd`), its own codecs and its own colour wrapper (`image-cms`) beside the engine's
  (`paged-color`).
- **Kernels.** The image module's kernels (blend modes, adjustments, convolutions) have one
  definition with CPU twins (image ADRs 451, 465); the engine's effects have their own code.
- **Vector constructs.** paged.draw builds live effects, multi-paint appearances and symbols as
  recipes plus baked artwork (draw ADRs 354, 356), so they are live only in the draw module.

The image module's isolation contract forbade any engine dependency, a rule from the time it was
a separate repository. doc ADR 606 and slide ADR 708 already let those modules path-depend on
the engine's model crates.

## Decision

A capability lives at the lowest layer that every one of its consumers can reach.

| Layer | What lives here | Who benefits |
|---|---|---|
| **L1 Engine model + render** (`engine/core`) | Anything visible on a page item: paints, fill rule, the effect stack, blend modes, live vector effects, multi-fill and multi-stroke appearance, clip groups, image filter stacks on image frames, symbols, mesh and freeform gradients, page placement | Every module's output, the host panels, PDF/IDML/SVG export, the headless host and the CLI |
| **L2 Engine shared crates** (`engine/core/crates/paged-*`: pure Rust, wasm-safe) | Codecs, PSD, colour, kernels (one definition: CPU reference and WGSL), warp and mesh math, vector-effect geometry, SVG import and export | The renderer, export, and the Rust halves of image, draw, slide, doc and sheet |
| **L3 Host** (`apps/editor`) | Tools and panels that act on any page item or edit context: free transform, history, effects and appearance, gradient, transparency, align, info, navigator, view modes, asset export, the clipboard, the ML service | Every module's edit context |
| **L4 Module** (`modules/*`) | Domain workflows: pixel editing (image), path construction (draw), the native lowering of each format (doc, slide, sheet) | That module |

- **A module may path-depend on `engine/core` crates** for L1 and L2 capabilities, as doc
  (ADR 606) and slide (ADR 708) already do. The dependency is a `path` dependency on
  `engine/core/crates`, built from the same revision; never a published canary, never a git pin.
- **Extensions stay on the contract** (PM-0002 unchanged): a community extension reaches L1–L3
  only through doors in plugin-sdk, each announced by `supports("…@1")`. Where a built-in needs
  an L1–L3 service from TypeScript it uses the same doors.
- **Moving a capability down keeps its history.** A crate that moves from a module into
  `engine/core/crates` moves with `git mv`, keeps its licence and its tests, and keeps its old
  crate name in the module through a `package = "…"` alias until a mechanical rename.
- **Guards move with the crate.** A `cargo tree` guard a module ran on a moved crate runs in the
  engine's CI with the same invariant.

## Planned crates

Planned, not yet built; each lands with its own engine record.

| Crate | Content | Origin |
|---|---|---|
| `paged-raster` | One raster type and the codec matrix: TIFF (through `tiff`), PNG, JPEG, WebP, GIF, BMP, the PSD composite, later AVIF, JXL, DNG and the EPS preview; ICC and metadata kept | new; adapters from `image-codecs` |
| `paged-psd` | PSD/PSB model, parser, preservation writer and layer parser | moved from `modules/image/image-psd` |
| `paged-pixel` | The pixel types: format, tiles, regions | moved from `modules/image/image-core` |
| `paged-kernels` | One kernel definition for engine and image: the WGSL ABI and the CPU twins | moved from `modules/image/image-kernels` |
| `paged-warp` | Homography, envelope mesh, puppet mesh, displacement fields, perspective grid | new |
| `paged-vector-fx` | Live vector effect geometry, brushes along a path, variable-width strokes | new; geometry ported from `draw-geometry` |
| `paged-svg` | SVG import to native items and display-list export to SVG | new |
| `paged-ps` | PostScript and EPS interpretation | new |

`paged-color` gains the `image-cms` backends rather than a second colour crate.

## Reserved records

The numbers are reserved for the records this layering needs; each is written when its work
starts.

| ADR | Topic |
|---|---|
| core 1005 | `paged-raster` and the codec matrix; the renderer decodes through it; TIFF through `tiff` |
| core 1006 | The fill rule is a native property (even-odd) |
| core 1007 | Paint model v2: opacity stops, inline-colour stops, conic, gradient on a stroke; pattern and mesh/freeform paints |
| core 1008 | An ordered effect stack and a native image filter stack; IDML exports InDesign's set natively, the rest baked or reported |
| core 1009 | Live vector effects and native appearance (multi-fill and multi-stroke); IDML export bakes the geometry |
| core 1010 | Clip groups and paste-into of groups |
| core 1011 | Free page placement (artboards) |
| core 1012 | A symbol instance node |
| core 1013 | `paged-kernels` shared by engine and image (amends image ADRs 450, 451, 465) |
| editor 284–290 | Free transform; the history panel; host appearance and effects; view modes; asset export; the vector clipboard; the ML service |
| extensions 338–342 | The new doors: render snapshot v2, the undo log, overlay handles and the transform box, the SVG clipboard, colour bindings, ML, asset rasterisation |
| image 466 | The isolation contract amended: the engine's raster crates are shared |
| draw 361 | Visual live constructs move to the engine; recipes remain for generators |

**Block reserved for this plan (added 2026-10-25).** Other work takes the engine numbers after the
last one in use, so the plan's own engine records come from a reserved block: **1030–1059**.
Assigned so far: 1030 the named undo timeline, 1031 SVG through `paged-svg`, 1032 one colour API,
1033 PostScript/EPS through `paged-ps`, 1034 the 27 blend modes defined once.

## Consequences

- A feature made engine-native appears in every module's output and export at once; the
  module that first needed it keeps only its workflow.
- The image module's "zero core contact" holds for TypeScript (the contract only) and no longer
  for Rust (image ADR 466). PM-0002's open question on the image codecs is closed: they merge
  with the engine's decoders in `paged-raster`.
- A module that depends on an engine crate builds after the engine (`dependsOn: [core]` in its
  `moon.yml`), and an engine crate's change runs that module's gates.
- An engine-native construct that IDML cannot carry is exported baked or reported as a loss,
  never dropped silently.

## Amendment — 2026-10-25: DrawingML geometry is a shared crate

The DrawingML preset geometry moves from paged.slide to `platform/shared/dml-geom` (slide
ADR 717). Its consumers are modules (slide now, doc's shapes next), not the engine: the engine's
model carries the outlines it draws, while the preset programs, adjust handles and connection
sites are DrawingML's. So the lowest layer every consumer reaches is the shared platform code,
not L2. It is its own Cargo workspace, a path dependency of the modules, and it keeps its old
name in the slide workspace through a `package = "dml-geom"` alias, as this record asks of a
moved crate. Adjust handles use `contribute.overlay` until the overlay-handles door (extensions
340) lands.
