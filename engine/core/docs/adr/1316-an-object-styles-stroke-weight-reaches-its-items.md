# ADR 1316 — An object style's stroke weight reaches the items that apply it

- **Status:** Accepted 2026-11-18.
- **Scope:** `paged-renderer` (`module/object_style.rs`, `object_style_cascade`). No wire, model
  or catalog change. Extends the object-style cascade of
  [ADR 137](137-object-style-text-frame-options.md), [ADR 143](143-object-style-wrap-and-anchoring.md)
  and [ADR 149](149-corners-are-read-per-corner.md).

## Context

An item that applies an object style takes from it what it does not state itself. The renderer
folded the style's fill colour, fill tint, stroke colour and corners into such an item, but not
its stroke weight. A comment explained why: the resolved frame once held the weight as a plain
number, already defaulted to 1 pt, so the cascade could not tell "no weight" from "1 pt" and left
it alone, on the reasoning that an InDesign export states the weight on the item whenever the
style uses it. The resolved frame has since held the weight as an option (`None` when the item
states none, the 1 pt default applied only when it is drawn), and the reason no longer held.

Scripts showed the cost: `paged.createObjectStyle`, then `paged.setStyleProperty('object', style,
'frameStrokeWeight', 3)` with a stroke colour, then `paged.set(frame, 'appliedObjectStyle',
style)`. Every write landed: the style held 3 pt and the frame named the style. The frame was
stroked at 1 pt, the default, because a frame made by `insertTextFrame` or `insertFrame` states no
weight. The style's colour reached it; its weight did not.

## Decision

The stroke weight cascades exactly as the stroke colour does: an item that states no weight is
stroked at its object style's, resolved through `BasedOn` and switched off with the style's
stroke category (`ResolvedObject::merge_below` already resolved it); the 1 pt default applies only
when neither states one. An item's own weight is a local override and wins.

Every consumer of the resolved frame takes the cascaded weight with it: the stroke drawn, the
stroke's reach that effects (shadows, feathers) are sized by, and a text frame's text inset (the
stroke's share of it, which moves the text only when the stroke is drawn).

## Evidence

- `crates/paged-renderer/tests/it/object_style_stroke.rs` (four of its six cases fail without
  the cascade): a styled rectangle and a styled text frame are stroked at the style's 3 pt; the
  item's own 0.5 pt wins; the weight cascades through `BasedOn`; a style with its stroke category
  off, or with no weight, leaves the 1 pt default; the raster's top edge is as thick as a
  rectangle stating 3 pt.
- `crates/paged-canvas/tests/it/object_style_stroke_weight.rs`: the writes a script makes (create
  the style, set its weight and colours, apply it to a minted text frame) draw a 3 pt stroke; a
  local weight overrides it and undoing the override restores it; removing the style removes the
  stroke; changing the style's weight reaches the frame.

## Consequences

- An IDML item that leaves its weight to its object style is now drawn at the style's weight,
  as InDesign draws it. The generated fixtures' styles that carry a weight are not applied to
  items without one, so their renders do not move.
- Two consumers still read the item's own stroke, not the cascaded one, and are unchanged: a text
  wrap's contour reach (`pipeline/geom.rs`, which reads the item's own colour as well) and a path's
  text-on-path offset. The single-canvas `pipeline::build` (kept for back-compat) cascades no
  object style at all; `build_document`, which every surface draws with, does.
- A frame's own stroke tint is not modelled (the importer reads `StrokeTint` on an object style
  only), so `objectStyleStrokeTint` has nothing to cascade into; it is kept and written back to
  IDML, and drawing it needs a frame stroke tint first.
