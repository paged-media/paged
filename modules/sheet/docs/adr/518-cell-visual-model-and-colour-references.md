# ADR 518 — The cell visual model: colour and text-style references, one resolver

- **Status:** Accepted, 2026-10-23. Amends the frozen style types (`sheet-core`, additive: a new
  `visual` module beside `style.rs`); extends [ADR 508](508-content-addressed-swatches.md) (minted
  swatches only where no document reference exists) and [ADR 503](503-xlsx-patched-not-regenerated.md)
  (the document references ride an `extLst` of the patched style records).
- **Scope:** `sheet-core/src/visual.rs`, `sheet-format/src/resolve.rs`,
  `sheet-xlsx/src/parts/{style_model,styles}.rs`, `sheet-xlsx/src/style_edit.rs`,
  `sheet-lower/src/{style,styler}.rs`, `sheet-js` (`set_style`, `get_style`, `get_cell_visual`,
  `named_styles`), the bundle facade (`engine.ts`), the host model's `lowered.ts` / `grid.ts`.

## Context

The frozen `CellStyle` keeps `font`/`fill`/`border` as opaque indices into the xlsx sub-tables,
and the lowering read a flat side table of hex strings resolved at parse time. That could not
carry what the program needs: Excel's full cell formatting (18 fill patterns, gradients, all
border line styles and the diagonals, indent, rotation, shrink-to-fit, strike-through, super- and
subscript, the underline kinds, the named cell styles), and — for "Excel inside the frame" — the
layout document's own swatches (RGB, CMYK, spot, Lab) and character / paragraph / cell styles
used inside cells and charts. A hex string cannot say "the document's spot colour Brand Red".

## Decision

1. **`CellVisual` is the cell visual model** (`sheet_core::visual`): `font: TextStyleRef`,
   `fill: CellFill` (none / pattern with foreground and background / gradient with stops),
   `border: CellBorder` (four edges and the diagonal, each a `BorderStyle` and a colour, the
   up/down flags), `alignment: CellAlignment` (the full horizontal and vertical sets, wrap,
   indent, `textRotation` 0–180 and 255 stacked, shrink), the Excel named style it derives from,
   and a document cell style. `DifferentialFormat` is the same with optional facets (what a
   conditional format changes — an explicit "bold off" included — and its number format).
   `NamedCellStyle` is one `cellStyles` entry with its record; Excel's built-in styles
   (`builtinId` 0–53) are data (`builtin_style_name`, and their Office-theme definitions in
   `style_edit.rs`).
2. **Every colour is a `ColorRef`**: `concrete` (`Rgb` / `Theme {index, tint}` / `Indexed` /
   `Auto`, what the workbook stores) plus `doc: Option<DocSwatchRef {id, model: Rgb|Cmyk|Spot|Lab,
   fallback_rgb}>`. **Fonts are a `TextStyleRef`**: the concrete `FontSpec` plus optional document
   character and paragraph style ids.
3. **One resolver.** `sheet_format::resolve(color, palette) -> {rgb, swatch}`: a document
   reference wins (its `fallback_rgb` is shown, its id named); else RGB, the theme slot (the
   workbook's theme, the Office theme for slots it lacks) or the indexed palette (the workbook's
   override, the default 64 entries otherwise), the tint applied; `Auto` resolves to nothing. The
   page lowering, the live grid, number-format colours and (W2.4) conditional formatting all
   resolve through it; `sheet_lower::resolve_visual` turns a `CellVisual` into the flat
   `VisualAttrs` the one `CellStyler` interns, so a cell has the same style on both surfaces.
4. **The IR carries references beside colours.** `LoweredStyle` (page and grid alike) gains
   optional `fillSwatch` / `textSwatch` / per-line `swatch`, the pattern and gradient (with the
   blend / mean colour in `fillRgb` for a surface that cannot draw them), the diagonals, indent,
   rotation, shrink, strike, `vertAlign`, `underlineStyle`, the extended horizontal alignments,
   the named style and the document style ids. The page names a document swatch where one is
   referenced and mints an ADR 508 swatch only where none is.
5. **xlsx round-trip: concrete values, references in the record's `extLst`.** A save writes the
   concrete colour (a document swatch's `fallback_rgb`). The references ride a paged extension
   inside the `<xf>` record itself (`uri="{6F3D1A52-8E0B-4C71-9B5A-2D7C4E9F1A30}"`,
   `xmlns:pg="urn:paged:sheet:docstyles"`, `<pg:doc fillFg="id|model|RRGGBB" …/>`), so the
   record's identity — the dedup of authored styles — includes them and every index stays
   positional. On re-import a colour reference is restored only when the concrete colour still
   resolves to the recorded sRGB: another application that recoloured the cell wins over a stale
   reference. The `.paged` container stores the workbook whole (ADR 506), so the extension
   travels in the document's own part.
6. **Authoring** (`StylePatch::ext`): patterns and their two colours, gradients, the diagonal and
   its direction, indent, rotation, shrink, strike, super/subscript, the underline kinds, document
   swatches for fill / pattern background / font / each border line, document character /
   paragraph / cell styles, and applying an Excel named style by name (a built-in the workbook
   lacks is added from Excel's definition). Each write is a splice of `styles.xml` as before.

## Consequences

- Without a theme part, every theme slot resolves to the Office theme (before, slots 6–11 read as
  no colour).
- A pattern other than solid is painted (the grid draws it; the page shows the blend), so a
  record pointing at the reserved `gray125` fill now looks as Excel shows it.
- The UI for document styles (swatch pickers, the mapping table) is built on `get_cell_visual`,
  `named_styles` and the `set_style` patch; the chart roles' `ColorRef`s follow in W4.
