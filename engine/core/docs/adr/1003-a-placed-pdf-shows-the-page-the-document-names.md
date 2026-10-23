# ADR 1003 — A placed PDF shows the page the document names

- **Status:** Accepted 2026-10-23.
- **Scope:** protocol v76 (additive; no bump). `paged-model` (`PlacedPdf`, `PdfCropBox`, the
  `placed_pdf` field of `Rectangle`, `Oval` and `Polygon`); `idml-import`'s spread parser;
  `idml-export` (`pdf_attribute.rs`); `paged-renderer` (`pipeline/placed_pdf.rs`,
  `pipeline/images.rs`); `paged-mutate` (`PropertyPath::FramePdfPage`, `permit.rs`);
  `paged-introspect` (the `framePdfPage` row and the derived `pdfPageCount` row);
  `paged-canvas` (their reads). Follows [ADR 154](154-a-placed-pdf-is-drawn-from-its-own-operations.md).
  The engine half of the `media.paged.pdf.page` template field kind (the editor's
  composable-editor plan, G3a).

## Context

InDesign places one page of a PDF and records which in the `<PDF>`'s `<PDFAttribute
PageNumber="…" PDFCrop="…"/>`. The importer did not read the element, so a frame placing page 2
of a brochure drew page 1, and the PDF template field a template needs (a filler picks which
page of a supplied PDF shows) had nothing to write.

## Decision

**The model keeps the attribute as IDML spells it.** `PlacedPdf { page_number, crop }` holds
`PageNumber` (1-based) and `PDFCrop`, each `None` when absent; a frame has one only when its
`<PDF>` carries a `<PDFAttribute>`. A `.paged` model part writes the field only when it is set.

**The renderer draws the named page and box.** A placed PDF resolves as before, then moves to
the frame's page and box: the page's box size is what the frame's fit, crop box and transform
place, so a fit resolves against the page shown. `PDFCrop` picks the box: `CropPDF` (and none)
the crop box, as before; `CropMedia`, `CropTrim` and `CropBleed` their boxes; `CropArt` and the
three content crops the art box, which is the PDF's own statement of its marks' extent. A box
is cropped to the media box and a box with no area falls back to the crop box. The box is
mapped with the page's rotation, so it stays axis-aligned. The page is still drawn from its own
operations into the display list, which both rasterizers draw. A page past the PDF's last
shows the first, which is what the renderer always did for a page it could not find.

**The export patches the source element.** A `<PDFAttribute>` the model agrees with is written
back byte for byte; a changed value is set, a cleared one dropped, one the source lacks
appended; a `<PDF>` without one gains one before its `<Link>`. Only frames whose model has a
`PlacedPdf` are touched, so an unchanged import and an older `.paged` (which has none) write
their source unchanged. A frame whose picture is an `<Image>` holding PDF bytes (placed from
bytes in the editor) has no element to carry the page: it is kept in the `.paged` model part
and lost in a pure IDML export.

**`framePdfPage` is writable; `pdfPageCount` is derived.** `PropertyPath::FramePdfPage` sets
the page on a rectangle, oval or polygon: a whole number of at least 1, `null` clears it.
A frame whose bytes are not a PDF, or that places no picture, refuses it; a link is taken at
its word. The engine does not check the page against the PDF (the mutation layer does not read
assets); a form reads the derived `pdfPageCount` (the frame's bytes, or its link's bytes as
the last build resolved them, `null` when there is no PDF) and offers 1 to N. The renderer
now remembers a linked PDF's bytes in the decode cache, as it does an SVG's, which also lets
the placed-asset door hand them out. The write is `image.replace` on the item: which page shows
is the picture, not its look.

## Consequences

- A template field can open the page to a filler (`media.paged.pdf.page`, the pdf bundle),
  which checks the page against the count and the field's allowed pages; the engine checks
  the permission.
- No InDesign reference exists yet for a page other than 1 or a crop other than the media box;
  the `placed-pdf` fixture places page 1 with `CropMedia`, so its fidelity is unchanged. The
  content crops read as the art box, an approximation of InDesign's bounding box of the marks.
