# ADR 619 — Pictures' looks are drawn on their anchored frames

- **Status:** Accepted 2026-10-29. Completes [ADR 618](618-picture-looks-through-the-shared-drawingml-mapper.md)
  (its decision 4 and first consequence).
- **Scope:** `docx-lower` (`Lowering::lower_look` mints the look's colours as swatches; the
  look diagnostic), `packages/doc-host-model/src/{mutations,lowered}.ts` (`pictureLookOps`,
  `lookSwatch`, `lookGradientMintOps`, the pour's `bindCreated`), `packages/doc-bundle/src/place.ts`
  (gradients the document already holds are not created again), `docx-conformance`
  (`tests/it/picture_effects.rs`). Engine: engine ADR 1045. SDK: extensions ADR 347. Plan WP10.3.

## Context

ADR 618 read a Word picture's DrawingML look (`pic:spPr` and `a:blip`) and lowered it through
the shared mapper to `LoweredImage::fx`, but applied none of it: paged.doc places a picture as
an anchored frame (`insertAnchoredFrame`), and the engine's anchored frames held no fill,
outline, opacity or effects. A warning said so. Engine ADR 1045 gives anchored frames the free
frames' look and lets the free frames' paths reach them; extensions ADR 347 makes the
translation of a `NativeFx` into those paths one function of the SDK.

## Decision

1. **The pour paints the look.** For each picture with a look, a batch of its own inside the text
   step inserts the anchored frame, names it with `bindCreated` (`docxPicture<k>`, unique in the
   step; a float, doc ADR 614, keeps its `docFloat<k>` batch and handle), and writes the look on
   that handle through `nativeFxOps`: the outline, the opacity
   (`a:alphaModFix` times a translucent fill), the drop and inner shadow, the glow, the soft edge,
   the gradient fill behind a transparent picture and its feather. It is the step's batch, so a
   picture and its look are one undo step with the text. A gradient's start is in the frame's own
   box (`origin [0, 0]`).
2. **Colours are document swatches.** `docx-lower` mints every colour a look paints with as
   `Color/docx-RRGGBB` (the swatch a run colour of that value already is), and the host model
   names them so (`lookSwatch`). A look's gradient is a content-addressed gradient swatch
   (`Gradient/docx-…`), created with the styles after the swatches its stops name; a placement
   into a document that holds it already does not create it again.
3. **Diagnostics.** The look is no longer reported as not shown: one info line names how many
   pictures carry a look and what it is, "drawn natively on their anchored frames". What the
   engine cannot hold is still one info line per kind (reflection, blur, a fill overlay, the
   picture adjustments `a:grayscl`, `a:lum`, …), from the mapper.
4. **The source keeps every byte** (ADR 618 decision 5): the look is painted, never written back;
   an unedited save and one that edits text around a picture stay byte-identical.

## Consequences

- Word's picture styles (a white frame and a shadow, a soft edge, a glow, a translucent picture)
  draw on the page, in the editor and in PDF.
- A picture in a table cell is still not poured (ADR 035 decision 8), so its look is not drawn.
- `docx-export` writes nothing back: a look changed in the editor is not yet written to the
  `.docx` (the mapper's inverse `effects_of` with `drawingml::write` would, as pptx-export does).
- Shapes, text boxes and charts are still counted, not carried.
