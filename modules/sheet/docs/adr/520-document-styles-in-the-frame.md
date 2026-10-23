# ADR 520 — The document's styles inside the sheet frame

- **Status:** Accepted, 2026-10-23. Builds on [ADR 518](518-cell-visual-model-and-colour-references.md)
  (colour and text-style references) and [ADR 510](510-excel-inside-the-frame.md) (the frame
  surface); uses extensions ADR 336 (`host.document.styleProperties`, `swatchDisplay`).
- **Scope:** `packages/sheet-bundle/src/binding-provider/text-provider.ts`, `activate.ts`,
  `session.ts` (`documentFontFace`, `documentTextDefault`, `documentSwatchRef`,
  `documentSwatchColors`, `documentStyleRevision`), `surface/sheet-frame-surface.tsx`.

## Context

A sheet frame sits in a layout document with its own swatches (RGB, CMYK, spot, Lab), fonts and
paragraph, character and cell styles. ADR 518 lets a cell reference them and the page lowering
already writes those references (a document swatch instead of a minted one, the applied
paragraph, character and cell styles). Two things were missing: a way to *assign* them while
editing a sheet, and a grid that *shows* them as the page will print them.

## Decision

1. **The host's own panels assign document styles to cells.** The host resolves every selection
   property through the active binding providers before the engine. In the `sheet` edit context
   the sheet's text provider now writes, through `setStyle`, the selected cells':
   `characterFontFamily` / `characterFontStyle` / `characterFontSize`, `characterUnderline`,
   `characterStrikethru`, `characterPosition`, `characterFillColor` (a document swatch, stored as
   an ADR 518 reference with its colour model and the sRGB the document shows),
   `paragraphJustification`, and `appliedParagraphStyle` / `appliedCharacterStyle` /
   `appliedCellStyle` (document style ids). The Character, Paragraph and style panels therefore
   edit cells without a sheet-specific copy of them; every write is one undo step. Paths a cell
   cannot have stay claimed and answer `absent`.
2. **The grid draws the document's faces.** The frame surface loads the faces its cells name from
   the document (`host.assets.getFontFace`) into the page's font set; cells that name no face use
   the document's basic paragraph style face and size, which is what the placed table prints them
   in (`[Basic Paragraph]`, else the root paragraph style).
3. **The grid draws document swatches as the document shows them.** Referenced swatches are drawn
   in their colour-managed display colour (`swatchDisplay`), re-read after document changes, so
   editing a swatch in the document recolours the grid as it recolours the placed table (which
   names the swatch and needs no re-lowering).

4. **The sheet bar offers the document's styles.** A paragraph-style menu and two swatch pickers
   (cell fill, text colour) list the document's own paragraph styles and swatches (with their
   display colour); a pick is written as an ADR 518 reference, one undo step. The fill control of
   the host (`frameFillColor`, container mode) also fills the selected cells while a sheet frame is
   entered.

## Consequences

- A text colour from the Swatches or Character panel is always a document swatch: picking a
  colour the document does not have is refused rather than stored as a stray hex.
- The workbook keeps a concrete fallback for each reference (ADR 518), so the xlsx export and
  other spreadsheet applications still see the colour.
- Open: Excel named styles mapped to document styles by default ("Use document styles"), the
  mapping table and "Create document styles from workbook", and the chart roles still without
  engine doors (a palette from a document colour group, a document default chart style).
