# ADR 203 — A frame's feathers and interior effects apply to its picture

- **Status:** Accepted 2026-10-20.
- **Scope:** the frame emitters in `crates/paged-renderer/src/pipeline/{shapes,text_path}.rs`
  and `module/effects.rs`; `DisplayCommand::BeginFeatheredObject` and
  `paged_compose::mask::feather_run_starts`; the feather arms of both raster lanes
  (`paged-gpu/src/{vcpu,vello_rs}.rs`) and of the PDF exporter (`paged-export-pdf/src/page.rs`).

## Context

A rectangle, oval or polygon emitted its object effects in two parts: the outer glow before its
fill, and the interior effects (inner shadow, inner glow, bevel and emboss, satin) and the
three feathers (basic, directional, gradient) right after the fill. The frame's placed picture
(an image, a placed PDF or SVG) came after all of them, between the effects and the stroke.

Every lane found the commands a feather masks by walking back from the feather over the
commands that share its `(path_id, transform)`: the CPU lane photographs the target where that
run starts and blends back toward it, the GPU lane opens an isolated layer there and composites
the mask with `DestIn`, and the PDF exporter puts the run under a luminosity soft mask. The
picture was outside that run, so:

- a feather masked the frame's fill only — on a picture frame, which usually has no fill,
  nothing — and the picture painted at full strength over the feathered edge;
- the interior effects painted under the picture, which hid them;
- the PDF exporter found no fill to mask and dropped the feather.

Asked of InDesign (20.x, a page of three 120 pt picture frames exported to PDF): a basic
feather fades the frame's picture at the frame's edge, an inner shadow falls over the picture,
and on a frame with an 8 pt stroke the feather fades the stroke as well, measured from the
stroke's outer edge.

## Decision

1. The interior effects and the feathers are emitted after the frame's picture, before its
   stroke. A frame without a picture emits the same commands in the same order as before.
2. A frame that carries a feather emits `DisplayCommand::BeginFeatheredObject { path_id,
   transform }` before its fill (after its outer glow), naming the path and transform its
   feathers use. It paints nothing.
3. `feather_run_starts` opens a feather's run at the most recent marker that carries the
   feather's own `(path_id, transform)`, and still walks back from there over the same-path
   commands before it, so an outer glow directly before the marker stays in the run as it was.
   Without a matching marker the run is the contiguous same-path stretch, as before. The CPU
   and GPU lanes take their run starts from this one function, so they agree by construction.
4. The PDF exporter opens a soft-masked run at a marker as well, reaching over the picture to
   the first basic or directional feather on the marker's path and the effect commands after
   it. A gradient feather keeps its own encoding and, coming after the picture, now covers it.

The marker is a display-list command rather than a group: a group would change compositing
(isolation, the fill's own target group) and is already spoken for by the transparency
targets. A marker changes nothing a lane draws; it only tells the feather where its object
begins. It carries a path id, so the path-id rebase of cached master text deltas moves it like
any other command.

## Consequences

- A feathered picture frame fades its picture in every lane, and the interior effects show
  over the picture.
- A feather on a frame whose fill sits in its own fill-target group now masks that group too:
  the group's brackets broke the same-path walk before the fill.
- The stroke is still painted after the feather and is not feathered. InDesign feathers it, from
  the stroke's outer edge; doing that needs the feather's mask built on the stroked outline,
  not only the run widened. Left for its own change.
- A text frame's text is emitted in the story pass, long after the frame's effects, and is not
  covered by this record.
- `tests/it/feathered_picture.rs` (renderer: order, run start, pixels for all three feathers and
  the inner shadow; export-pdf: the picture paints under the soft mask);
  `paged-gpu` `vello_effects::a_feather_masks_the_picture_between_its_marker_and_itself`
  (CPU and Vello agree); `paged-compose` `mask::tests::a_marker_opens_the_feather_run_over_foreign_commands`.
