# ADR 1034 — Twenty-seven blend modes, defined once

- **Status:** Accepted 2026-10-24.
- **Scope:** protocol v76 (additive; no bump). New crate `paged-blend`; `paged-compose`
  (`BlendMode` is `paged_blend::BlendMode`, `extent::lift_photoshop_fill_blends`, the
  `blend_cpu_composites` work counter); `paged-gpu` (`vcpu.rs`, `vello_rs.rs`, `vello_map.rs`,
  `BlendBake`); `paged-renderer` (`pipeline/shapes.rs`, `pipeline/build_engine.rs`);
  `paged-export-pdf` (`page.rs`, `transparency.rs`, the `blend_mode_rasterized` finding);
  `idml-export` (`effects.rs`); `paged-canvas` (`export_losses.rs`); `paged-introspect` (the
  `BLEND_MODES` vocabulary and the catalog's `blendModes`); `paged-psd` (`effects.rs`,
  `abr/blend.rs`). Outside the engine: paged.image (`compose_ref`, `compose.dissolve`,
  `image-js`'s PSD key maps), plugin-api / plugin-sdk (`BlendModeInfo`, `BLEND_MODES`),
  paged.draw's object model and the editor's Effects panel. Gap I-18 (plan WP3.4, shared
  capability C1).

## Context

The engine drew the sixteen blend modes PDF and InDesign have (ISO 32000 §11.3.5), which are
also the sixteen `peniko::Mix` modes Vello and `vello_cpu` draw. Photoshop has twenty-seven:
those sixteen plus Dissolve, Linear Burn, Darker Color, Linear Dodge (Add), Lighter Color, Vivid
Light, Linear Light, Pin Light, Hard Mix, Subtract and Divide. paged.image already composited
twenty-six of them (all but Dissolve) with WGSL kernels held to scalar reference twins and to
Photoshop-recorded oracle cases. A document that wants Linear Burn on a frame, a PSD layer in
Divide placed in a layout, or the image module's layer modes in the host's Effects panel had no
engine mode to carry them.

And the modes were spelled in a dozen places: the display-list enum, the renderer's IDML string
match, the PDF writer's two name tables, `paged-introspect`'s `BLEND_MODES`, two PSD tables in
`paged-psd` (layer keys from descriptor ids, and the ABR vocabulary), three key tables in
`image-js`, the image module's `compose_ref` enum and formulas, paged.draw's `BLEND_MODES`, the
editor's `blendModes` list and web-render's CSS map. Each had its own order and its own subset.

## Decision

**One definition: `paged-blend`.** A dependency-free engine crate holds `BlendMode` (27 variants;
the sixteen first, in the display list's old order, so the enum's `Debug` and with it the display
list digest of ADR 101 is unchanged for every existing document) and everything that names or
computes a mode:

- the spellings: `name()` (the model's PascalCase, IDML's for the sixteen), `id()` (snake_case,
  paged.image's `compose.<id>`), `display_name()` (Photoshop's English), `psd_key()` (the layer
  record's four characters), `descriptor_id()` / `descriptor_code()` (Photoshop's action
  descriptors, long form and legacy), `pdf_name()`, `idml_name()` (itself or the nearest of the
  sixteen), `css_name()` (`mix-blend-mode`) and `drawingml_name()` (`ST_BlendMode`), each with
  its parser;
- the flags: `is_native()` (one of the sixteen), `needs_backdrop()`, `is_non_separable()`;
- `MENU`, Photoshop's order, and `MENU_GROUPS`, its six separators;
- the scalar formulas (`formulas`, the composite spine `composite`, and Dissolve's
  `composite_dissolve` with its `lowbias32` hash).

`paged_compose::BlendMode` is a re-export, so no display-list user changed spelling. The crate
depends on nothing, so the leaf crates `paged-psd` and the image module's kernel and conformance
crates can use it (the core-ci leaf guard admits it next to `paged-pixel`). The plan's
`paged-kernels` (ADR 1013) is not a prerequisite: the formulas are the scalar half that both the
engine's CPU lane and the image module's reference twins need, and they moved out of
`image_conformance::compose_ref` unchanged — every branch order and tie rule recorded against
Photoshop 2026 stays as measured. `compose_ref` re-exports them, so the image module's 53
Photoshop-recorded compose cases now hold the engine's arithmetic too.

**The model stays a string.** Every blend slot of `paged-model` was already `Option<String>`, and
the property catalog marks them open enums, so the eleven new values are additive: no
`PropertyPath`, no wire type and no protocol version changes. `.paged` keeps them verbatim.
`BLEND_MODES` in `paged-introspect` is computed from `MENU` at compile time, so the catalog's
enum members are the 27 in Photoshop's order, and the catalog gains `blendModes`: one row per
mode with every spelling above, which plugin-sdk exports as `BLEND_MODES` (the type,
`BlendModeInfo`, is in plugin-api). The editor's menus and paged.draw's object model read their
lists there; paged.image's `blend_names()` is `MENU` filtered to the kernels it registers.

**Rendering: the sixteen stay native; the eleven composite against their backdrop.**

- A fill's own blend (`FillPathBlend`) is drawn by the rasterizer's `Mix`, which has only the
  sixteen. The build's last pass before the group fit, `lift_photoshop_fill_blends`, wraps a
  `FillPathBlend` in one of the eleven in a `BeginBlendGroup` of that mode (keeping the glyph-run
  side channel's indices in step), so the eleven only ever travel on groups and layers.
- *`vello_cpu`* (the path of record) composites a group in one of the eleven when it closes: it
  reads the surface the group lands on and applies `paged_blend::composite` (or
  `composite_dissolve`) to each pixel, in the encoded values `vello_cpu` and Photoshop blend in,
  weighted by the target's clip and soft mask. A knockout member does the same over the knockout
  group's initial backdrop.
- *Vello* cannot read a layer's backdrop: a scene is encoded and rasterised in one pass, and a
  layer's content never sees what is under it until its compose. A backdrop-reading compute pass
  would have to split the scene at every such group, render each part to a texture and
  re-enter the encoder with the result, for every nesting level. Instead the GPU lane asks the
  CPU lane: when a list has a group in one of the eleven, `vcpu::rasterize_with_blend_bakes`
  renders the page once and keeps, for each such group, what the surface it composited onto
  holds over its rectangle right after (`BlendBake`). The scene erases that rectangle in the
  layer the group would have drawn into (`Compose::DestOut`, which leaves everything outside it
  alone) and draws the bake there; the group's own commands are skipped. An offscreen render
  bakes at its own resolution, pixel for pixel; the editor's page scenes, built in page points
  and scaled by the camera, bake at 144 ppi. Each bake counts in the `blend_cpu_composites`
  work counter (`perfCounters().blendCpuComposites` in the canvas wasm): the render stat that
  says a page took the CPU composite. A build without the CPU lane (the published viewer's)
  draws the nearest native mode instead.
- *Dissolve* shows the source, opaque, where `dissolve_threshold(x, y, seed)` falls under the
  source's alpha times the group's opacity, and the backdrop elsewhere. `(x, y)` is the device
  pixel; the seed is the group's page-space bounds hashed, because the display list carries no
  element identity, so the same object at the same resolution dissolves identically every time.
  paged.image's `compose.dissolve` kernel computes the same hash in WGSL (seed 0, the canvas's
  one pattern, offset by its dispatch window's origin so a window dissolves as the canvas does).

**PDF.** The sixteen stay live `/BM` graphics states. A group in one of the eleven is drawn as
its bake at `ExportOptions::effect_dpi`: an RGB image XObject with the alpha as its `/SMask`, over
the group's rectangle; the vector content under it stays in the file under the image. The export
reports `blend_mode_rasterized` (a warning) per such group. An effect stamp's own blend never
carries one of the eleven from the editor (its menus offer InDesign's sixteen); one that arrives
another way writes its nearest mode.

**IDML.** Import is unchanged: InDesign writes the sixteen. Export writes `idml_name()` — the mode
itself, or the nearest of the sixteen (Linear Burn → Multiply, Darker Color → Darken, Linear
Dodge → Screen, Lighter Color → Lighten, Vivid/Linear/Pin Light and Hard Mix → Hard Light,
Subtract → Difference, Divide → Color Dodge, Dissolve → Normal) — for every `BlendMode`
attribute it writes, and `idml_export_losses` carries one line per item, target or effect in
one of the eleven, naming the mode, what IDML gets and `.paged`. The line is declared from the
model, as the fill rule's is (ADR 1006).

**PSD.** `paged-psd` resolves a layer effect's `BlnM` and an ABR blend value through
`from_descriptor` (both dialects); the ABR vocabulary is `Layer(paged_blend::BlendMode)` plus its
three texture-only modes. `image-js` maps PSD keys through `from_psd_key`, which now knows
Dissolve's `diss`.

## Evidence

- `crates/paged-blend/tests/blend.rs`: every spelling round-trips, sixteen are native and only
  they have PDF and CSS names, IDML always gets a native mode, the menu groups; the spine;
  Dissolve's determinism and share.
- `crates/paged-gpu/src/vcpu.rs`: the eleven composite by the shared formulas over the backdrop's
  and the source's own renders, within two levels, at 100 % and 60 %; Dissolve dithers
  deterministically; a Photoshop fill blend lifts into a group.
- `crates/paged-gpu/src/vello_rs.rs`: each of the eleven, at two opacities, matches the CPU lane
  on Metal (ADR 146's per-pixel comparison) and counts its CPU composite; so does a Linear Burn
  group inside a Normal and an isolated parent.
- `crates/paged-export-pdf/tests/it/blend_modes_27.rs`: Linear Burn rasterises (an `/Xb` image
  with an `/SMask`, no `/LinearBurn`, the finding); Multiply stays a live `/BM`.
- `crates/idml-export/src/rewrite.rs`: Linear Burn, Dissolve and Divide are written as Multiply,
  Normal and Color Dodge; Screen as itself.
- `crates/paged-canvas/tests/it/blend_modes_27.rs`: `frameBlendMode` and `frameFillBlendMode` set
  a Photoshop mode, the page draws differently, undo restores it; the loss line; `.paged` keeps
  the mode.
- paged.image: `compose_dissolve_parity` and `compose_dissolve_semantics`
  (`image-conformance/tests/it/family_compose.rs`); every existing compose parity and Photoshop
  oracle case, now on `paged-blend`'s formulas.
- The editor: the Effects panel's menu lists 27 in six groups with a marker and note on the
  eleven (`effects-panel` DOM test, `tests/e2e/blend-modes-27.spec.ts`).

All tests named `*__feat__effects_transparency_blend_modes_27` are the evidence of the feature
row `effects-transparency.blend-modes-27`.

## Consequences

- Photoshop's modes work on any page item, on both lanes, in `.paged` and in PDF (as rasters);
  IDML keeps the nearest mode and says so.
- A page with one of the eleven costs one CPU render per scene build on the GPU lane. In the
  editor that is every rebuild of that page's scene; the modes are rare, and the counter makes
  the cost visible.
- Over a backdrop that is neither empty nor opaque inside a parent layer the GPU lane's bake can
  differ slightly from the CPU lane (Vello isolates a parent layer that the CPU lane draws
  through); content in the bleed outside the page box is not baked.
- The editor's page scenes show a bake at 144 ppi, softer than vectors when zoomed far in.
- Follow-ups, outside this record's reach: the plugin scene-layer IR's `SceneBlendMode` (and
  with it web-render's CSS map) carries fifteen modes on the wire — moving it to the 27 is a wire
  change; DrawingML's `blend` readers in the OOXML modules can take `from_drawingml_name`; the
  image module's brush Dissolve dithers by the stroke buffer's pixels, not the canvas's.
