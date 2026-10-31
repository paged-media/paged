# ADR 1046 — A scene layer takes its frame's opacity, blend mode and effects

- **Status:** Accepted 2026-10-30.
- **Scope:** no model, wire or protocol change. `paged-renderer` (`pipeline/shapes.rs`:
  `ModulePainter` on the rectangle, oval, polygon and line emitters; `pipeline/text_path.rs`;
  `pipeline/text_frame.rs`: `emit_frame_module_content`; `pipeline/build_engine.rs`: the
  frame arms); `paged-compose` (`DisplayList::move_tail_to`). Amends
  [ADR 013](013-in-frame-scenelayer.md); applies to the pixel layers of
  [ADR 108](108-plugin-raster-tiles.md), which are scene layers once lowered; builds on
  [ADR 1008](1008-an-items-effects-are-an-ordered-stack.md). Plan WP3.6.

## Context

A plugin draws inside a frame by submitting a `SceneLayer` (ADR 013): the sheet module's
in-frame grid, the web module's page content, a chart, a pixel layer. The renderer lowered
it after the frame's emitter had returned — after the frame's object group had closed and
after its effect stack had wrapped the frame's body. The layer therefore drew on top of the
frame as a separate, opaque run:

- a frame at 50 % opacity faded its fill and stroke but not its scene layer, which also
  covered the faded box instead of compositing with it as one object;
- a frame's blend mode composited the box against the page and the layer `Normal` over it;
- the ordered effect stack (ADR 1008) — a Gaussian blur, noise, a colour adjustment, a soft
  edge, the feathers — applied to the box and left the layer sharp on top;
- an IDML `<Group>`'s transparency, which brackets its members' command spans, ended before
  the last member's scene layer.

The same held for a pixel layer (ADR 108), which the worker lowers into a scene layer, and
for a claimed image provider's tiles (C-6, [the design](../design/image-resource-provider.md)),
which the renderer emits at the same point.

## Decision

**What a module paints into a frame is the frame's own content.** The tiles (C-6) and the
scene layer (C-1) are emitted together (`emit_frame_module_content`) at one place in the
frame's body: after the stroke — the scene layer stays the frontmost content of its frame,
as ADR 013 says — but inside the object's transparency group, inside the run the effect
stack applies to, and before the feathers. The frame's opacity, blend mode, effect stack
and feathers therefore apply to the layer exactly as they apply to the frame's placed
picture.

- **Shapes.** The rectangle, oval, polygon and graphic-line emitters take a second painter
  beside the picture's (`ModulePainter`) and call it at that place on every path through
  the body (the rounded and flat rectangle, the lifted polygon rectangle). Because the call
  is inside the body, the effect stack's run (`effect_stack::apply`) contains it with no
  further bookkeeping, and the frame's command span — which the `<Group>` pass brackets —
  includes it.
- **Text frames.** A text frame's body already returns a slot for its story glyphs inside
  its object group and before its feathers (ADR 204, R-10), moved by the effect stack. The
  module content is emitted after the body and then moved into that slot
  (`DisplayList::move_tail_to`, which keeps glyph-run entries on their commands); the text
  slot moves past it, so the story stays above the layer as it is without a slot.
- **A frame with no group, no stack and no feathers** emits the layer exactly where it did:
  after the body. Its display list, and its digest (ADR 101), do not change.

**Both lanes, and PDF, need nothing new.** The layer lowers to the same commands as before;
they now sit inside `BeginBlendGroup` / `PushLayer` brackets the CPU rasterizer, the Vello
lane (whose effect layers are the CPU's own raster, ADR 1008) and the PDF writer already
draw. In PDF a faded frame's box and layer go into ONE transparency-group form drawn at the
frame's opacity, and a filtered frame's layer is rasterised with the box into the layer
image the export reports as `effect_rasterized`.

**Not covered.** Master-page items, anchored frames and frames pasted into a container
(B-18) have never taken a scene layer; that is unchanged. Scene-layer text keeps its
upright-in-page-space glyphs (ADR 013).

## Evidence

- `crates/paged-renderer/tests/it/scene_layer_effects.rs`: the layer sits in a frame's
  50 % group and is drawn faded with the box as one object; in its `Multiply` group; inside
  its blur layer, with the edge graded; a plain frame keeps it on top and opaque; a text
  frame's layer sits in the frame's group.
- `crates/paged-gpu/tests/it/scene_layer_parity.rs`: a scene layer (clipped fill, gradient,
  image) inside a 50 % `Multiply` group, a blur layer and a colour-adjustment layer draws
  alike on both lanes ([ADR 146](146-the-gpu-lane-is-held-to-the-cpu-lane.md); worst channel
  delta 2 on Metal, budget 24).
- `crates/paged-export-pdf/tests/it/scene_layer_effects.rs`: one group form holds the box
  and the layer; a blurred frame leaves neither vector and places one layer image.
- `crates/paged-compose/src/display_list.rs` (`move_tail_to_moves_commands_and_their_glyph_runs`).
