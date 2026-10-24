# ADR 524 — Excel named styles map to the document's styles

- **Status:** Accepted, 2026-10-23. Builds on [ADR 518](518-cell-visual-model-and-colour-references.md)
  (colour and text-style references, the one resolver) and [ADR 520](520-document-styles-in-the-frame.md)
  (the document's styles inside the frame); the persistence follows [ADR 503](503-xlsx-patched-not-regenerated.md).
- **Scope:** `sheet-lower/src/docmap.rs`, `sheet-lower/src/table_band.rs`, `sheet-xlsx/src/parts/{style_model,styles}.rs`,
  `sheet-xlsx/src/doc_style_map.rs`, `sheet-js/src/core/docstyles.rs` (+ the wasm doors), the bundle's
  `engine-docstyles.ts`, `doc-styles.ts`, `session.ts`, `panels/doc-styles-section.tsx`,
  `surface/doc-style-looks.ts`.

## Context

A workbook placed in a layout document should look like the document, not like Excel's defaults,
while staying a real Excel workbook. ADR 518 lets one cell name a document paragraph, character or
cell style; ADR 520 lets the host's panels assign them. Missing was the workbook-wide link: Excel's
own named cell styles (Normal, Heading 1–4, Title, Total, Good / Bad / Neutral, Currency, Percent,
Note, Input / Output / Calculation, any custom style) standing for the document's styles, so a
whole workbook takes the document's typography at once.

## Decision

1. **A workbook-level switch and mapping table.** "Use document styles" plus a table from Excel
   style name (case-insensitive, as Excel's names are; `Normal` is the built-in style 0 whatever
   its localized name and maps the cells that name no style) to a document paragraph style id and
   optionally a character style id and a cell style id (`sheet_lower::DocStyleMap`).
2. **One fold, in the engine.** `sheet_lower::apply_doc_map` folds a cell's mapping into its
   resolved style when the style sheet is parsed, so the page lowering, the live grid scene and
   everything else reading the resolved style table see the same result. Precedence, highest
   first: conditional formatting > direct cell formatting > the named style's mapping > table
   style regions > Normal's mapping > Excel's defaults. Concretely:
   - a cell with a document reference of its own (ADR 518) is not mapped;
   - with a named style's own entry, the font facets the cell shares with that named style
     (face, size, bold, italic, colour, underline, strike, position) give way to the document
     style — a facet that differs is direct formatting and stays; with a mapped cell style, the
     shared fill and borders give way too;
   - table regions fill only what a cell leaves unset and leave a mapped named style's text alone
     (and its box, with a mapped cell style);
   - a named style without an entry takes Normal's paragraph style and keeps its own look;
   - the workbook's base font is never emitted as an override, so the document paragraph style's
     face and size win on the page.
3. **A style the document lacks falls back.** The bundle tells the engine which document style ids
   exist (re-read after document changes); a mapped id the document no longer has is left out and
   the cell shows the workbook's concrete look. The panel reports such references (mapping entries
   and the cells' own references, styles and swatches) with a remap that rewrites them in place.
4. **Persistence: the style sheet's own `extLst`.** The switch and table ride a paged extension of
   `styles.xml` (`uri="{6F3D1A52-8E0B-4C71-9B5A-2D7C4E9F1A31}"`, `<pg:docStyleMap enabled="1"><pg:map
   style="Heading 1" para="…" char="…" cell="…"/></pg:docStyleMap>`), spliced in place: other
   extensions and every other byte stay; clearing the map removes only what it added. The model
   follows by re-parsing the part. The `.paged` container stores the workbook whole (ADR 506), so the
   mapping travels in the document's own part; Excel ignores the extension and shows its own look.
5. **Defaults.** A workbook created in paged (new, or from delimited text) turns the switch on.
   An imported xlsx starts off; the Document styles section offers it. Turning it on pre-fills,
   for styles without an entry, Excel styles whose name matches a document paragraph style's and
   Normal → the document's basic paragraph style.
6. **The UI.** The workbook panel's Document styles section: the switch, the table (Excel style,
   paragraph / character / cell style selects, cells using it), "Create document styles from
   workbook" (for each named style the cells use without an entry: a document paragraph style
   based on the basic paragraph style with the named style's face, size, weight and colour as a
   minted document swatch, then mapped — a name the document already has is mapped instead) and
   "N references missing · Remap". Each mapping change is one undo step.
7. **Grid parity.** The frame surface reads the mapped styles' resolved properties
   (`host.document.styleProperties`, through `basedOn`) and draws a document-styled cell in their
   face, size, weight and colour (`swatchDisplay`), filling only what the cell leaves unset;
   re-read when the document's styles may have changed.

## Consequences

- Wasm doors: `doc_style_map`, `set_doc_style_map`, `set_doc_styles_enabled`,
  `set_doc_style_mapping`, `named_style_usage`, `set_document_styles_available`, `doc_references`,
  `remap_doc_reference` (about 70 KB of the sheet wasm).
- A remap rewrites the style records in place and is not an undo step of its own.
- Open: chart text naming document styles (chart roles), a character style from "Create document
  styles" for facets a paragraph style cannot carry, and a host command for the switch.
