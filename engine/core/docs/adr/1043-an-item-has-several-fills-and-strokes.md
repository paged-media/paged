# ADR 1043 — An item has several fills and strokes (native appearance)

- **Status:** Accepted 2026-10-29.
- **Scope:** protocol v78 (additive; no bump). `paged-model` (`appearance`: `PaintLayer`,
  `PaintLayerKind`, `normalize`, `drawn_order`, `AppearanceBearing`, `AppearanceParts`;
  `appearance::interchange`: the IDML bake, its restore and its loss lines; the `appearance` field
  of `TextFrame`, `Rectangle`, `Oval` and `Polygon`); `paged-renderer` (`pipeline/appearance.rs`,
  the four emitters' entry); `idml-export` (`write_idml_with` bakes); `idml-import` (the spread
  reader restores); `paged-mutate` (`PropertyPath::FrameAppearance{,Layer}`,
  `Value::Appearance{,Layer}`, `appearance_wire::PaintLayerSpec`, `apply/appearance.rs`);
  `paged-introspect` (two rows, `Wire::Appearance{,Layer}`); `paged-canvas` (the read, the loss
  line). Builds on [ADR 1008](1008-an-items-effects-are-an-ordered-stack.md) (a layer's effects are
  its stack). Plan WP3.3; gaps D-34, D-35. Supersedes, for the engine, the group bake of draw
  ADR 354.

## Context

IDML gives a page item one fill and one stroke. Illustrator gives an object an appearance: any
number of fills and strokes, in any order, each with its own colour, opacity, blend mode and
effects, and each stroke with its own weight, alignment, caps, joins and dash. paged.draw modelled
that in its plugin metadata and lowered it either to the front-most fill and stroke or, by a command,
to a group of single-paint items (draw ADR 354). The group is real page content: a second command
to bake, two undo steps to re-bake, a refusal for compound paths, graphic styles that cannot hold a
baked object, and an appearance that no other module, panel or exporter can see.

## Decision

**The model.** Each text frame, rectangle, oval and polygon has `appearance: Vec<PaintLayer>`,
bottom to top. A layer is a `fill` or a `stroke` with an `enabled` switch, a paint (a swatch, colour
or gradient reference in the frame paths' `colorRef` vocabulary, a fill's tint, the gradient's
angle, length and — for a fill — start), an opacity, a blend mode, its own effect stack (the
stack-only effects of ADR 1008: blur, outline stroke, overlays, reflection, soft edge, noise,
colour adjustment) and, for a stroke, a weight, alignment, end cap, join, miter limit, stroke style
and dash. When the paint model grows (plan ADR 1007's pattern and mesh paints), a layer's paint
grows with it.

**In order with the item's own paint.** Two placeholder kinds, `frameFill` and `frameStroke`,
stand for the item's own fill (with its picture) and stroke — the ones IDML, object styles and
every per-field path know — and put the extra layers in order with them. A list that does not
place them implies them: the frame's fill at the bottom, its stroke directly above it. A
placeholder carries only its place and its switch (switching off the frame's fill hides it and
keeps the picture).

**The canonical form, and compatibility.** The empty list is the item as it always was. A write is
normalised: placeholders once each, numbers finite and in range, the fields a kind does not read
cleared, InDesign's effects refused on a layer (their parameters live in a target's slots), and a
list that says nothing the frame does not — placeholders alone, enabled, in the implied order —
stored as empty. The field is `#[serde(default, skip_serializing_if = "Vec::is_empty")]`: a
document without appearances serialises (`.pgm`, the state hash of ADR 195) and digests
(ADR 101) byte for byte as before. `PGM_FORMAT_VERSION` does not move.

**Rendering is composition.** An item with an appearance is drawn as its parts, bottom to top,
each through its kind's ordinary emitter: the frame's own fill and picture (and its stroke with it
when the stroke is directly above — then the part is exactly the plain body), the frame's stroke on
its own where a layer sits between, and one ordinary item per layer that paints
(`AppearanceParts::layer_item`: the outline with that one paint, the layer's opacity and blend mode
as the item's, the layer's effects as its object stack). The item's opacity and blend mode wrap
all parts in one group; its object effects — InDesign's included — apply to the whole run in
their order (ADR 1008's ordered mode), so a drop shadow is cast once, by all the layers together.
A text frame's text goes in over every layer, inside that group. Nothing new reaches the display
list: blend groups, fills, strokes and effect layers the two rasterizers and the PDF writer already
draw. GPU and CPU agree (ADR 146; `appearance_parity`), and the PDF writes each layer as its own
paint operator, a layer with a blend mode or opacity as its own transparency group, a layer's blur
rasterised into its layer as ADR 1008 rasterises any filter.

**IDML: bake, report, label, restore.** IDML cannot say it. The writer bakes each item with an
appearance on a copy of the model into what paints the same in InDesign: a `<Group>` in its place
holding one single-paint item per layer, bottom to top. The item stays as the carrier (its id,
geometry, content and label), where its fill is drawn, keeping its stroke when the stroke follows
the fill; a text frame's carrier goes on top and gives its fill and stroke to items of their own.
Each extra layer becomes a rectangle, oval or polygon with the carrier's outline, its opacity and
blend mode as that item's, its effects as that item's effect stack (which travels by the ADR 1008
label). The item's opacity, blend mode and drop shadow move to the group. The carrier's `<Label>`
keeps the source (`paged:appearance`: the layers, the group's id, the carrier's paint before the
bake) and each baked item is labelled `paged:appearanceLayer` with the carrier's id. The reader
finds the group again, drops it and the baked items, and gives the carrier back its appearance and
its paint; a group InDesign dissolved leaves what InDesign wrote. `idml_export_losses` names each
item: the appearance is written as a group, an InDesign edit edits one of its paints, and the
item's own effects other than the drop shadow stay on the carrier and do not reach the extra
paints. The `.paged` model part keeps the appearance as it is.

**The wire.** Two additive paths on text frames, rectangles, ovals and polygons:
`frameAppearance` carries `Value::Appearance { layers, prev }`, the whole list — add, remove,
reorder and any field are one write and one undo step each; `frameAppearanceLayer` carries
`Value::AppearanceLayer { index, layer }`, one layer replaced in place (one past the end appends),
catalogued as an operation. `PaintLayerSpec` is flat and camelCase (`kind`, `enabled`, `color`,
`tint`, `gradientAngle`, `gradientLength`, `gradientStart`, `opacityPct`, `blendMode`, `effects`,
`weight`, `alignment`, `endCap`, `endJoin`, `miterLimit`, `strokeType`, `dash`). Both inverses
are a `frameAppearance` write carrying `prev`, a snapshot of the stored layers, so undo restores
the model exactly (ADR 197). New paths and `Value` members are additive (protocol governance rule
1): no protocol bump. The SDK advertises `document.appearance@1`.

**paged.draw.** The engine side of the migration is `draw-bundle`'s `nativeAppearanceOf`: draw's
metadata stack (fills bottom to top, then strokes; the front-most of each already baked onto the
frame) becomes extra layers with the frame's own fill and stroke as the placeholders where the
front-most layers were, and `migrateAppearanceMutations` writes it with the envelope's stack
removed, in one batch. Switching draw's commands, panel, bake and graphic styles to the native
appearance is plan WP6.3.

## Evidence

- `crates/paged-model/src/appearance.rs`: the canonical form, the implied order, refusals,
  normalisation, serialisation; `appearance/interchange.rs`: the bake's group and carrier, a text
  frame's carrier on top, restore is the exact inverse, a dissolved group, the loss line.
- `crates/paged-renderer/tests/it/appearance.rs`: the placeholders draw the frame (digest
  unchanged); an extra fill's blend and opacity, an extra stroke's weight and alignment, the order,
  a disabled layer, a layer's blur, the item's opacity and shadow once, all four kinds — pixels on
  the CPU rasterizer.
- `crates/paged-gpu/tests/it/appearance_parity.rs`: the CPU lane composites the layers; Vello
  agrees.
- `crates/paged-export-pdf/tests/it/appearance.rs`: one paint operator per layer, the layer's
  `/BM` and `/ca`, a layer's blur rasterised.
- `crates/paged-canvas/tests/it/appearance.rs`: reads, a write and its exact undo, a layer write,
  refusals, `.paged` and two IDML round trips with the loss line, the raw IDML's group.
- `crates/paged-store/tests/it/appearance.rs`: a layered item round-trips; an item without one
  writes no key and hashes alike.

- `crates/paged-renderer/tests/it/appearance_illustrator.rs`: Illustrator 30.1's recording of
  `modules/draw/scripts/illustrator/probes/appearance.jsx` (seven objects with two or three fills
  and strokes, over a backdrop where they blend), each rebuilt as a native appearance and drawn on
  the CPU lane: every pixel away from an edge agrees with Illustrator's PNG (worst 0 levels). The
  recording also shows that Illustrator stacks a new fill or stroke above the targeted one and
  centres strokes, and that its scripting model sets opacity and blend mode on the object, not
  the layer — so a layer's own transparency is covered by the engine's tests, not the oracle.

Tests named `*__feat__frames_paths_native_appearance` are the evidence of the feature row
`frames-paths.native-appearance`.

## Consequences

- Any module can give a page item Illustrator's appearance — several fills and strokes, each with
  its own blend, opacity and effects — drawn on both rasterizers and in PDF, edited through the
  catalog's two paths, kept in `.paged`, and brought back from an IDML this engine wrote.
- Documents without appearances are unchanged in every byte the engine writes or hashes.
- Hit testing, snapping and bounds still read the item's own outline and stroke: an extra stroke
  wider than the item's own reaches past what selection sees.
- A text frame has no end cap, join or miter limit of its own, so its stroke layers draw with the
  defaults for those; there is no dash phase in the display list, so a layer has none.
- Live vector effects per layer (Illustrator's Offset Path or Roughen on one fill) are plan WP3.2;
  they join a layer's effect stack when the engine has them.
- The synthetic fallback drop shadow of `PipelineOptions` is not drawn under an item with an
  appearance.
