# ADR 1053 — A stroke style draws the stroke along the path: width profiles and brushes

- **Status:** Accepted 2026-10-31.
- **Scope:** protocol v78 (rides it: two `EffectKind` members and their
  `EffectEntrySpec` fields are additive, ADR 1042's precedent).
  `paged-model` (`vector_effect`: `WidthProfileParams`, `WidthPoint`,
  `BrushParams`, `BrushKind`, `BrushArt`, `STROKE_STYLE_KINDS`, the
  `paged:strokeArtOf` label and its lift; `effect_stack`:
  `Effect::WidthProfile`, `Effect::Brush`, `is_stroke_style`,
  `has_stroke_style`; `appearance`: `AppearanceParts::effect_stack_mut`);
  `paged-vector-fx` (`stroke_style`: the outlines; `bake`: the split);
  `paged-renderer` (`pipeline/appearance.rs`: the split parts; the four
  emitters route a split item there); `paged-mutate` (the two kinds and
  their fields, refused on a group's stack; Expand Appearance refuses a
  split item); `paged-introspect` (two rows, `strokeStyle: true`,
  category `stroke`); `paged-canvas` (the loss line names the split);
  `idml-export` (`vector_fx`: the split on export; `rewrite`: a
  rewritten item's contours beyond the source's are written and
  `PathOpen` follows the model). Builds on [ADR 1042](1042-live-vector-effects-are-stack-entries.md)
  and [ADR 1043](1043-an-item-has-several-fills-and-strokes.md). Plan
  WP6.4; gaps D-22, D-23, D-24, D-26.

## Context

Illustrator keeps a stroke's width and its brush LIVE: the Width tool's
width points and a width profile shape the stroke along the path, and an
Art, Scatter, Pattern or Bristle brush draws artwork along it, while the
path keeps its anchors. paged.draw had both only as bakes — the Width
tool and the Paintbrush wrote `outlineStrokeVariable`, which replaces the
centreline with its outline — and the engine's variable-width kernel
(ADR 1019, `paged-geom::stroke_kernel`) was reachable only that way. A
module, the host panels and the exporters need the stroke style where
ADR 1042 put the live vector effects: on the item, drawn by the build.

## Decision

**Two vector kinds, the stroke styles.** `widthProfile { points: [{ t,
width }] }` — at arc-length fraction `t` of each contour the stroke is
`width` × its weight wide, eased between points by smoothstep and held
past the first and last; no points is the uniform stroke. `brush {
brushType, art, scalePct, spacingPct, scatterPct, rotateDeg,
rotateVariationDeg, sizeMinPct, flipAlong, flipAcross, tileAspect,
bristles, bristleThicknessPct, seed }` — the artwork is in the brush
frame (`x` 0..1 along, `y` ±0.5 across, positive to the left), the
model's anchor convention; empty is the kind's built-in artwork (a lens,
a chain of diamonds, a dot). Every field is defaulted. They are vector
entries of the object stack (ADR 1042: they run in order with the other
vector entries, on the source outline), refused on a group's stack (it
has no stroke), and described by introspection with `strokeStyle: true`
in a category of their own, `stroke`, which is not an Effect menu group:
the Stroke and Brushes panels and the Width tool apply them.

**What they draw.** The stroke's artwork as a filled outline, painted
with the stroke's paint (`PaintRole::StrokeAsFill`, Illustrator's Tints
colourisation); an item that strokes nothing draws no stroke style. A
width profile samples 129 stops over each contour and runs the variable
width kernel of ADR 1019 with the item's caps, joins and miter limit (the
centreline is cut first so a straight segment has vertices to carry the
profile). Art bends the artwork onto the contour (`x` to arc length,
`y` along the left normal × the band). Pattern lays `round(L / pitch)`
tiles end to end, stretched to fit exactly. Scatter places rigid copies
`pitch` apart, turned with the path, moved and resized from the seed
(SplitMix64). Bristle draws strands across the band, each a thin
variable-width stroke tapering at its ends, from the seed. A width
profile and a brush on one item combine: the brush is as wide as the
profile says and the profile draws nothing of its own. Opacity per
bristle and artwork with its own colours are not drawn (one paint).

**The fill stays: the split.** A stroke style replaces the STROKE; the
item's fill, picture and appearance stay on the source outline. One
baked item cannot carry two outlines, so an item whose stroke style sits
beside a fill, a picture, text on a path or an appearance is SPLIT
(`bake::*_splits`): its fill part (the item, stroke off, the stroke
styles out of its stack, its other vector entries applied) and its
stroke part (fill off), whose bake is the artwork. The renderer draws the
two as the parts of one appearance (ADR 1043's `emit_*`, the split
`parts`): the item's opacity and blend mode wrap both, its object
effects apply to the run once. A stroke-only item takes ADR 1042's
in-place bake. Hit testing, snapping and booleans read the effected
outline (the artwork), as for any vector effect.

**IDML.** A stroke-only item is written baked in place (ADR 1042). A
split item is written as its fill part and a polygon `<id>vfx` of the
artwork right after it in every list that names it, labelled
`paged:strokeArtOf` with the item's id; the item's `paged:vectorSource`
label keeps the whole source. The reader restores the item when its
outline is the one written and drops the artwork polygon with it; when
InDesign changed the item, both stay as InDesign has them. The loss
report names each item, and the split. The writer's in-place path
rewrite, which kept the source's contour count, now writes the model's
contours beyond it and re-flags `PathOpen` where the model changed it,
so an outline of several contours (a scatter, a ring) survives; a model
with fewer contours than its source still passes the source's extra
contours through (a known limit of the byte-preserving rewrite).

**Expand Appearance** keeps a stroke-only item's artwork for good (ADR
1042), and refuses a split item rather than drop its fill.

## Evidence

- `crates/paged-vector-fx/tests/it/stroke_style.rs`: the band's width
  where the points say, easing and normalisation, Art's stretch and its
  width profile, Pattern's whole tiles, Scatter's seed, Bristle's
  strands, custom artwork and flips, the stroke taken once, a profile
  and a brush combined, the in-place bake and the split.
- `crates/paged-renderer/tests/it/brush_strokes.rs`: a width profile
  swells the band where its points say and the fill stays, a pattern
  brush's diamonds in the stroke's colour, a switched-off entry draws the
  plain stroke byte for byte, and (feature `gpu`) the two lanes agree.
- `crates/paged-canvas/tests/it/stroke_styles.rs`: the stack path with
  both kinds and their undo, refusals (a bad brush type, a group),
  Expand Appearance, and the IDML round trip (the artwork after its
  item, the losses, the live stroke style back, the stand-in gone).
- `crates/paged-mutate/src/vector_effect_spec.rs`: every vector kind,
  these two included, round-trips through the wire spec.
- paged.draw's `test/oracle/brushes.spec.ts`: Illustrator 30.1's art
  brush, recorded on three lengths (`scripts/illustrator/probes/
  brushes.jsx`), is a stretch of one artwork along the path, and the
  engine draws the recorded 303 and 420 pt results from the 200 pt one
  anchor for anchor to 0.01 pt (the band's width set to the artwork's
  height: Illustrator's convention is the artwork's own size at 1 pt).

Tests named `*__feat__plugin_draw_brushes_width` are the evidence of the
feature row `plugin-draw.brushes-width`.

## Consequences

- Any page item can carry a live variable-width or brushed stroke, drawn
  alike on both lanes and in PDF, its path editable; paged.draw's Width
  tool, Paintbrush, Blob Brush and Brushes panel write these entries
  (draw ADR 366).
- Not in this decision: per-side (asymmetric) width points, a stroke
  style on an appearance's extra stroke layers, artwork drawn in its own
  colours, bristle opacity, the corner tiles of a pattern brush, a
  document-level brush table in the model (paged.draw keeps its library
  in a container part), and Illustrator recordings of the brushes (the
  constructions above are this engine's).
