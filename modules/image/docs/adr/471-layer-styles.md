# ADR 471 — A layer style is a sequence of fold steps around the layer's pixels

- **Status:** Accepted, 2026-10-25 (WP5.4).
- **Scope:** the style model and its descriptor reader and writer in `paged-psd`
  (`engine/core/crates/paged-psd/src/effects.rs`, `descriptor.rs`), the `style.*` kernel family
  (`image-kernels/src/families/style.rs`, `registry/kernels.yaml`), the fold
  (`image-js/src/layers/fold.rs`, `layers/styles.rs`), the PSD import, save-back and the layer
  manifest (version 5), and the bundle's Layer Style dialog and Styles section.

## Context

Photoshop's layer styles (Drop Shadow, Inner Shadow, Outer and Inner Glow, Bevel & Emboss,
Satin, Color, Gradient and Pattern Overlay, Stroke) were the most common reason a layered PSD
did not open as layers: every enabled effect but a Color Overlay refused the whole file, and the
Color Overlay was imitated by an extra solid layer clipped to its base. Nothing in the editor
could add a style.

The fold ([ADR 464](464-layers-at-their-own-bounds.md) and its resident successor) composites
a stack as a list of steps on the GPU: blend a plate, run an adjustment, open and close a group
or a clipping group.

## Decision

**One model, in the engine.** The style is `paged_psd::effects::LayerStyle`: every effect with
every parameter in Photoshop's units, several instances of the five effects Photoshop repeats,
read from `lfx2` / `lmfx` and written back by a descriptor writer in `paged-psd` (each effect
starting from the descriptor it was read from, so keys the model does not carry survive). Global
Light is the document's (resources 1037 and 1049). The model is format data any module can map
(PM-0014); the image module draws it, and its JSON form is what the dialog edits.

**Steps around the layer.** A styled pixel layer folds as: save the backdrop; the exterior
effects (drop shadows, outer glow, the outer part of a stroke) blended onto it; the layer's
BODY — a clipping group of the layer made opaque, closed onto the backdrop in the layer's mode at
its fill opacity without its shape, then the interior effects (overlays, satin, inner glow, inner
shadow, the inner part of a stroke), then mixed in through the layer's shape; Bevel & Emboss on
top; and `mix(backdrop, result, opacity × mask)` at the end. Blend Interior Effects as Group
moves the overlays, satin and inner glow inside the group. A layer mask shapes the effects, or —
with Layer Mask Hides Effects — hides them at the end. These are Photoshop's semantics as the
recorded composites show them (`psd_layer_styles.rs`): a Normal overlay on a soft edge is
`mix(B, overlay, α)`, at fill 0 a Multiply inner shadow multiplies the backdrop, the layer's
opacity fades a shadow with the layer instead of letting it show through, and the anti-aliased
edge of a layer blends over its outside stroke and its drop shadow.

**Coverage on the GPU.** Twelve `style.*` kernels make each effect's coverage from the layer's
alpha: a sub-pixel shift, a separable blur (Gaussian or box), a jump-flood signed distance field
(Rong & Tan 2006) corrected by the edge texels' coverage, distance ramps, a contour lookup,
colouring with noise and jitter, Lambert shading of a height field, and the shading's split into
highlight and shadow. Each has a scalar twin under the `reference` feature, held to its declared
tolerance (`family_style.rs`). The conventions that make the shapes Photoshop's — an effect's
Size is two box passes as wide as the size, offsets are whole pixels, a softer glow is its blur
over the Range, a smooth bevel's height is the tent-blurred alpha (rounded corners), a chisel's
is the distance (mitred corners), Depth 100 % is a 0.45 slope — were fitted to Photoshop
27.10's own renders, one probe per style and key parameter
(`scripts/photoshop/probes/layer-styles.jsx`, 67 recorded cases).

## Consequences

- Layered PSDs with styles open as layers and save their styles back as Photoshop's own blocks;
  a style with a pattern (Pattern Overlay, a pattern Stroke, a bevel's Texture) still keeps the
  merged composite, because the document's pattern block is not read; knockout on a styled layer,
  Blend Clipped Layers as Group off and Transparency Shapes Layer off are refused by name.
- The replay records each case's distance from Photoshop and classifies it: most agree within a
  few levels; Bevel & Emboss's edge and corner texels, curved strokes' anti-aliasing, the angle of
  a scaled linear gradient overlay at 30° and the noise stream are conventions, measured and
  stated rather than hidden.
- The fold no longer imitates a Color Overlay with a synthetic layer; the overlay is a style.
- A CMYK document's effects other than a Normal or Multiply Color Overlay are refused: Photoshop
  draws them in the document's inks.
