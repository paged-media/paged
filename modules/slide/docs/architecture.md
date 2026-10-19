# paged.slide — architecture

```
.pptx bytes
  │  pptx-import      OPC + PresentationML/DrawingML → pptx-core IR (as authored)
  │  pptx-fonts       embedded faces: EOT + MicroType Express → TrueType (ADR 707)
  ▼
pptx-core IR
  │  slide-resolve    theme / master / layout / placeholder inheritance, colours, fonts
  │  slide-geom       preset geometry → Bézier paths
  ▼
resolved deck
  │  slide-native     → native document (engine model crates) as .paged (ADR 708)
  ▼
host.assets.registerDocumentFont (embedded faces), then
host.nativeDocument.open  →  native slides in the editor

native document ── slide-host-model (read model) ── pptx-export ──► .pptx
```

| Crate / package             | Role                                                                                             | Status                            |
| --------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------- |
| `paged-ooxml` (shared)      | OPC container with its memory budget, relationships, colour (platform/shared/ooxml, doc ADR 607) | in place                          |
| `pptx-core`                 | format-level IR; its chart model is the shared `dml-chart` one (ADR 709)                         | in place                          |
| `pptx-import`               | `.pptx` → IR; charts through the shared `dml-chart` reader (ADR 709)                             | in place: reads every corpus deck |
| `pptx-fonts`                | embedded faces: Embedded OpenType, MicroType Express, embedding permissions (ADR 707)            | in place                          |
| `slide-resolve`             | inheritance resolution                                                                           | M1                                |
| `slide-geom`                | preset geometry evaluator                                                                        | M1                                |
| `slide-chart`               | chart lowering from cached values                                                                | M1                                |
| `slide-native`              | resolved deck → native document, packaged as `.paged` (ADR 708)                                  | in place                          |
| `pptx-export`               | native read model → `.pptx`                                                                      | M4                                |
| `slide-js`                  | wasm-bindgen surface                                                                             | M1                                |
| `slide-conformance`         | oracle recordings and headless comparison                                                        | M0/M1                             |
| `packages/slide-bundle`     | manifest, importer/exporter, panels, slideshow                                                   | M1–M5                             |
| `packages/slide-host-model` | read model for export                                                                            | M4                                |

One crate depends on the engine: `slide-native` builds the deck with the engine's model crates
(`paged-model`, `paged-scene`, `paged-store`; path dependencies on `engine/core/crates`, built
from the same commit, ADR 708). At runtime the plugin talks to the engine only through the host
contract (`@paged-media/plugin-api`), and is tested against the engine in a headless host.
