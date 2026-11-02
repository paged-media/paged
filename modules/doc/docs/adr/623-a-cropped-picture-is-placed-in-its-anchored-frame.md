# ADR 623 — A cropped picture is placed in its anchored frame

- **Status:** Accepted 2026-11-02. Extends [ADR 619](619-picture-looks-drawn-on-their-anchored-frames.md).
- **Scope:** `docx-core` (`Image::crop`), `docx-import` (`a:srcRect`, read by the shared
  DrawingML reader with the blip), `docx-lower` (`LoweredImage::crop`, `LoweredCrop::placement`),
  `packages/doc-host-model/src/{mutations,lowered}.ts` (`pictureCropOps`), `docx-conformance`
  (`tests/it/reach.rs`). Engine: engine ADR 1045's amendment of 2026-11-02. Shared:
  `paged_ooxml::media` (the picture header reader, moved from `pptx-core`).

## Context

Word crops a picture without touching the image: `pic:blipFill/a:srcRect` names the parts left
out at each side (1/1000 percent), and `wp:extent` is the size of what remains. paged.doc places
every picture as an anchored frame (`insertAnchoredFrame`); the engine could not set the image
placement of such a frame, so a cropped picture was shown whole, squeezed into the cropped size.

## Decision

1. **Read.** `a:srcRect` is read with the blip and carried as `Image::crop`.
2. **Lower.** `LoweredImage::crop` holds the fractions and the picture's placement in its frame.
   The image is shown at `extent / (1 - l - r)` by `extent / (1 - t - b)` with its top left
   corner `l` and `t` of that outside the frame (the mapping slide's pictures use), over the
   pixel size read from the image's header: the engine's inner image transform, in the frame's
   own box. A crop that leaves no picture or pads (negative sides) is not carried; a picture
   whose size the bytes do not give (a metafile) shows whole and is reported.
3. **Place.** The pour writes the placement on the frame's handle as `imageContentTransform`
   in the frame's batch (`pictureCropOps`), for inline and floating pictures and those in table
   cells; the engine takes it on an anchored picture frame (engine ADR 1045, amendment). One
   undo step with the picture.
4. **Shared header reader.** The picture header reader (`pixel_size`, `sniff`) lives in
   `paged-ooxml` for doc, slide and sheet; `pptx-core` re-exports it.

## Save-back (amendment 2026-11-02)

A crop changed in the editor is written back to the `.docx` as `a:srcRect`.

- **Read.** The editor changes a crop by setting `imageContentTransform` on the picture's
  anchored frame. The host reads every paragraph's pictures with the story
  (`ParagraphContent.pictures`: frame id, anchor offset, the frame's placement; engine ADR 1045,
  amendment; additive on protocol 78, `wire.d.ts` re-synced) and, for native table cells, with the
  cell's `paragraphs` read. `save-structure.ts` (`readPictures`) hands them to `docx-js` in
  `StructureIn::pictures`, one entry per read-back paragraph.
- **Find.** `Image::drawing` / `LoweredImage::drawing` is the picture's ordinal among the part's
  `wp:inline` / `wp:anchor` (the import's scan, which already pairs a drawing with its look and crop).
  Lowered paragraph images and read pictures pair by order inside the paragraph; a paragraph whose
  counts differ (a picture added or removed on the canvas) is left alone and reported.
- **Invert.** `docx-export::crop::crop_of_placement`: with the placement `[a 0 0 d e f]`, the
  picture's pixel size and the frame (`wp:extent`): `l = -e / (a pw)`, `t = -f / (d ph)`,
  `r = 1 - l - w / (a pw)`, `b = 1 - t - h / (d ph)`, written as `l t r b` in 1/1000 percent
  (only the non-zero sides, as Word writes them).
- **Unchanged stays identical.** A picture is touched only when its placement differs from the one the
  lowering made (`LoweredCrop::placement`) AND the recomputed crop differs from the import's by more
  than 2 units. Otherwise no byte moves.
- **Splice.** `crop::splice_crops` replaces, adds (after `a:blip`, before the fill mode, with the
  blip's own prefix) or removes the `a:srcRect` of that drawing; it refuses when the rectangle found is
  not the one the import read. quick-xml locates; the serializer is not linked.
- **Refused, with a line in the save-back ledger:** a picture whose size is not read from its bytes
  (metafile), a flipped, rotated or skewed placement, a placement that does not cover the frame
  (negative `a:srcRect`, which the import does not carry), a crop that leaves no picture, a
  picture the import cannot find. Frame resizes are not written (`wp:extent` stays).
- **Not covered:** pictures in nested tables, headers/footers and text boxes; VML pictures.

Evidence: `docx-export/src/crop.rs` unit tests (splice, inverse); `docx-conformance/tests/it/crop_saveback.rs`
(unedited bytes identical; edit then re-import gives the same crop in the `l t r b` the XML carries;
add and remove a crop; refusals; metafile; table cells inline and anchored; fixed point on a second
save); `reach.rs` (`picture_crop_cell_docx`: the cell pictures' crop and placement against the OOXML
definition); `doc-host-model/test/picture-crop-cell.spec.ts` (cell pour); `doc-bundle/test/save-pictures.spec.ts`;
engine `anchored_picture_crop.rs` (story read lists the picture and its placement;
`getElementProperties` lists `imageContentTransform` on an anchored picture frame).

## Consequences

- Cropped pictures show the part Word shows; the test holds the expected geometry, the OOXML
  definition of `a:srcRect`, and Word's render agrees.
- A crop changed in the editor is written back (see Save-back); an unedited picture keeps its XML
  byte for byte.
- Word's own render of the fixture matches the OOXML definition for all eight pictures
  (docs/reference/picture-crop.md).
