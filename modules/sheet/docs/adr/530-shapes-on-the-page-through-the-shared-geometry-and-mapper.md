# ADR 530 — Drawing shapes on the page, through the shared geometry and mapper

- **Status:** Accepted, 2026-11-08. Extends 526 and 527 ("shapes in xlsx drawings are preserved
  but not drawn, so there is nothing yet to lower"); builds on slide ADR 717 (`dml-geom`),
  slide ADR 722 (`dml-native`) and engine ADR 1047.
- **Scope:** `sheet-xlsx/src/parts/shapes.rs` (new), `sheet-xlsx/src/parts/pictures.rs`
  (`anchor_of`), `sheet-chart/src/native.rs` (`shape_look`), `sheet-js/src/core/shapes.rs` (new),
  `sheet-js/src/core/annotations.rs` (`place_anchor`), the host model's `lowered.ts`,
  `table-shapes.ts` (new) and `chart.ts` (`chartGradientMintOps`), the bundle's `lower.ts`.

## Context

An `xdr:sp` (a shape or text box) and an `xdr:cxnSp` (a line or connector) in a sheet's drawing
were preserved and never drawn: the page showed the table without the arrows, boxes and rules an
Excel author put over it. paged.slide draws the same DrawingML through two shared crates:
`dml-geom` evaluates the 187 presets and custom geometry to Bézier outlines, and `dml-native`
maps the paint (fills, gradients, outlines, effects) onto the engine's items.

## Decision

1. **Read.** `XlsxDocument::shapes_of` reads the anchors of a drawing that hold an `xdr:sp` or
   `xdr:cxnSp` directly (fallback shapes inside `mc:AlternateContent` stay unread, as the chart
   fallback text must): the anchor (the picture anchors, `anchor_of`), the preset (with its
   `a:avLst`) or custom geometry, the flips, the rotation and the size, and the fill, outline and
   effects through `paged_ooxml::drawingml::shape_properties`. What the shape leaves out comes
   from its `xdr:style`: the fill of `a:fillRef` and the outline of `a:lnRef` (colour, and the
   Office theme's three widths 0.5, 1 and 1.5 pt). Nothing is written; the drawing round-trips.
2. **Evaluate in Rust.** `dml_geom::preset` / `custom` evaluate the outline for the shape's box
   in pt. A flip mirrors it in the box, a rotation turns it about the box's centre, and a turned
   shape takes its own size (`a:ext`) centred in the anchor box it fills. The result is
   `PageShape`: items (one per `a:path`, several contours as `subpathStarts`) of anchors with
   their Bézier handles, and what the geometry paints of each (`filled`, `stroked`).
3. **One mapper.** `sheet_chart::native::shape_look` is `dml_native::native::Lowering::shape`:
   solid and gradient fills (a pattern as its mixed colour), the outline with its dash, cap and
   join, opacity and the effect list. Colours are `#RRGGBB`; what the engine cannot hold is a loss
   line, logged with the table lowering.
4. **Place.** `LoweredContent.shapes` (like `pictures`) reach the table's page art:
   `tableShapeOps` mints each colour and gradient once (the read-first ruling of every mint, and
   the swatches the same batch already mints are known), then per item an `insertPath` offset to
   the anchor cell and `nativeFxOps` for the paint. A path starts with no fill and no stroke; a
   contour the geometry marks unfilled or unstroked stays so. The paths are in the table's
   minted ids, so a refresh replaces them with the bars and pictures.

## Consequences

- Excel's rectangles, rounded boxes, arrows, stars, callouts, lines and elbow connectors, with
  their fill, outline, gradients, shadows and glow, draw on the page in the engine's native paths
  (editable, exported to PDF and IDML like any path).
- Known gaps, reported as losses, not faked: the text of a shape or text box is not drawn
  (its story needs a text frame sized to the text rectangle `dml-geom` already gives); a line's
  arrowheads; the shape's connection to cells it glues to; shapes inside a group (`xdr:grpSp`)
  and the in-frame grid, which draws neither shapes nor pictures through the engine.
- The preset definitions add about the size of the 187 outlines to the sheet wasm (the same
  embedded table paged.slide and paged.doc carry).
- The gradient's start is left to the engine's default placement (the page's spread origin is not
  at hand where the table's art is made); a linear gradient on a box that is not axis aligned
  therefore starts at the box corner.
- Evidence: `sheet-js/tests/it/w3_shapes.rs` (read, lowered paint, anchor box, turned and rounded
  outline, the page filter, losses), `packages/sheet-host-model/test/table-shapes.spec.ts`.
