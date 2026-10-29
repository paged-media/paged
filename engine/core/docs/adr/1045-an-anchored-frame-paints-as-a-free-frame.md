# ADR 1045 — An anchored frame paints as a free frame does

- **Status:** Accepted 2026-10-29.
- **Scope:** protocol v78 (additive; no bump). `paged-model` (`AnchoredFrame`: the look fields,
  `has_transparency`, `EffectBearing`); `paged-renderer` (`pipeline/anchored.rs`:
  `synthetic_rectangle`, `paints_with_picture`, `AnchoredLook`, the picture pass);
  `paged-mutate` (`apply/anchored_look.rs`, the finders in `apply/helpers.rs`,
  `apply/effect_stack.rs`'s `find_bearing_mut`, `Operation::InsertAnchoredFrame::restore`);
  `idml-import` (`anchored_fx.rs`, `effect_xml.rs`, the story reader); `idml-export`
  (`inline_objects.rs`); `paged-canvas` (`export_losses.rs`). Extends
  [ADR 1008](1008-an-items-effects-are-an-ordered-stack.md) and
  [ADR 203](203-a-frames-effects-apply-to-its-picture.md). Plan WP10.3, WP10.4 and Phase 11 C2.

## Context

An anchored frame — an inline or anchored picture, box or text frame inside a story, the
form paged.doc places every Word picture in (`insertAnchoredFrame`, doc ADR 600) — carried its
geometry, its anchored-object setting, a fill and stroke colour, and nothing else. The renderer
drew it through a rectangle it synthesised with every transparency field empty, the mutation
paths found only page items on spreads, and the IDML reader skipped the blocks inside it. A
Word picture's look (a shadow, a glow, a soft edge, a translucent picture: doc ADR 618), lowered
by the shared DrawingML mapper, had nowhere to go and was reported as not shown. InDesign's
anchored objects carry the same transparency settings as any page item.

## Decision

**The model.** `AnchoredFrame` carries the free frames' own look fields, with their types: the
object's opacity, blend mode, drop shadow, `FrameEffects` and the ordered effect stack, the
fill, stroke and content targets (`TargetTransparency`) with their drop shadows, the gradient
fill's length and start, and the stroke's type, dash, alignment, cap, join and miter limit. Each
is `serde(default)` and left out while unset, so an anchored frame without a look serialises and
hashes byte for byte as before (`PGM_FORMAT_VERSION` does not move). `AnchoredFrame` implements
`EffectBearing` with the same macro the free frames use: its stack is ADR 1008's, canonical form
included.

**Render.** The anchored pass already drew a frame by synthesising a `Rectangle` and handing it
to `emit_rectangle_into`; the synthesised rectangle now copies the look, so every lane paints it
through the modules a free frame uses — CPU and Vello rasterizers and the PDF exporter read the
same display list, which is what keeps them in agreement
([ADR 146](146-the-gpu-lane-is-held-to-the-cpu-lane.md)). A picture used to be painted in a
later pass, apart from its frame; a frame's effects must take its picture in (ADR 203). A
picture frame WITH a look is therefore painted whole in the picture pass — fill, picture as the
run's content, stroke — and its body is not drawn in the story pass; a frame WITHOUT a look keeps
its two passes, and its display list, unchanged. An unfilled, unstroked picture frame (Word's and
Office's pictures) casts its object shadow from its picture, stamped under the picture inside the
object's group: the outline-cast shadow of a free frame finds nothing to cast from on such a
frame. A gradient start is in the frame's own box and moves with it onto the page.

**Edit.** An anchored frame is addressed by its own page-item id, as its anchored-object
settings are (W1.16). The free frames' paths reach it: fill and stroke colour, stroke weight,
tint and opacity directly; the stroke style, the gradient placement, the blend mode, the drop
shadow and the other InDesign effects through the finders every path arm already uses (each
falls back to the anchored frame when no page item on a spread has the id); the effect stack
paths through `find_bearing_mut`. No `PropertyPath` is added, so the wire, the schema and the
catalog do not change. An anchored GROUP's look stays refused: the renderer draws its members,
not a look of the group's own, and a look is never stored undrawn. The canvas already rebuilds
the host story for any edit to an item not on a spread, so a later edit redraws. A
`RemoveAnchoredFrame`'s inverse carries the removed frame whole (`InsertAnchoredFrame::restore`,
JSON; an engine-internal operation field, not wire), so its undo restores the look, the setting
and a group's members exactly ([ADR 197](197-undo-restores-the-model-exactly.md)).

**IDML.** InDesign anchored objects carry these settings natively, so they travel as InDesign's
own: the reader takes the `<TransparencySetting>`, `<Fill|Stroke|ContentTransparencySetting>`
and a picture's own `<TransparencySetting>` inside `<Image>` from the story (a cursor keyed by
the anchored stack's depth, so a group member's blocks never reach its group), with the effect
readers the spread reader now shares (`effect_xml`); the writer emits the same blocks
(`effects::write_item_transparency`) and the stroke and gradient attributes. What the stack adds
rides the item's `paged:effectStack` label in its `<Properties>`, as ADR 1008 does for free
frames, and `idml_export_losses` names an anchored frame's stack-only effects and a changed
InDesign order. A source story whose anchored objects' looks the model changed is written fresh
(the patch lane passes an object's source bytes through).

## Evidence

- `crates/paged-renderer/tests/it/anchored_effects.rs`: the reader takes the look; a frame
  without one paints as before; a picture's shadow, opacity, feather and blur take the picture
  in (display-list order and CPU pixels); a filled frame casts its shadow from its outline.
- `crates/paged-export-pdf/tests/it/anchored_effects.rs`: a blur is rasterised and reported;
  opacity is a graphics state.
- `crates/paged-mutate/src/lib.rs` (`frame_paths_reach_an_anchored_frame…`,
  `an_anchored_frame_without_a_look_serialises_as_before…`): every path, exact inverses, the
  group refusal, the removal's exact undo.
- `crates/paged-canvas/tests/it/anchored_effects.rs`: the lowering batch (insert, bind, look)
  is one undo step to the exact state hash and draws; a later stack edit redraws; `.paged` and
  IDML round trips, the label and the loss line.

Tests named `*__feat__anchored_inline_objects_anchored_effects` are the evidence of the feature
row `anchored-inline-objects.anchored-effects`.

## Consequences

- paged.doc's pictures show their DrawingML look; any module that places anchored frames
  writes their look through the paths it already uses for free frames (the shared translator,
  plugin-sdk's `nativeFxOps`, extensions ADR 347).
- Not covered: an anchored text frame's effects apply to its box, not its text (its story is
  laid out in the anchored pass after the box); an anchored group's own look; reads of the look
  through `getElementProperties` on an anchored frame (it lists the anchored-object rows; the
  host panels read free frames); a source story with footnotes keeps the patch lane, which does
  not rewrite an anchored object's changed look.
