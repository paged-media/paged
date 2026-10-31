# ADR 658 — A PDF or Illustrator page places into the open document as native vectors

- **Status:** Accepted 2026-10-27.
- **Scope:** `crates/pdf-import` (`vectors/`, `lower.rs`, `snippet.rs`, `build.rs`,
  the wasm exports `pdf_inspect_wasm`, `pdf_place_wasm`, `pdf_to_paged_wasm`);
  `packages/pdf-bundle` (`src/vectors/`, the typed commands `media.paged.pdf.inspectPdf`,
  `media.paged.pdf.placeVectors`, `media.paged.pdf.convertPlacedToVectors`, the menu entry
  Object ▸ Convert Placed PDF to Vectors). Amends [ADR 654](654-pdf-ir-and-mapper.md),
  [ADR 655](655-pdfium-reader.md) and [ADR 656](656-pdf-opens-as-native-document.md).
  Engine side: core ADR 1036 (a snippet carries opacity masks and names). Gaps D-60, D-61.

## Context

The bundle opened a PDF as a NEW document and drew its vectors as polylines with a solid fill
and a stroke width ([ADR 654](654-pdf-ir-and-mapper.md): "Every line and Bézier segment
contributes one point"). There was no way to put a PDF or Illustrator page into the document
being edited, nor to turn a placed PDF frame into editable artwork, and what the open path
dropped was not reported. Measured on the reader as it stood, the import dropped: curves (each
Bézier became its end point), the fill rule, dashes, caps, joins and miter limits, clipping
paths, shadings (a gradient-filled path came out unfilled, the shading object was skipped),
constant alpha, blend modes, soft masks, form XObjects' transparency groups, and the fonts of
text runs (`bold`, `italic` and `font_family` were never set).

PDFium's public API, the bundle's reader ([ADR 655](655-pdfium-reader.md)), cannot supply the
rest: the binary the bundle ships exports no accessor for a shading's dictionary, a blend mode
or a soft mask (`FPDFPageObj_SetBlendMode` exists, no getter). The engine already interprets PDF
pages, for a placed PDF, with `hayro-interpret` (core ADR 154), which hands every drawing
operation over with its full paint, mask and blend.

## Decision

1. **The page's drawing is read by the engine's interpreter, in this crate.** `vectors::read_page`
   walks one page with `hayro-interpret` 0.8 (the engine's version, no embedded fonts) into the
   vector IR (`vectors/ir.rs`, twin `src/vectors/ir.ts`): paths as Bézier anchors with every
   contour's open flag, the fill rule, fills and strokes with their own alpha, cap, join, miter
   limit and dashes in page space; clips and transparency groups as groups, with opacity, blend
   mode and soft mask (the mask's own items); axial shadings as linear ramps and radial shadings
   whose circles share a centre as radial ramps (their stops sampled and simplified); every other
   shading sampled to an image over its region; tiling patterns expanded into copies of their
   cell up to 400 tiles (past that, the cell's colour); images (a plain RGB or grey JPEG passed
   through, any other decoded to PNG; stencil masks in their paint); text runs with their glyph
   outlines. A tidy pass undoes the spellings PDF writers use — a form's bounding-box clip, an
   image's private group, Illustrator's "clip to the path, paint the shading over its box", which
   becomes one gradient-filled path. Every construct that cannot be carried exactly is counted
   by code (`vectors::ir::Loss`).
2. **PDFium stays the text reader.** The editable text frames still come from its character
   API and the bundle's heuristics, now with each run's font family, weight and slant. The vector
   reader's text runs say WHERE in the paint order a frame lands and carry the outlines that
   stand in for it.
3. **One lowering, two ways in** (`lower.rs`). The vector items and the text frames become model
   items under a placement transform: `Polygon`s with exact anchors, fill rule, swatches and
   gradient swatches (with `GradientFillStart`/`Angle`/`Length` on the item), stroke styles and
   per-target transparency; image `Rectangle`s placed by the image's own transform; `Group`s
   (clip groups, engine ADR 1010) with opacity, blend mode and knockout; soft masks as native
   opacity masks (C-28) where the model can say them — one mask item over graphic items, applied
   to each item under the group; a mask of several items, or over a text frame, is reported. A
   text run places its frame, or — rotated text, a run no frame claims, a frame in a font the
   document lacks — its glyph outlines as one compound path.
4. **Placing is one paste.** `snippet::place` lowers a page into an engine snippet (core
   ADR 193) — the format Paste takes — and the bundle hands it to `pasteElements`: one
   mutation, one undo step, the colours and gradients added where the document lacks them, the
   items on top of the target page under fresh ids, wrapped in one group named after the file.
   When the paste shows that a frame's font is missing in the document (the `fonts`
   collection's `isMissing`), the bundle re-places the page with that text as outlines, amending
   the same undo step (core ADR 1004).
5. **Convert Placed PDF to Vectors** places the page a frame shows (its `framePdfPage`) under the
   frame's own transform and the image's placement (`links.imageTransform`), clipped to the
   frame, and deletes the frame in the same batch.
6. **The open path uses the same reader.** `pdf_to_paged` builds a new document's pages from
   the vector reader and the IR's text frames; a page the reader cannot read keeps the IR's
   frames. The IR's polyline vectors are kept only for that fallback.
7. **Illustrator files read through their PDF.** An `.ai` saved with PDF compatibility is a PDF;
   it is read as one. Illustrator's private data (`AIPrivateData`, the `/PieceInfo /Illustrator`
   dictionary) is never parsed, and the report says so. A file saved without PDF content (its
   page is Illustrator's stand-in sentence) and a PostScript-era file are refused with the
   reason.

## Consequences

- The mapper wasm now carries a PDF interpreter (hayro without embedded fonts) and the engine's
  model mutation types; the size gate is the manifest's `maxBytes`.
- Colours arrive as sRGB: hayro converts CMYK, spot and Lab before the reader sees them. The
  report says so on every placement.
- A ramp the PDF stops at its ends (`Extend false`) pads natively; reported.
- The Illustrator oracle (`modules/draw/scripts/illustrator/probes/pdf-ai-export.jsx`, replayed
  by `crates/pdf-import/tests/illustrator_oracle.rs`) holds the reader to Illustrator's own model
  of the artwork it saved.
