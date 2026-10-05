# paged.slide — architecture

```
.pptx bytes
  │  pptx-import      OPC + PresentationML/DrawingML → pptx-core IR (as authored)
  ▼
pptx-core IR
  │  slide-resolve    theme / master / layout / placeholder inheritance, colours, fonts
  │  slide-geom       preset geometry → Bézier paths
  ▼
resolved deck
  │  slide-idml       → complete IDML package (+ parts and metadata for the host)
  ▼
host.nativeDocument.open  →  native slides in the editor

native document ── slide-host-model (read model) ── pptx-export ──► .pptx
```

| Crate / package | Role | Status |
|---|---|---|
| `vendor/paged-ooxml` | OPC container, relationships, content types (vendored, ADR 701) | in place |
| `pptx-core` | format-level IR | in place |
| `pptx-import` | `.pptx` → IR | in place: reads every corpus deck |
| `slide-resolve` | inheritance resolution | M1 |
| `slide-geom` | preset geometry evaluator | M1 |
| `slide-chart` | chart lowering from cached values | M1 |
| `slide-idml` | resolved deck → IDML package | M1 |
| `pptx-export` | native read model → `.pptx` | M4 |
| `slide-js` | wasm-bindgen surface | M1 |
| `slide-conformance` | oracle recordings and headless comparison | M0/M1 |
| `packages/slide-bundle` | manifest, importer/exporter, panels, slideshow | M1–M5 |
| `packages/slide-host-model` | read model for export | M4 |

The plugin depends on no engine crate. It talks to the engine only through the host contract
(`@paged-media/plugin-api`), and is tested against the published engine in a headless host.
