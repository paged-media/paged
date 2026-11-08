# ADR 529 — Picture frames take the crop and the filter stack

- **Status:** Accepted, 2026-11-08. Extends 526 (pictures) and 527 (a picture's look through the
  shared mapper); builds on engine ADR 1037 (an image frame has a filter stack) and 1045
  (amendment 2026-11-02: an image frame's placement) and on doc ADR 623 (the same crop).
- **Scope:** `sheet-xlsx/src/parts/pictures.rs`, `sheet-chart/src/native.rs`
  (`picture_look`, `picture_placed`, `crop_placement`), `sheet-js/src/core/annotations.rs`,
  `platform/shared/dml-native` (`Lowering::picture_filters`, the public `RasterOp`), the host
  model's `lowered.ts` and `table-pictures.ts`.

## Context

The page already placed every drawing picture as an engine image frame (`insertFrame` and
`placeImage`, ADR 526) with its opacity and effects (ADR 527). Two things of an `xdr:pic` still
did not reach that frame, so the engine could neither draw nor edit them:

- the crop (`a:srcRect`): the picture was squeezed whole into the cropped box;
- the picture corrections of its `a:blip` (`a:lum`, `a:duotone`, `a:grayscl`, `a:biLevel`,
  `a:hsl`, `a:clrRepl`, `a:blur`): each was listed as a loss ("not carried on the native lane").

The engine holds both: a free frame takes an inner image transform (`imageContentTransform`) and
a filter stack (`frameImageAdjustments`), and paged.slide and paged.doc already set them
(slide ADR 723, doc ADR 623).

## Decision

1. **Read.** `SheetPicture::dml` is also kept for a picture whose only look is a crop.
2. **One mapper.** `dml_native::native::Lowering::picture_filters` returns the opacity factor and
   the filter stack of a blip (`Mapper::picture_at`, the mapping slide uses, with the picture's
   pixel density so a blur radius is in the image's own pixels). The ops the mapper has no
   equivalent for (`a:clrChange`, `a:tint`) stay reported; the Office 2010 corrections stay out,
   they are already in the stored image. The page's `picture_fx` became `picture_look`
   (`PictureLook { fx, adjustments, losses }`).
3. **The crop is the placement of the image in its frame**, the mapping of slide's and doc's
   pictures: shown at `w / (1 - l - r)` by `h / (1 - t - b)` with its top-left corner `l` and `t`
   of that outside the frame, over the pixel size the image's header gives
   (`crop_placement`; no crop, a padding crop, a crop that leaves nothing, or a picture whose
   size the bytes do not give, is no placement and shows whole).
4. **Place.** `PictureInfo` / `PagePicture` carry `adjustments` and `placement`; the table's
   picture ops set `imageContentTransform` (after `placeImage`, which fits the image whole) and
   `frameImageAdjustments` on the frame's handle, in the batch that makes the frame, so one
   undo step removes the picture with its look. The engine draws them in every output (canvas,
   PDF, export) and the picture panel edits the stack.
5. **Unchanged.** A picture with neither a crop nor a correction produces the same ops as before;
   the workbook is never written for any of this (a picture of the page is regenerated from the
   file).

## Consequences

- A cropped Excel picture shows the cropped part, and a grayscale, brightness/contrast, duotone,
  threshold, hue/saturation or blur picture shows that look, on the page, with no loss line.
- The in-frame grid (`GridScene.pictures`) still draws the whole image through the surface's
  image cache; it neither crops nor filters (follow-up with the scene layer's image frames).
- A rotated or flipped `xdr:pic` (`a:xfrm`) is still drawn upright.
- Evidence: `sheet-chart/src/native.rs` (`a_crop_is_the_pictures_placement_in_its_frame`,
  `a_picture_takes_its_alpha_and_shadow_and_reports_its_adjustments`),
  `sheet-js/tests/it/w2_annotations.rs` (`a_cropped_picture_is_placed_and_its_lum_is_a_filter`),
  `packages/sheet-host-model/test/table-pictures.spec.ts`.
