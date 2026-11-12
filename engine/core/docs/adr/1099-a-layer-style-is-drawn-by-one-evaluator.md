# ADR 1099 — A layer style is drawn by one evaluator, from the effect stack

- **Status:** Accepted 2026-11-12.
- **Scope:** `paged-model` (`layer_style`: the layer-style parameters; `effect_stack`: the
  `LayerStyle` convention, the `patternOverlay` kind, further instances, `with_params`,
  `carry_layer_style`, the IDML label); the new crate `paged-layer-fx` (the evaluator, its plan,
  its CPU device and the contour and ramp lookup tables); `paged-kernels` (the `style` and `gen`
  families and the compose twin, moved from paged.image, their twins shipped under `cpu`);
  `paged-psd-fx` (the lossless map both ways, `unmap_layer_style`, and `place`, a PSD's layers as
  frames); `paged-psd` (`presets::read_psd_patterns`, `layer_pixels::fill_opacity`; the contour and
  gradient lookup tables moved out); `paged-renderer` (`module::layer_style`); `paged-mutate` (the
  wire kind `patternOverlay`, the stack write's carry); `paged-canvas` (`psd_io`,
  `RequestPsdLayersPlace`); `paged-cli` (`paged place --layers`); paged.image (`layers::styles`,
  `fold`, `fold::cpu`, `fold::tiled`, the Layer menu's Place Layers as Frames); the extension
  contract (`document.placePsdLayers@1`). Amends [ADR 1008](1008-an-items-effects-are-an-ordered-stack.md)
  and [ADR 1044](1044-a-photoshop-layer-style-maps-onto-the-effect-stack.md); settles the open item
  [ADR 1037](1037-an-image-frame-has-a-filter-stack.md)'s second amendment left for layer styles
  (plan P3.6).

## Context

A layer style was drawn twice. paged.image drew Photoshop's layer styles with its own plan and
kernel dispatches (`image-js` `layers/styles.rs` over the `style.*` kernels of `image-kernels`),
measured against Photoshop 27.10 by 66 recorded files (`image-conformance`'s `psd_layer_styles`:
each file's composite against Photoshop's own, a recorded max and mean per file). The engine drew
its effect stack (ADR 1008) with InDesign's parameters and falloffs, as display-list commands the
rasterisers (Vello, `vello_cpu`) and the PDF writer draw from coverage masks
(`paged_compose::mask`). ADR 1044 mapped a Photoshop style onto the stack, but with losses (a
contour, a glow's range and gradient, a gradient overlay's shape, opacity stops, pattern fills, a
second drop shadow, eleven blend modes) and no consumer: nothing placed a PSD layer as a page item.

The layer-style move was deferred for two reasons: the engine's effects are display-list commands
drawn by `paged-gpu`, and the image wasm carries no engine raster evaluator of the effect stack; and
the engine's effects take InDesign's parameters, so the Photoshop-measured goldens would move.

## Decision

**The effect stack is the superset.** Every parameter a layer style has becomes an optional field
of the stack's effects, absent on everything InDesign wrote (`paged_model::layer_style`): a
contour on the shadows, glows and satin (its anti-aliasing switch kept), a glow's range, jitter and
gradient ramp, the drop shadow's polar angle and distance, the bevel's gloss contour and its Contour
and Texture panes, a gradient overlay's whole fill (ramp with separate opacity stops and
smoothness, shape, angle, scale, offset, alignment, dither), a stroke's colour, gradient or pattern
fill, and a new stack-only kind `patternOverlay` (a raster pattern, its tile carried when the item
has no pattern table). All 27 blend modes by the model's spelling. A layer style may cast several
drop and inner shadows: the first instance is the slot's, a further one is an entry carrying its own
parameters (a bare duplicate is still refused). An entry says it is a layer style's with
`EffectEntry::convention = LayerStyle`; such an entry is never canonical, so its stack is stored,
and the IDML label carries the slot's layer-style fields with it. A stack write through the wire
form (which has no fields for them) keeps them from the entry it replaces (`carry_layer_style`).
Nothing InDesign wrote changes: an item with every InDesign effect serialises byte for byte as
before (`an_indesign_item_serialises_without_the_layer_style_fields` pins the JSON).

**One evaluator.** `paged-layer-fx` is the implementation of a layer style's effects. Its plan
resolves the stack's enabled layer-style entries into effects and places them where a layer style
composites them — beneath the layer (drop shadows, outer glow, a stroke's outer part), inside it
(the overlays, satin, inner glow; with Blend Interior Effects as Group before the layer's mode
applies), inside it always after (inner shadows, a stroke's inner part) and on top (bevel and
emboss) — and its draw turns each effect into kernel dispatches (`style.*`, `gen.*`, `compose.*`,
`math.*`, `band.*`) on a `FxDevice`. The conventions are paged.image's, unchanged: a size is a tent
of two box blurs, spread and choke go through a jump-flood signed distance field, a contour applies
after a range remap, noise and jitter come from a hashed stream. The kernels' definitions moved to
`paged-kernels` (`style`, `gen`, and the compose twin), where the engine reaches them; their scalar
twins ship under `paged-kernels`' `cpu` feature. Two devices run the same dispatches:

- paged.image's GPU fold (`layers::styles::Gpu` over its `GpuBatch`): the layer's style crosses
  onto the stack at the PSD boundary (`paged_psd_fx::map_layer_style`, in the document's pixels,
  Scale Effects folded into the sizes) and the evaluator plans and draws it. paged.image's own
  plan and effect bodies are deleted (single-owner rule `layer-style-evaluator`, empty baseline).
- the CPU device (`paged_layer_fx::cpu`): every kernel by its twin, each output stored as the
  rgba16float texel the GPU stores. paged.image's CPU fold draws styles with it (before, a layer
  style needed a GPU), and the engine renderer draws with it.

**The engine draws layer-style entries through the evaluator.** A frame whose object stack holds
layer-style entries draws no InDesign effect itself (`StackMode::Ordered`); `module::layer_style`
takes the frame's ALPHA — its picture as the body drew it, on the picture's own pixel grid (a frame
without one: its outline's coverage at two pixels per point) — pads it by how far the effects reach,
plans the entries and draws each effect on the CPU device. Exterior and top effects (shadows,
outer glow, a stroke's outer part; bevel and emboss) become RGBA plates, each in its own effect
layer with its blend mode and opacity, under the frame's run and over it. The interior effects are
Photoshop's BODY: at fill 100 % they blend onto the layer made opaque and the result replaces the
picture, shown through the layer's shape (so an anti-aliased edge mixes them with the backdrop as
Photoshop's does); below 100 % (the frame's content opacity) the body would read the backdrop, so
their plates go over the picture through the shape, outside the content group, which fill opacity
does not fade in Photoshop either. Every lane draws them as it draws a picture. The page's light is
the document's (`TransparencyPreference`).

**The PSD boundary maps both ways, losslessly.** `paged_psd_fx::map_layer_style` maps every effect
(each instance, bottom-up: of several the dialog's last first) with every parameter;
`unmap_layer_style` is its inverse (`unmap(map(style)) == style` for every style at Scale Effects
100 %, the scale being folded into the sizes; the master switch off reads back as a style switched
off). What remains a loss is a `LossEntry` (ADR 1097): the Texture pane (kept, drawn without — as
paged.image always drew it) and, when placing, a pattern the file does not carry. A gradient swatch
the entries name for the stack's other readers is named by a hash of its stops.

**Place PSD layers as frames.** `paged_psd_fx::place::place_layers` lowers a PSD's pixel layers:
each a frame at its place on the canvas (the file's resolution taken to points) with its pixels
(its user mask applied), its blend mode, opacity and fill opacity, and its style mapped with the
file's own patterns embedded. The canvas model plans it as one batch (`RequestPsdLayersPlace` →
`PsdLayersPlanned`, protocol v78 rider): the swatches the styles name, then per layer a frame, its
picture as a PNG `data:` URI, its blend mode, opacity, content opacity, item name and the whole
effect state through the stack path's snapshot lane, the frames grouped when there are several. A
hidden layer is not placed; what a frame cannot carry is a loss: an adjustment layer, clipping, a
group's opacity, blend mode or mask, a vector mask, Blend If, knockout, and the blending options
that change how a style composites. A CMYK file's ink goes through its profile (`paged-raster`'s
colour conversion). The door: `document.placePsdLayers@1` in the extension contract (plugin-sdk
0.74.3-canary.93), `paged place --layers` on the command line, and paged.image's Layer ▸ Place
Layers as Frames for the PSD it has open.

## Evidence

- `modules/image/image-conformance/tests/it/psd_layer_styles.rs`: the 66 Photoshop files through
  the GPU fold, now drawn by the engine's evaluator — every render byte-identical to before the
  move (the renders of the previous code and of this one, dumped with `PAGED_STYLE_DUMP` on Apple
  M3 Max / Metal: 67 of 67 identical); the same files through the CPU fold on the CPU device, held
  to the same recorded table (every file within it; the CPU lane differs from the GPU by at most
  three levels at a texel, the f16 stores and the device's transcendental functions); every
  Photoshop style crosses onto the stack and back unchanged.
- `crates/paged-psd-fx/tests/{map,photoshop}.rs`: each effect, every parameter kept, the
  compositing order of several instances, all blend modes, and the lossless round trip of the files
  Photoshop wrote.
- `crates/paged-model/src/effect_stack.rs`: the pinned InDesign serialisation, instances, the
  label carrying the layer-style fields, the wire form's carry.
- `crates/paged-layer-fx/src/lut.rs`: the contour spline split at corners, the ramp's midpoints and
  opacity stops (moved from `paged-psd`).
- `crates/paged-canvas/tests/it/psd_place_layers.rs`: twelve Photoshop files placed as frames and
  drawn by the engine's page renderer (pictures and styles through `vello_cpu`), each against
  Photoshop's merged composite of the same file and held to the same table paged.image's fold is
  (a drop shadow within 2 levels and a mean of 0.05, overlays within 2, the contour bevel 154 against
  the table's 157); the placed frame carries its style as layer-style effects with Photoshop's
  contour and light, one undo step.
- `platform/extensions/packages/plugin-sdk/test/psd-layers-door.spec.ts`: the door against the
  real engine and against one without it; `modules/image/glue/test/place-layers.spec.ts`: the menu
  command.

## Consequences

- A layer style has one implementation. paged.image's styles, its CPU fold and the page's placed
  PSD layers draw through it; a measured improvement to a convention lands everywhere at once.
- The image module composites a styled stack without a GPU (the Node CLI, a headless render).
- A PSD layer placed on a page keeps its style editable as effects; the Effects panel lists its
  entries (`patternOverlay` among the kinds); per-field editors edit the InDesign parameters of the
  slot, and the layer-style fields stay as the layer style set them.
- The engine renderer evaluates layer styles on the CPU at the picture's resolution; a picture
  whose padded grid exceeds 16 Mpx is drawn without them.
