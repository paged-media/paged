# ADR 1042 — Live vector effects are entries of the effect stack

- **Status:** Accepted 2026-10-29.
- **Scope:** protocol v78 (rides it: `expandAppearance` is a new `Mutation`
  and `Operation`, added before v78's first consumer sync; the vector
  kinds, their fields and `groupEffectStack` are additive). New crates
  `paged-geom` (the path kernels, moved from `paged-mutate`, which
  re-exports them) and `paged-vector-fx` (the effects, the cache, `bake`);
  `paged-model` (`vector_effect`: the parameter types and the IDML label;
  the `Effect` variants; `Group::effect_stack`); `paged-renderer` (the
  emitters draw the baked item; a group with a Pathfinder effect is one
  polygon); `paged-mutate` (`EffectKind`'s vector kinds and
  `EffectEntrySpec`'s fields, `PropertyPath::GroupEffectStack`,
  `Operation::ExpandAppearance`, the booleans read the effected outline);
  `paged-canvas` (hit testing and point snapping, the loss lines, the
  wire translation); `idml-export` (`vector_fx`: the bake on export) and
  `idml-import` (the lift). Amends [ADR 1008](1008-an-items-effects-are-an-ordered-stack.md).
  Plan WP3.2; gaps D-12, D-27, D-28, D-29, D-30, D-31 (Scribble, Round
  Corners).

## Context

Illustrator's Distort & Transform, Path, Pathfinder, Stylize and Convert
to Shape effects change an object's geometry LIVE: the path stays as
drawn, the effect computes what is shown, and Expand Appearance makes it
permanent. paged.draw had none of them as effects (its brushes and
distortions write geometry once), and InDesign has none at all. The
engine's ordered effect stack (ADR 1008) already says what an item's
effects are and in which order; the modules and the host panels need the
vector ones in the same place, on every rasterizer, in PDF and through
IDML.

## Decision

**They are stack entries.** `Effect` gains `roughen`, `zigZag`,
`puckerBloat`, `twist`, `tweak`, `transformCopies`, `freeDistort`, `warp`,
`offsetPath`, `outlinePath` (Illustrator's Outline Stroke; the stack's
`outlineStroke` is Photoshop's layer-style Stroke), `roundCorners`,
`scribble`, `convertToShape` and `pathfinder`, each with its parameters
(`paged_model::vector_effect`, every field defaulted). They live on the
OBJECT target's stack of text frames, rectangles, ovals and polygons; a
group gets a stack of its own (`Group::effect_stack`, vector kinds only),
where a `pathfinder` entry makes it a compound shape. A `pathfinder` entry
on an item is refused (`GroupOnly`).

**Geometry first, in order.** The enabled vector entries run, in their
order among themselves, on the item's SOURCE outline (its anchors, its box,
an oval's ellipse); the paint and raster entries of ADR 1008 then act on
the result. `paged-vector-fx::apply_stack` computes it and caches it by a
hash of the source, the entries and the stroke (per thread, bounded). Two
effects move paint: Outline Stroke fills the stroke's band with the stroke
paint and drops the stroke; Scribble's outline is filled and not stroked.
Live corner options are not applied under a vector effect.

**The build draws the baked item.** `paged_vector_fx::bake` turns an item
into the item its effected outline describes — the path replaced, the
bounds those of the outline, the vector entries gone from the stack, the
paint moved — and the renderer's emitters draw that (an oval as a
polygon). A group with a Pathfinder entry is drawn as one polygon in its
members' place, painted as its frontmost member (its backmost for Minus
Front), in spread space. So both rasterizers and PDF export draw the
effect from one display list; an item without vector entries builds the
same list, byte for byte, as before.

**Editing stays on the source.** The anchor tools edit the source path;
the effect follows. Hit testing grows an item's hit box to its effected
outline (selection still reports the source box), point snapping snaps to
the effected outline's points and segments (which name no editable
anchor), and the Pathfinder booleans and the planar arrangement read the
effected outline, spending the kept item's vector entries.

**Expand Appearance** (`expandAppearance { elementId }`) keeps the baked
item for good: in place for a rectangle, polygon or text frame (the
inverse restores the struct); an oval becomes a polygon of its id, a group
with a Pathfinder entry one polygon of the group's id where the group
was. One undo step, which undoes to the exact state hash. A group holding
a text frame, a group or a symbol instance is refused (expanding would
take that content with it).

**IDML.** IDML has no live vector effect, so the writer bakes on a copy
of the model (`idml-export::vector_fx`): a rectangle, polygon or text
frame keeps its element with the effected path; an oval becomes a polygon
`<id>vfx`; a group keeps its element with one polygon `<id>vfx` for its
members. The source (the item, or the group and its members) rides the
written item's `<Label>` under `paged:vectorSource` with a fingerprint of
the outline written; the stack rides `paged:effectStack` as before. The
reader (`vector_effect::label::lift`, which reaches no geometry kernel)
restores the source when the outline is the one written; an outline
InDesign changed stays, without the vector entries. The export's loss
report names every baked item.

**The algorithms, and the oracle.** Illustrator 30.1 was asked through
`applyEffect` + `expandStyle` (draw's `vector-effects` probe; the effect
names and dictionary keys are strings in its plug-ins) and the replay
(`paged-vector-fx/tests/it/illustrator_oracle.rs`) holds the engine to
it:

| effect | construction | agreement |
| --- | --- | --- |
| Zig Zag | `ridges` points per segment at equal arc length; every point moves `size` along the normal of its neighbours' chord, alternating, the first outward; smooth handles along the chord, half the spacing | every anchor and handle to 0.01 pt (one handle: a recorded convention) |
| Pucker & Bloat | anchors `P + f(C − P)`, handles `H − f(C − H)`, `C` the box centre, `f` the percentage | exact |
| Round Corners | cut `radius` along each straight edge at a corner, handles 0.55 · radius back towards it | exact |
| Offset Path | the editor's offset kernel | area 0.1 %, bounds 0.05 pt |
| Transform | copy `i` is the source transformed `i` times about the original box's pin | exact |
| Twist | turn by `angle · (1 − d / R)` about the box centre, edges cut until within 0.1 pt | bounds 1.5 pt, area 1.5 % (Illustrator rounds to whole points) |
| Roughen | `round(length / 72 · detail)` pieces per segment, each point moved along its normal within `±size / 2` | piece count exact; statistics |
| Tweak | anchors and handles moved within the amounts | statistics |

Seeded effects (Roughen, Tweak, Scribble) draw from their `seed`
(SplitMix64), never the clock: one seed, one outline, everywhere.
Illustrator's own sequence is not reproducible (its two recordings of one
case differ), so they are compared statistically. Warp could not be
recorded: `Adobe Deform` changed nothing through `applyEffect` with every
dictionary tried, and a malformed probe left Illustrator computing; its
fifteen styles are closed-form maps of this engine's over the box
(`warp.rs` says so), and Free Distort is the projective map of the box's
corners (`paged-warp`'s homography), its dictionary's frame not yet
settled against Illustrator. Scribble and Convert to Shape have no oracle
case yet.

## Evidence

- `crates/paged-vector-fx/tests/it/`: one test per effect, properties over
  random outlines (finite output, identity parameters, seeds), `bake`,
  and the Illustrator replay.
- `crates/paged-renderer/tests/it/vector_effects.rs`: the drawn effect, a
  switched-off entry draws the source, an oval as a path, Outline Stroke's
  band, a group's Pathfinder effect, and (feature `gpu`) the two lanes
  agree.
- `crates/paged-canvas/tests/it/vector_effects.rs`: the stack paths, hit
  testing and snapping, a boolean over an effected item, Expand
  Appearance's undo, and the IDML round trip with its loss lines.
- `crates/paged-mutate/src/vector_effect_spec.rs`: every vector kind round
  trips through the wire spec; bad values are refused.

Tests named `*__feat__effects_transparency_live_vector_effects` are the
evidence of the feature row `effects-transparency.live-vector-effects`.

## Consequences

- Any page item a module makes can carry live vector effects, drawn the
  same on both lanes and in PDF, editable at the source, and a group can
  be a compound shape.
- `paged-geom` is the one home of the path kernels (plan C8); the renderer
  links them, the read-only viewer included.
- Not in this decision: Envelope Distort (the mesh warp), brushes along a
  path and variable-width strokes as effects (plan WP3.2's later rows),
  vector effects on a text frame's GLYPHS (the frame's outline only),
  Warp and Free Distort recorded against Illustrator, and the host panels
  (WP4.3) and paged.draw's effect UI (WP6.3).
