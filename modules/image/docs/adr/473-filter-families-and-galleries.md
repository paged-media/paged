# ADR 473 — Filter families as kernels and recipes; the galleries are workspaces over one chain

- **Status:** Accepted 2026-10-25. Builds on [ADR 450](450-gpu-only-kernels.md) (GPU-only
  kernels) and [ADR 451](451-kernel-definition.md) (one kernel definition); the Develop layer kind
  extends the typed adjustment layers of WP5.3.
- **Scope:** the kernel families `distort`, `render`, `stylize`, `pixelate`, `blurgal`,
  `gallery_ext`, `adjust_ext` and `develop` (`image-kernels/src/families/`), their doors
  (`image-js/src/wasm/filters_*.rs`), the chain doors `filter_source` / `filter_land`, the
  Filter dialog's catalogue (`glue/src/filters*.ts`, `develop.ts`), the Filter Gallery and Blur
  Gallery workspaces, Curves' targeted adjustment and the `"develop"` adjustment layer.

## Context

Photoshop's Filter menu has some ninety entries beyond what the first families covered: Distort,
Render, Stylize, Pixelate, the Blur Gallery's five blurs, forty-seven Filter Gallery effects,
the one-shot adjustments (Shadows/Highlights, HDR Toning, Match Color, Replace Color, Equalize,
Desaturate) and a Camera Raw-class Develop. Each had to reach the editor through the documented
path (registry row, WGSL and its twin, parity, door, engine facade, session, command, menu,
dialog). Three questions decided how:

1. Is every named filter a kernel? The Filter Gallery's forty-seven are a dozen operations named
   several times with different settings (the `gallery.*` family already said so).
2. How do several kernels become one undo step? A door lands its result in the active layer as a
   journal entry, so a recipe of three, a gallery stack or a Develop pass would cost several.
3. Where does the Blur Gallery's geometry live, given that the plugin contract cannot switch the
   active tool?

## Decision

- **A kernel per operation, a recipe per name.** A filter whose computation is its own (Displace,
  Polar Coordinates, Ripple, Shear, ZigZag, Clouds, Fibers, Lens Flare, Lighting Effects, Wind,
  Extrude, Tiles, Solarize, Trace Contour, Crystallize, Pointillize, Mezzotint, Color Halftone,
  the five blurs, Shadows/Highlights, HDR Toning, Match Color, Replace Color, Desaturate, Develop)
  is a kernel with a registry row, a scalar twin and gpu↔ref parity. A Filter Gallery effect is a
  RECIPE in `filters-gallery.ts`: Photoshop's own sliders mapped onto one or more `gallery.*`
  operations (three new ones: `gallery.strokes`, `gallery.chrome`, `gallery.plastic_wrap`), the
  Sketch family drawn in the foreground and background colours through the gradient map. Facet is
  `gallery.kuwahara` at radius 2; Equalize is a CPU histogram readout through `adjust.lut1d`.
- **Spatially varying, not per-region.** A Blur Gallery kernel computes a per-pixel blur radius
  from its geometry (Shepard-weighted pins, an ellipse with a sharp core, a band, a polyline's
  tangent, a spin ellipse) and samples a fixed golden-angle disc scaled by it. One dispatch, no
  mask compositing between regions.
- **Chains run detached and land once.** `filter_source(handle)` copies what a filter reads (the
  active layer) into a new, unmasked flat handle; the chain's doors run there, each returning a
  new flat handle; `filter_land(handle, result)` applies the selection's coverage once and lands
  the result as ONE journal entry. A one-step recipe calls its door directly. The Filter Gallery
  stack, every multi-step recipe, the Blur Gallery's combined blurs and `apply_develop` use it.
- **The workspaces are the Filter dialog.** The Filter Gallery and the Blur Gallery are catalogue
  entries whose values are flat (the gallery stack is `stack` plus `"<layer>.<key>"`; the
  blurs' positions are normalised to the image), so the dialog's live preview, proxy scaling,
  OK-one-step and Cancel apply unchanged.
- **The canvas belongs to the open dialog.** Every image tool is wrapped at registration
  (`canvas-capture.ts`): a press goes to `session.canvasPointer` first and, when the session takes
  it (a Blur Gallery handle, an armed Curves targeted adjustment), the whole drag goes there. The
  Blur Gallery draws its pins in a retained overlay layer (`host.overlay.layer`).
- **Develop is an engine layer kind.** `"develop"` is a typed adjustment layer (61 values in
  Lightroom/ACR units, the defaults the identity) evaluated by the fold through the develop
  kernels, and the one-shot Filter ▸ Develop… is the same schema. Photoshop has no Develop
  adjustment layer, so PSD save-back does not write one: it takes the existing fallback for a
  layer kind without a PSD block.

## Consequences

- The Photoshop oracle replays every scriptable case (`scripts/photoshop/probes/filters-*.jsx`,
  `adjustments-ext.jsx`); random-seeded filters compare channel statistics, not pixels. Most
  rows are `convention`: the kernels are clean-room approximations of what each filter visibly
  does. HDR Toning, Lighting Effects, the Blur Gallery and the Filter Gallery are not scriptable
  and have no recorded case.
- A stacked or multi-step filter costs a copy of the layer and one extra landing; the
  intermediates are freed as the chain goes.
- The capture wrapper means an image tool's drag does nothing of its own while a workspace draws
  on the canvas; Escape or closing the dialog returns the canvas to the tool.
