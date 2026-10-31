# ADR 1044 — A Photoshop layer style maps onto the effect stack

- **Status:** Accepted 2026-10-29.
- **Scope:** the new crate `crates/paged-psd-fx` (`map_layer_style`, `map_layer_record`,
  `apply_mapped`, `apply_layer_style`, `idml_blend`); `paged-psd` (`effects::layer_style`, the
  shared `lmfx` / `lfx2` reader, and `AdditionalLayerInfo::payload`), which the image module's
  `psd_layer_ext::style_of` now calls. Builds on [ADR 1008](1008-an-items-effects-are-an-ordered-stack.md).
  Plan C16 (PM-0014 L2: the shared effect mapper), WP3.1.

## Context

`paged-psd` reads a layer's style (Photoshop's `lfx2`, or `lmfx` for several instances of an
effect) into a typed model in Photoshop's own units. The image module draws it on its layers.
Anything that turns a PSD layer into a page item — placing one layer, a layer converted to a
frame — had to bake the style into the pixels, because the page had no way to say it: the
engine's ordered effect stack (ADR 1008) now can say most of it. The mapping belongs below every
consumer (PM-0014): the renderer, the editor's place flows and the image module all need the
same one.

## Decision

**One crate maps, purely.** `paged-psd-fx` depends on `paged-psd` and `paged-model` only (wasm
safe). `map_layer_style(style, opts)` returns the OBJECT target's stack, the colour and gradient
swatches its entries name (`Color/PSD R=… G=… B=…`, `Gradient/PSD n`, sRGB), and a `StyleLoss`
for each thing the stack cannot say. `apply_mapped` writes it onto any `EffectBearing` item
(`set_stack`, so InDesign's kinds land in their slots and the rest on the stack) and adds the
swatches to the document's `Graphic`, keeping one of the same name.

**What maps.** Drop Shadow, Inner Shadow, Outer and Inner Glow, Bevel & Emboss and Satin become
InDesign's kinds with their parameters (the first instance; a second is a loss); Color and
Gradient Overlay and Stroke become the stack-only `colorOverlay`, `gradientOverlay` and
`outlineStroke`, each instance an entry with its own blend and opacity. Photoshop's units are
kept where the engine's are the same (percentages, angles as the light's direction, which is
what the renderer's polar offset reads); sizes and distances are scaled by the style's Scale
Effects and the document's points per pixel. A blend mode IDML has no name for composites as
Normal and is a loss until the stack takes the 27 modes (WP3.4).

**What is lost, named.** Non-linear contours (judged by their points: Photoshop names a straight
curve "Custom" as often as "Linear"), a glow's gradient fill, range and jitter, Bevel's gloss
contour and its Contour and Texture panes, a gradient's non-linear style, scale, offset and
opacity stops, a stroke's gradient or pattern fill (its first colour is kept) and Pattern Overlay
(no pattern paint on the stack yet, ADR 1007).

**Order and switches.** The stack takes the effects in Photoshop's compositing order, the reverse
of its Layer Style dialog — drop shadow and outer glow, then pattern, gradient and colour
overlays, satin, inner glow, inner shadow, stroke and bevel — so each acts on what the ones
before it drew. An effect Photoshop has switched off is a disabled entry that keeps its
parameters; the style's master switch off disables every entry.

## Evidence

- `crates/paged-psd-fx/tests/map.rs`: each Photoshop effect through the `lfx2` descriptor and
  the mapper, at 144 ppi; the losses; the compositing order; switched-off effects; the result
  applied to a rectangle and its document's swatches.
- `crates/paged-psd-fx/tests/photoshop.rs`: files Photoshop 27.10 wrote (a subset of the image
  module's recorded `layer-styles` probe, copied with its provenance into
  `tests/fixtures/photoshop-layer-styles/`), each layer's style mapped with the parameters the
  probe set.

Tests named `*__feat__images_graphics_psd_layer_styles` are the evidence of the feature
row `images-graphics.psd-layer-styles`.

## Consequences

- A flow that makes a page item from a PSD layer calls `apply_layer_style` and the item draws its
  style natively, editable in the Effects and Appearance panels, exported to PDF as ADR 1008
  draws the stack, and reported where it is lost.
- No such flow exists yet: placing a whole PSD draws its merged composite, which already holds
  the styles, and must not map them again. Placing one layer as a page item is the follow-up that
  uses this.
