# ADR 1008 — An item's effects are an ordered stack

- **Status:** Accepted 2026-10-25.
- **Scope:** protocol v76 (additive; no bump). `paged-model` (`effect_stack`: `Effect`,
  `EffectEntry`, the slots view `SlotsRef` / `SlotsMut`, `EffectBearing`, the IDML label;
  the `effect_stack` field of `TextFrame`, `Rectangle`, `Oval`, `Polygon` and
  `TargetTransparency`); `paged-compose` (`LayerEffect::{Noise, ColorAdjust}`, `layer_fx`);
  `paged-gpu` (`vcpu.rs`: the per-pixel layer effects, `rasterize_layer`; `vello_rs.rs`: effect
  layers composited from the CPU raster); `paged-renderer` (`module/effect_stack.rs`, the
  emitters' stack wrappers); `paged-export-pdf` (`page.rs`: effect layers as images, the
  `effect_rasterized` finding; feature `raster-effects`); `idml-import` / `idml-export` (the
  `paged:effectStack` label); `paged-mutate` (`PropertyPath::Frame{,Fill,Stroke,Content}EffectStack`,
  `Value::EffectStack`, `EffectEntrySpec`, `apply/effect_stack.rs`); `paged-introspect` (four
  rows, `Wire::EffectStack`); `paged-canvas` (reads, `effect_stack_losses`). Amends
  [ADR 104](104-effects-follow-indesign-parameters.md) and
  [ADR 135](135-transparency-targets-and-effect-attributes.md). Plan WP3.1; gaps D-31, D-32, X-3,
  I-12.

## Context

InDesign gives each transparency target (the object, its fill, its stroke, its content) nine
effects in fixed slots — drop shadow, inner shadow, outer and inner glow, bevel and emboss,
satin and the three feathers — and composites them in a fixed order. The model mirrored that
exactly ([ADR 104](104-effects-follow-indesign-parameters.md)): a `drop_shadow` and a
`FrameEffects` bag per target. That is all IDML can say, and it is not what the other tools the
engine serves say. Photoshop's layer styles add a stroke and colour, gradient and pattern
overlays; Illustrator's appearance applies effects in the order the user arranges them, a
Gaussian blur among them; PowerPoint has reflection and soft edges. The modules (draw, image,
slide, doc) need these on any page item, and an effect that cannot be switched off without
losing its settings is an InDesign limitation the editor does not need to copy.

## Decision

**The stack.** Each target has an ordered `effect_stack: Vec<EffectEntry>`. An entry has an
`enabled` flag, and for a stack-only effect a blend mode and an opacity, and one `Effect`:

- InDesign's nine, one entry each, which NAME their slot. Their parameters stay in the slot
  (`drop_shadow`, `FrameEffects`), where every existing reader — renderer, PDF, IDML, the
  per-field paths — finds them. A DISABLED InDesign effect's parameters are parked on its entry
  and its slot is empty, so every reader sees it off and nothing is lost.
- Stack-only effects carrying their own parameters: `GaussianBlur` (σ in pt), `OutlineStroke`
  (Photoshop's Stroke: size, Outside / Inside / Center, colour), `ColorOverlay`,
  `GradientOverlay` (a gradient swatch, angle, reverse; black to white without one),
  `Reflection` (PowerPoint: gap, size, start and end opacity, blur), `SoftEdge`, `Noise`
  (Photoshop's Add Noise, uniform, monochromatic or per channel) and `ColorAdjust` (brightness,
  contrast, saturation, hue). They are applied to the OBJECT target; a fill, stroke or content
  stack takes InDesign's effects only (reorder and switch), and a stack-only entry there is
  refused (`InvalidValue`), never stored undrawn.

**The canonical form, and compatibility.** A target whose effects are InDesign's, all on, in
InDesign's order, stores an EMPTY stack: its slots say all of it, and the stack it reads is
derived from them in InDesign's order. Every imported document is in that form, and every write
that comes out canonical is normalised back to it. The field is `#[serde(default,
skip_serializing_if = "Vec::is_empty")]`, so a document without the new effects serialises
— in `.pgm` and through the state hash ([ADR 195](195-the-state-hash-covers-the-whole-model.md))
— byte for byte as before, and its display list digests as before
([ADR 101](101-display-list-single-intermediate.md)). `PGM_FORMAT_VERSION` does not move.

**Order means what the entries act on.** The renderer draws the frame's body (fill, picture,
stroke and, through the text slot, the text) as a run, then applies the stack to it entry by
entry, in order, so each entry acts on what the entries before it produced:

| kind | where it goes | entries |
|---|---|---|
| behind | under the run | drop shadow, outer glow, reflection |
| over | over the run | inner shadow, inner glow, bevel, satin, outline stroke, overlays |
| mask | fades the run by the outline | the three feathers, soft edge |
| filter | wraps the run in an effect layer | Gaussian blur, noise, colour adjustment |

A blur after an outline stroke blurs the stroke; a stroke after a blur is drawn crisp over the
blurred object. Behind and over effects take the frame's OUTLINE (grown to the stroke's outer
edge), not the pixels the run painted: a drop shadow after a blur is the outline's crisp shadow
under a blurred object. Everything composites inside the object's own group, so the object's
opacity and blend mode apply to its effects, as in InDesign. When the stack's InDesign entries
come first and in InDesign's order, the body draws them itself exactly as before and the stack
adds its own effects after them; otherwise every entry is drawn by the stack, in its order.

**One blur, two lanes.** A filter is a `PushLayer` whose `LayerEffect` runs when the layer pops:
the existing separable Gaussian, and the new `Noise` and `ColorAdjust`, whose per-pixel
arithmetic is one definition (`paged_compose::layer_fx`) on un-premultiplied sRGB. The CPU
rasterizer runs them on its layer buffer. The Vello lane, which has no image-space convolution,
asks the CPU rasterizer for the layer (`vcpu::rasterize_layer`: the layer's commands drawn alone,
its effect applied, its blend and opacity not) and composites the pixels as an image under the
layer's blend mode and opacity. The 7×7 multi-tap replay remains only for a build without the
CPU rasterizer. The two lanes therefore agree pixel for pixel at one resolution
([ADR 146](146-the-gpu-lane-is-held-to-the-cpu-lane.md); `effect_stack_layers_match_the_cpu_lane`). A wgpu
compute blur in `paged-gpu` would avoid the CPU round trip in the browser; it is left for a
follow-up, measured against this lane.

**PDF.** InDesign's effects export as before. A filter has no PDF operator: its layer is drawn
by `rasterize_layer` at the export's effect resolution (`ExportOptions::effect_dpi`, 150 ppi by
default), written as an RGB image with an alpha `/SMask`, and placed once under an ExtGState
carrying the layer's blend mode and opacity — inside the transparency group the object already
is. The export reports `effect_rasterized` (a warning) in its findings. Behind, over and mask
entries stay vector or use the existing effect stamps. A build without the `raster-effects`
feature writes the layer's content unfiltered and reports `effect_not_rasterized`.

**IDML.** InDesign's nine are written as InDesign's own settings, in its fixed order, as before.
What a stack adds — the order, the switches with a disabled effect's parked parameters, and the
stack-only effects — is written to the item's `<Label>` as `paged:effectStack` (JSON), which
InDesign preserves and does not draw; the importer lifts it back into the stacks and removes it
from the label side map, so the model holds it once. On re-import the label's InDesign entries
keep only their place and switch: an effect InDesign removed meanwhile leaves the stack, one it
added joins it at its place in InDesign's order. `idml_export_losses` names every enabled
stack-only effect (InDesign shows the object without it) and every target whose InDesign
effects are in a different order than InDesign draws them. The construct is not baked to a
raster in IDML: the loss line and the label are the record, as for opacity masks
([ADR 124](124-opacity-masks-native.md)).

**The wire.** Four additive paths, `frameEffectStack`, `frameFillEffectStack`,
`frameStrokeEffectStack` and `frameContentEffectStack`, on text frames, rectangles, ovals and
polygons, carry `Value::EffectStack { entries, prev }`: the whole stack, one write per gesture
(add, remove, move, switch, a stack-only parameter), one undo step. `EffectEntrySpec` is flat:
`kind`, `enabled`, `blendMode`, `opacityPct` and the optional parameters each kind reads, an
absent one taking the kind's default. InDesign's effects carry no parameters there; theirs stay
on the per-field paths. The inverse carries `prev`, a snapshot of the target's effect state, so
undo restores the model exactly ([ADR 197](197-undo-restores-the-model-exactly.md)). A per-field
effect path on an item with a stored stack reaches a disabled effect's parked parameters,
`*Enabled true` switches a disabled effect back on in place with them, and the stack is kept in
line with the slots (an effect switched on there joins at its InDesign place, one switched off
leaves); its inverse is a stack snapshot too. A new `Value` member on an existing payload and
new paths are additive (protocol governance rule 1): no protocol bump. The catalog rows are
`list_of("EffectEntrySpec", Wire::EffectStack)`.

**Colour adjustment formulas.** Brightness shifts every channel by half its value; contrast
scales about mid-grey by `1 + c` below zero and `1 / (1 − c)` above; hue rotates and saturation
scales in HSL. They are the engine's minimal set: the image module's adjustment kernels are not
a dependency of the engine, and these move onto the shared kernel crate's CPU twins when it
lands (plan C1/C4).

## Evidence

- `crates/paged-model/src/effect_stack.rs`: the canonical form, set / park / unpark / reconcile,
  refusals, serialisation, the label round trip, the exact state snapshot.
- `crates/paged-compose/src/layer_fx.rs`: identity, desaturation, hue turn, brightness and
  contrast, page-anchored bounded noise.
- `crates/paged-gpu/src/vcpu.rs` (`a_layer_drawn_alone_matches_the_page_render`) and
  `vello_rs.rs` (`effect_stack_layers_match_the_cpu_lane`).
- `crates/paged-renderer/tests/it/effect_stack.rs`: the canonical stack's digest equals no
  stack's; a blur grades the edge; the outline stroke's three positions; the order decides what
  a blur reaches; a disabled effect paints nothing; InDesign effects in a custom order; every
  stack-only effect draws; an entry's opacity.
- `crates/paged-export-pdf/tests/it/effect_stack.rs`: one SMask image and the finding for a blur;
  an outline stroke stays vector.
- `crates/paged-canvas/tests/it/effect_stack.rs`: reads, add / reorder / undo to the exact state
  hash, disabled parameters through per-field paths, a text frame's text inside the blur,
  target refusals, `.paged` and IDML round trips with the loss lines.
- `crates/paged-store/tests/it/effect_stack.rs`: a custom stack round-trips; a canonical item
  writes no key and hashes alike.

Tests named `*__feat__effects_transparency_effect_stack` are the evidence of the feature row
`effects-transparency.effect-stack`.

## Consequences

- Any page item a module makes can carry a blur, an outline stroke, overlays, a reflection, a
  soft edge, noise or a colour adjustment, in any order, in the editor, on both rasterizers and
  in PDF; InDesign effects can be switched off without losing their settings.
- Documents without the new effects are unchanged in every byte the engine writes or hashes.
- A text frame's text takes the stack when the story's glyphs move into the frame's text slot
  (the canvas and the export build); a reflection copies the frame's run before the text moves
  in, so a text frame's reflection shows its box, not its text.
- Not in this decision: a pattern overlay (it waits for pattern paint, plan ADR 1007), live
  effects on groups and lines (a group's or a line's stack is not drawn and has no path), a
  satin and bevel parameter superset, and stack-only effects on the fill, stroke and content
  targets.
- The Vello lane round-trips a filter layer through the CPU on every redraw; the compute-blur
  follow-up removes that cost.
