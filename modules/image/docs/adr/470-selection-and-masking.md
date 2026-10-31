# ADR 470 — Selection and masking: a selection kernel, selections on the undo list, channels and paths in the session

- **Status:** Accepted, 2026-10-24. Amends [ADR 463](463-one-undo-list.md) (selection changes join
  the one undo list) and [ADR 465](465-cpu-twins-for-region-filters.md) (one more shipped CPU
  twin).
- **Scope:** `image-kernels/src/families/select.rs` (`select.color_range`),
  `image-js/src/{selection,masking,refine,focus,magnetic}.rs`, `image-js/src/layers/masking_ops.rs`,
  the layer manifest's trailing masking block (`layers_persist.rs`), the selection and masking
  wasm doors (`lib.rs`), `glue/src/{masking-engine,masking-session,masking-contrib,magnetic-tool}.ts`,
  `glue/src/panels/sections/masking-section.tsx`, the Photoshop probe `selection.jsx` and its replay
  `image-conformance/tests/it/oracle_photoshop_selection.rs`.

## Context

Photoshop's selection tools beyond marquee, lasso and wand were missing (gaps I-28 … I-35 of the
2026-10-23 report): Color Range, Select and Mask, Quick Mask, a Channels panel with saved
selections and spot channels, Grow / Similar / Focus Area, the Magnetic Lasso, and paths stored
with the image. Three questions needed a decision rather than an implementation:

1. Where Color Range runs. Every coverage operation so far (wand, feather, modify) is mask
   preparation on the CPU; Color Range is a per-pixel colour function of the whole image, which
   is what the GPU kernels are for.
2. Whether a selection change is an undo step. Photoshop records every one in its history; the
   one undo list (ADR 463) held pixels and the layer stack only.
3. Where channels and paths live. They are document state in Photoshop; the PSD writer writes no
   extra channels yet.

## Decision

- **Color Range is a kernel.** `select.color_range` (a handwritten module kernel, `Point`, one
  input) writes the coverage as `(m, m, m, 1)` and never reads the ABI mask. Its model was FITTED
  to Photoshop's recorded answers (`selection.jsx`): sampled colours select by the Chebyshev
  distance to the samples' Lab (D50) box with L weighted 0.85 and a quadratic ease reaching 0 at
  fuzziness / 3; the hue presets are an HSV-hue triangle times chroma times (2 − V); the tonal
  presets use Rec. 601 luma with a falloff width of fuzziness times the distance to the far end
  of the scale. Skin tones use the classical Cb/Cr ellipse (Hsu, Abdel-Mottaleb and Jain 2002) —
  a stated convention, as Photoshop's model is unpublished. Out of Gamut waits for a
  soft-proofing CMYK profile in the module's colour settings and says so.
- **Its twin ships.** The scalar twin (`color_range_rgba8`, feature `cpu`) runs where there is no
  GPU device or the image exceeds a texture; the kernel is held to it on the stimulus within two
  8-bit levels. This is the second shipped-twin exception to ADR 450, on ADR 465's terms.
- **Every other selection operation is mask preparation on the CPU**, like the wand: Grow /
  Similar (the selected colours' RGB box widened by the wand tolerance), Focus Area (local
  variance of the Laplacian, thresholded and cleaned), Select and Mask (a trimap from an
  edge band — adaptive with Smart Radius — alpha by projection onto local foreground and
  background means, then smooth, feather, contrast, shift edge, and decontamination by the
  estimated foreground colour), and the Magnetic Lasso (a live wire over the gradient magnitude).
- **A selection change is a structure step.** Each layer-stack snapshot captures the selection
  as the stack last saw it (a mirror the wasm doors keep equal to the session selection); a
  person's selection change is recorded as a step whose only effect is the mirror, and undoing
  any step restores the selection it was taken with. Changes that are not a person's (a kept
  selection restored, a rebind) only sync the mirror.
- **Channels and paths are session state in the layer stack's snapshot**, so every change is one
  undo step and they persist with the layer data: a trailing block (`"PGMK"`, version 1) after
  the layer manifest, which readers of the manifest without it skip and which is absent when
  there is no masking state. Spot channels are stored and displayed; the PSD writer does not
  write extra channels yet (stated in the panel). Paths are stored here; Edit ▸ Selection to path
  still makes document shapes on request.
- **Quick Mask and channel painting reuse the brushes.** With a channel chosen as the edit
  target, the stack's mask-target hooks aim at it: every tool that paints a layer mask paints the
  channel, journaled under its own scope bit. Quick Mask is a temporary channel; leaving it turns
  the channel into the selection as one step.
- **Views are display transforms.** Showing one channel as grey, Quick Mask's overlay and the
  matte previews of Color Range and Select and Mask transform the composite on its way to the
  frame (`view_apply`); the document is never written by a view.
- **The matting hook is a door, empty.** Select and Mask hands a matting provider the trimap and
  takes its alpha in place of the classical solve; none is installed until WP8.2.

## Consequences

- Marquee, lasso, wand, feather, modify, invert, select all and deselect are now undo steps;
  tests that counted undo depth around them count one more.
- The Grow / Similar replay records a convention: Photoshop's range is tighter than a
  per-channel box along saturated hue ramps (it agrees exactly on neutrals).
- Reading a PSD's own alpha and spot channels into the Channels panel, and writing them back,
  are the next steps; both sit with the PSD writer (WP5.15).
