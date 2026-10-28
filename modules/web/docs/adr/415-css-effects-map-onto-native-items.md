# ADR 415 — An element's CSS effects travel beside the layer as groups and map onto native items

- **Status:** Accepted, 2026-10-28.
- **Scope:** `packages/web-render/src/effects.rs`, `fx_capture.rs`, `capture.rs` (the sink's
  layer kinds), `lower.rs`, `flow.rs` (band filtering), `boundary.rs` and the `take_effects`
  export; `packages/web-bundle/src/bake-plan.ts` (`planEffects`, `bakeBatchOps`),
  `bake-to-document.ts`, `engine-loader.ts`; `packages/web-model/src/render.ts`
  (`SceneEffectGroup`). Extends [ADR 407](407-baking-flattens-to-native-items.md).

## Context

A web frame's CSS can give an element an `opacity`, a `mix-blend-mode`, `isolation`, a
`filter` list, a `clip-path` or a `mask-image`. These apply to the element as a whole: an
element with `opacity: 0.5` fades its background, borders, text and children together, not
each of them. The native page model has the same vocabulary: a group's opacity, blend mode and
isolation, an item's drop shadow and inner shadow, a clip group (engine ADR 1010) and an opacity
mask.

The bake (ADR 407) builds native items from the scene layer the canvas composes. That layer is
flat: one item per painted primitive, with no group, so it cannot say which items belong to
one element. The layout engine's paint stream says it only in part. It pushes a layer for an
element with `opacity` or `filter` (with the opacity and the filter graph), a clip layer for a
`clip-path`, and an isolation layer plus a `DestIn` layer for a mask; it pushes nothing for
`mix-blend-mode` or `isolation`, which it does not paint. A layer carries no element: the
paint sink cannot tell an element's `clip-path` from an ancestor's overflow clip, nor which
CSS function a colour matrix came from.

Three ways to get element-level effects to the bake were considered:

- **Put groups on the C-1 wire.** The canvas would compose them too, but it is an engine
  protocol change (a new scene item and its composition), outside this module.
- **Match elements to paint by geometry** (an element's border box against layer clips and
  item bounds). An element with `mix-blend-mode` has no layer to match, siblings can share a
  box, and a near miss mis-assigns effects without saying so.
- **Make the paint name the element.** Before the paint the capture tags each element with
  effects so that its layer carries its node id; the sink then knows exactly which element a
  layer belongs to and reads its effects from the style system.

## Decision

- **Effect groups ride beside the layer.** The layer the canvas composes is unchanged. A
  render records, per layer, a list of effect groups — `[start, end)` item ranges in painter's
  order with a `parent`, the element's opacity, blend mode (IDML spelling), isolation, filter
  functions (in their CSS identity, lengths in points), clip outline and mask paint — and the
  loss keys of effects no item carries. The `take_effects` export hands the last render's
  list to the bundle once, the way `take_text_advances` does; a render that is not baked
  carries nothing extra.
- **The capture tags elements through `filter`.** Every element whose computed style has an
  effect a group carries gets one more function at the end of its `filter` list: a
  transparent `drop-shadow(0 0 0 …)` whose RGB channels encode its node id. A filter forces
  the layout engine to push the element's layer; the tag is an identity filter and the sink
  renders no filter, so nothing painted changes; the same node gets the same tag in every
  capture of a flow, so only the first restyles. The element's own filter functions are
  written back in front of the tag from their computed values. (The pinned Stylo parses no
  `backdrop-filter`, which would otherwise have been the carrier.)
- **The sink opens a group on a tagged layer and closes it on its pop.** The clip layer
  directly outside it (outside the mask's isolation layer, when there is one) is the
  element's `clip-path`; the `DestIn` layer painted after the group closes is its mask, and
  what it paints goes into the group, not the display list. An element with effects whose
  layer never arrives although it has a visible box, and any inline element with effects
  (painted with its formatting context, never as its own layer), is reported
  (`cssEffect.unattributed`, `cssEffect.inline`).
- **The bake maps innermost first.** An element whose items bake to one item folds its
  effects into that item: opacity multiplies into the item's, blend mode, drop shadow and mask
  go on the item. Several items become a native group of them (`createGroup`) carrying the
  opacity, blend mode and isolation; a `clip-path` makes a clip group whose top member is a
  path of the outline. A blend inside a blend wraps the inner node so both apply. A gradient
  mask becomes a luminosity opacity mask whose grey levels are the gradient's alpha; an image
  mask an alpha mask of the image. An inset box shadow becomes the native inner shadow of the
  box it is cast in (Normal blend, as CSS composites it). All of it is in the bake's one batch.
- **What has no native twin is a loss, by key**, in the bake's deferred report:
  `filter.blur` (the engine has no Gaussian blur effect yet), `filter.<function>` for the
  colour filters (the engine's image-adjustment stack is not on this branch),
  `filter.url`, `filter.dropShadow.group` (a group's drop shadow is not settable),
  `filter.dropShadow.multiple`, `filter.dropShadow.stacked`, `mask.group` and `mask.text`
  (an opacity mask targets one shape), `mask.unsupported`, `clipPath.url`,
  `clipPath.unsupported`, `backgroundBlendMode`, `mixBlendMode.plusLighter`,
  `innerShadow.noShape`, `innerShadow.stacked`.

## Evidence

- `packages/web-render/src/fx_capture.rs` — reading the computed effects, the tag, its decoding
  from a layer's filter graph; tests for each effect against the real layout engine.
- `packages/web-render/src/capture.rs` — `LayerKind`, `open_group`, `push_layer`, `pop_layer`,
  `emit` (mask paint diverted).
- `packages/web-render/src/lower.rs` — `PushGroup`/`PopGroup` to item ranges, `nest_groups`.
- `packages/web-bundle/src/bake-plan.ts` — `planEffects`, `planMask`, `effectOps`, the group and
  mask ops in `bakeBatchOps`; `test/bake-effects.spec.ts` (one spec per mapping);
  `test/conformance/bake-effects.spec.ts` (an HTML fixture rendered by the real engine and
  baked through the real host, read back from the document).

## Consequences

The canvas still paints none of these element effects: they exist only where the bake puts
them. Lighting them up on the canvas needs a group item on the C-1 wire (the engine's scene
layer), the follow-on this record leaves open; the effect groups are the data it would carry.

Capturing a document with effects costs one extra restyle (none for a document without, and
none for a flow's later frames). Elements are tagged up to node id 2^24 − 1; a later one is
reported, not tagged.

A native group takes the z-order slot of its topmost member; a clip group, whose clip path is
created last, sits on top of the frame's baked items. The bake already creates items by kind,
not in paint order (ADR 407).

The bake reports more keys than before; a consumer that compared the deferred report with a
fixed set sees new names, never fewer items.

## Related

- [ADR 407](407-baking-flattens-to-native-items.md) — the bake this extends
- [ADR 403](403-json-wasm-boundary.md) — the JSON boundary `take_effects` joins
- Engine ADR 1010 (clip groups), engine C-28 (opacity masks), engine ADR 1037 (the
  image-adjustment stack the colour filters will map to)
