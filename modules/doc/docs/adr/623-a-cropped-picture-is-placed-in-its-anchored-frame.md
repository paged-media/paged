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

## Consequences

- Cropped pictures show the part Word shows. The comparison with Word's own render is PENDING
  (Word on the build machine hangs on save-as-PDF from automation); the test holds the expected
  geometry, the OOXML definition of `a:srcRect`.
- Save-back writes nothing: a crop changed in the editor is not written to the `.docx`; an
  unedited picture keeps its XML byte for byte.
