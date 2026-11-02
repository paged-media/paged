# Picture crop (doc ADR 623)

`pic:blipFill/a:srcRect` (`l t r b`, 1/1000 percent of the image) is read by the
shared DrawingML reader with the blip, carried as `Image::crop` and lowered to
`LoweredImage::crop`: the fractions, and the picture's placement in its frame.

`wp:extent` is the cropped picture's size on the page, so the image is shown at
`extent / (1 - l - r)` by `extent / (1 - t - b)` with its top left corner `l` and
`t` of that outside the frame: the mapping slide's pictures use
(`image_item_transform`). Over the picture's pixel size that is the engine's inner
image transform, `[w / (1 - l - r) / pixels_w, 0, 0, h / (1 - t - b) / pixels_h,
-l * w / (1 - l - r), -t * h / (1 - t - b)]`, in the frame's own box.

- The pixel size is read from the image's header (`paged_ooxml::media::pixel_size`,
  the reader slide uses). A picture whose size the bytes do not give (a metafile)
  shows whole, fitted to the cropped size, and the lowering says so.
- The host model (`doc-host-model`, `pictureCropOps`) sets the placement on the
  anchored frame `insertAnchoredFrame` made, as `imageContentTransform`, in the
  frame's batch (one undo step). The engine takes it on an anchored picture frame
  since engine ADR 1045's amendment of 2026-11-02, in the body and in table cells.
- A crop that leaves no picture (the sides overlap) or pads (a negative side) is not
  carried; the picture shows whole.
- Save-back does not write a changed crop back (the splice only touches edited
  text); an unedited picture keeps its XML byte for byte.

## Word's render

`dump-fixture <out> picture-crop` writes the oracle document (four crops inline,
then the same four anchored). The test in `docx-conformance/tests/it/reach.rs` holds
the expected geometry: the frame shows the image pixels from `l * width` to
`(1 - r) * width` and from `t * height` to `(1 - b) * height`.

The comparison against Word's own render is PENDING: Word on the build machine
hangs on save-as-PDF from automation (a dialog that cannot be seen), so no
measurements from Word are recorded here. Until then the crop is verified against
the OOXML definition of `a:srcRect` and against slide's pictures, not against Word.
