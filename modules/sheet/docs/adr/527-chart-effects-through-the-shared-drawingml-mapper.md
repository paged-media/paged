# ADR 527 — Chart gradients and effects onto native items, through the shared DrawingML mapper

- **Status:** Accepted, 2026-10-28. Extends 519 (charts as Excel draws them) and 525 (document
  chart styles); builds on slide ADR 722 (`platform/shared/dml-native`).
- **Note 2026-10-29:** the translation of `fx` into ops (decision 5's "sets angle, length,
  opacity, …" and decision 8's picture effects) is the lowering kit's `nativeFxOps` (extensions
  ADR 347); `chartFxOps` is that call with the chart's swatch mapping, and `NativeFx` is the
  SDK's type. The ids and the ops are unchanged.
- **Scope:** `sheet-xlsx/src/parts/chart.rs` (the Excel profile's `c:spPr` reading),
  `sheet-chart/src/{model,native,geometry,style,cartesian,radial}.rs`, `sheet-xlsx/src/chart_write.rs`
  (the splice), `sheet-xlsx/src/parts/pictures.rs` and `sheet-js/src/core/annotations.rs`
  (pictures), the host model's `chart.ts`, `palette.ts` and `table-pictures.ts`, the bundle's
  `lower-chart.ts`, `lower.ts` and `swatch-mints.ts`, and `platform/shared/dml-native`
  (`axis_start`).

## Context

A chart role's `c:spPr` was read as one colour: a gradient as its first stop, a pattern not at
all, an alpha dropped, and `a:effectLst` ignored. The page lowering therefore drew Excel's styled
charts (gradient bars, shadowed series, translucent plot areas, glowing slices) flat. paged.slide
and paged.doc already lower the same DrawingML onto the engine's native items through one mapper,
`dml-native` (slide ADR 722); sheet kept its own colour reader beside the shared one.

## Decision

1. **Read once, as authored.** The Excel profile keeps what a role's `c:spPr` paints beyond one
   colour as `DmlFx` on the chart model (`AreaStyle::fx`, `Series::fx`, `Series::point_fx` for
   `c:dPt`): a gradient, pattern or translucent fill, a fill of `a:ln` that is not one colour, and
   the effect list — the `paged_ooxml::drawingml` types, unresolved, so a theme colour in them
   resolves against the workbook's theme when the chart is drawn. The role's `ColorRef` still
   holds what a reader without effects draws (a gradient's first stop, a pattern's foreground).
2. **One colour reader.** Sheet's chart colour reader parses through
   `paged_ooxml::drawingml::color` (plan C11): a scheme slot stays a theme reference with its
   Excel tint (the swatch model a role keeps); every other colour (`srgbClr`, `sysClr`, `prstClr`,
   `hslClr`, `scrgbClr`) resolves with its transforms exactly, through the shared resolver. The
   hand-written element parse is gone.
3. **One mapper.** At geometry time `sheet-chart::native` resolves the role
   (`paged_ooxml::drawingml::resolved`) and lowers it with `dml_native::Mapper`: the gradient
   swatch and its placement, opacity from a uniform alpha, alpha stops as a gradient feather, the
   outer shadow as the drop shadow, the inner shadow, glow and soft edge as frame effects, a
   pattern as the mix of its colours. Nothing in sheet maps DrawingML onto the engine itself.
4. **The IR carries it.** Rect, line, polygon and wedge primitives take an optional `fx`
   (`NativeFx`): the mapper's result with colours as `#RRGGBB` and the gradient's start in
   chart-content pt. A line takes the effects only (the engine has no gradient stroke from
   here). `ChartGeometry.losses` lists, once per kind, what the page items cannot hold —
   reflection, blur, fill overlay, shadow distortion, patterns, a gradient line, effects the
   reader does not model — the mapper's own report. The bundle logs it with the lowering.
5. **The page lowering.** The translator mints a content-addressed gradient swatch
   (`Gradient/uPagedSheetChart…`, keyed by kind and stops) after the chart colour swatches its
   stops name, under the same read-first ruling as every mint (`readKnownSwatchIds` now reads
   the gradients collection too; a failed read mints nothing). It fills the path with the
   gradient and sets angle, length, opacity, drop and inner shadow, glow, feather and gradient
   feather on it.
6. **Where the axis starts.** Office runs a linear gradient through the box's centre; the engine
   starts an unplaced one at the box's bottom-left corner, which agrees only for axes running up
   or right. `dml_native::axis_start` gives the centred start (a radial gradient's centre as
   before); the lowering writes it as `frameGradientFillStart` in the page's spread coordinates
   (the page summary's `pageOrigin` plus the chart's page-local origin). Without a page origin
   the engine's default placement stands.
7. **A document colour wins.** A role painted by a document swatch (a role override, a series
   palette, ADR 525) drops the file's gradient or pattern; its effects stay.
8. **Drawing pictures.** An `xdr:pic`'s `a:blip` (its `a:alphaModFix` and picture effects) and
   its `xdr:spPr` effect list are read through the same reader (`SheetPicture::dml`) and lowered
   by the same mapper (`sheet_chart::native::picture_fx`): the alpha as the frame's opacity, the
   shadows, glow and soft edge as on a chart item; every picture adjustment the engine cannot
   apply yet (`a:grayscl`, `a:lum`, `a:duotone`, …) is a loss on the picture
   (`PictureInfo.losses`), logged with the table lowering. The picture frame takes them with its
   `placeImage`; the effect colours are chart swatches under the same mint ruling.
9. **Writing back.** An edited chart's regenerated `c:spPr` keeps the old `a:effectLst` while the
   role still has its effects, and its gradient, pattern or translucent fill while the role's
   colour did not change — both as read, so a theme colour stays one. An unedited chart stays
   byte-identical (ADR 503). The page's native effects are never written into the workbook: the
   chart's art is regenerated from it.

## Consequences

- Excel's styled charts draw with their gradients, transparency and shadows on the page; the grid
  view reads the same IR and may ignore `fx`.
- The gradient and the picture reads cost a lowering nothing when the chart or table has none
  (the gradients collection and the page origin are read only for a chart that mints one).
- The Excel open-check lane records the edited styled chart (`chart-effects-edit`): Excel opens
  it unrepaired.
- Out of scope, follow-ups: shapes in xlsx drawings (`xdr:sp`) are preserved but not drawn, so
  there is nothing yet to lower; the in-frame grid's effects (WP3.6); gradient strokes;
  surfacing `losses` in the workbook panel beside the 3-D flag.
