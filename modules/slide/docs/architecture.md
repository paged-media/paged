# paged.slide — architecture

```
.pptx bytes
  │  pptx-import      OPC + PresentationML/DrawingML → pptx-core IR (as authored)
  │  pptx-fonts       embedded faces: EOT + MicroType Express → TrueType (ADR 707)
  ▼
pptx-core IR
  │  slide-resolve    theme / master / layout / placeholder inheritance, colours, fonts
  │  slide-geom       = platform/shared/dml-geom: presets, handles, sites, live presets
  ▼
resolved deck
  │  slide-native     → native document (engine model crates) as .paged (ADR 708)
  ▼
host.assets.registerDocumentFont (embedded faces), then
host.nativeDocument.open  →  native slides in the editor

original .pptx + native document (.paged, host.documents.exportPaged)
  │  pptx-export      native read model → untouched slides by their bytes,
  │                   edited shapes patched, new shapes and slides written (ADR 711)
  ▼
.pptx
```

| Crate / package         | Role                                                                                                                                                                                                                      | Status                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `paged-ooxml` (shared)  | OPC container with its memory budget, relationships, colour (platform/shared/ooxml, doc ADR 607)                                                                                                                          | in place                                                  |
| `dml-chart` (shared)    | DrawingML chart model and reader (platform/shared/dml-chart, ADR 709)                                                                                                                                                     | in place                                                  |
| `pptx-core`             | format-level IR; its chart model is the shared `dml-chart` one (ADR 709)                                                                                                                                                  | in place                                                  |
| `pptx-import`           | `.pptx` → IR; charts through the shared `dml-chart` reader (ADR 709)                                                                                                                                                      | in place: reads every corpus deck                         |
| `pptx-fonts`            | embedded faces: Embedded OpenType, MicroType Express, embedding permissions (ADR 707)                                                                                                                                     | in place                                                  |
| `slide-resolve`         | inheritance resolution                                                                                                                                                                                                    | in place                                                  |
| `slide-geom`            | `platform/shared/dml-geom` (alias): preset and custom geometry, adjust handles, connection sites, refit and connector routing (ADR 717)                                                                                   | in place                                                  |
| `slide-chart`           | chart lowering from cached values                                                                                                                                                                                         | in place                                                  |
| `slide-sheet`           | live charts: the chart's workbook through paged.sheet (`sheet-xlsx`, `sheet-calc`), the series bound to cells, paged.sheet's geometry for the kinds `slide-chart` does not lay out, the chart part written back (ADR 715) | in place                                                  |
| `slide-native`          | resolved deck → native document, packaged as `.paged` (ADR 708); item labels with shape keys (ADR 711)                                                                                                                    | in place                                                  |
| `pptx-export`           | native read model (`native`), probe of inherited text defaults (`probe`), slide/shape/text writers (`slide`, `text`, `geom`, `xml`) → `.pptx` (ADR 704, ADR 711)                                                          | shapes, text, pictures, tables, groups, new slides, links |
| `slide-js`              | wasm-bindgen surface                                                                                                                                                                                                      | in place                                                  |
| `slide-conformance/`    | fixtures and PowerPoint recordings (a folder, not a crate; ADR 705)                                                                                                                                                       | in place                                                  |
| `packages/slide-bundle` | manifest, importer/exporter (`deck-export.ts`: the plan and the document for export), panels, commands                                                                                                                    | M1–M4                                                     |

Two crates depend on the engine's model crates (`paged-model`, `paged-scene`, `paged-store`;
path dependencies on `engine/core/crates`, built from the same commit): `slide-native` builds
the deck with them (ADR 708), `pptx-export` reads the document back with them (ADR 711). At runtime the plugin talks to the engine only through the host
contract (`@paged-media/plugin-api`), and is tested against the engine in a headless host.
