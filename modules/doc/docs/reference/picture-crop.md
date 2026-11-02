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
- Save-back writes a changed crop back (below); an unedited picture keeps its XML byte for byte.
- Table cells take the same path: `picture_crop_cell_docx` (`dump-fixture <out> picture-crop-cell`)
  holds an inline and an anchored cropped picture in two cells; `reach.rs` checks their crop and
  placement against the definition, `picture-crop-cell.spec.ts` the cell's pour.

## Save-back

The editor changes a crop by setting `imageContentTransform` on the anchored frame. The host reads each
paragraph's pictures with the story (`pictures`: frame id, anchor offset, placement), `docx-export`
(`crop.rs`) inverts the placement and splices `a:srcRect` into the drawing found by its ordinal:

`l = -e / (a * pw)`, `t = -f / (d * ph)`, `r = 1 - l - w / (a * pw)`, `b = 1 - t - h / (d * ph)`

in 1/1000 percent (`l="25000"` is 25 %), only the non-zero sides. A picture whose placement the
lowering made is not touched. Refused with a line in the ledger: a picture of unknown size (a metafile),
a flipped, rotated or skewed placement, one that does not cover its frame (negative `a:srcRect`), one the
import cannot find. Not saved: pictures in nested tables, headers and text boxes, VML pictures, frame
resizes. Evidence: `docx-conformance/tests/it/crop_saveback.rs`.

## Word's render

`dump-fixture <out> picture-crop` writes the oracle document (four crops inline,
then the same four anchored). The test in `docx-conformance/tests/it/reach.rs` holds
the expected geometry: the frame shows the image pixels from `l * width` to
`(1 - r) * width` and from `t * height` to `(1 - b) * height`.

Word's render (Microsoft Word, 2026-11-02, the document exported to PDF and rasterised at 144 dpi)
matches that definition for all eight pictures. Each picture's extent in the fixture is the visible
part at native scale (for example 72 x 72 pt for `l = r = 25 %`), and Word draws exactly the source
image cropped by the `srcRect` fractions into it. Measured against the fixture's source image cropped
by the same fractions and resampled to the measured box:

| picture                   | `srcRect` (%)         | Word's size (pt) | expected (pt) | mean pixel difference |
| ------------------------- | --------------------- | ---------------- | ------------- | --------------------- |
| none, inline and anchored | none                  | 144.0 x 72.5     | 144 x 72      | 6.9 / 255             |
| left and right            | `l=25 r=25`           | 72.0 x 71.5      | 72 x 72       | 4.5 / 255             |
| top and bottom            | `t=10 b=40`           | 143.5 x 36.5     | 144 x 36      | 2.8 / 255             |
| all four                  | `l=10 t=20 r=30 b=10` | 86.5 x 50.5      | 86.4 x 50.4   | 1.1 / 255             |

The inline and anchored pictures agree to within half a point. The pixel difference is resampling of a
200 x 100 source, not geometry. Not yet compared: a direct render of the same document by paged against
Word's PDF; the engine's own tests (`anchored_picture_crop.rs`, `reach.rs`) assert the same rule on the
frame's placement.

An earlier version of this fixture was rejected by Word as corrupt (its theme part had empty format
scheme lists); the fixture theme now carries the standard format scheme, and the document opens in Word
without a repair prompt.
