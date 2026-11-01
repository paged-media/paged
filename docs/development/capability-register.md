# Capability register

Before writing a helper, look here. A capability has **one owner**: the lowest layer that
serves every consumer (docs/adr/PM-0017: the built-in modules are part of the core, one build).
A second copy is a bug unless an ADR records why (Excel and PowerPoint chart profiles are the
example).

`tooling/single-owner.json` is the machine-readable half: `bun tooling/js/single-owner.mjs`
fails on a new copy of a capability outside its owner, and on a baseline entry whose copy is
gone (run `--write`, so the baseline only shrinks). Closing a duplicate means moving the copy
to the owner, then regenerating the baseline in the same commit.

| Layer                      | What lives there                              |
| -------------------------- | --------------------------------------------- |
| L1 engine model and render | anything visible on a page item               |
| L2 engine crate            | pure, generic Rust                            |
| `platform/shared`          | format-family code (OOXML, DrawingML, ODF)    |
| L3 host and door           | tools and panels that act on any item         |
| L4 module                  | a domain workflow, the oracle's own semantics |

Status: **done**, **partial**, **open**. A row is only done when the ratchet has no baseline for it.

## Enforced by the ratchet

| Capability                     | Owner                                                    | Copies outside it (baseline)                                          |
| ------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------- |
| XML escaping                   | `paged-ooxml` `xml::escape_attr` / `escape_text`         | 19 (open)                                                             |
| `[Content_Types].xml`          | `paged-ooxml` `content_types`                            | 26 (open); the exporters' main parts moved, tests and sheet-js remain |
| Roman and alphabetic numbering | `paged-model` `roman` / `alpha`                          | 0 (done)                                                              |
| sRGB transfer                  | `paged-color::math`, `paged-ooxml::colour`               | 11 (open)                                                             |
| Blend modes                    | `paged-blend`                                            | 6 (open)                                                              |
| FNV hash                       | none yet; `platform/shared/helpers` (TS) and a Rust util | 14 (open)                                                             |
| CRC-32                         | `crc32fast` (Rust), `platform/shared/helpers` (TS)       | 12 (open)                                                             |
| Base64                         | `base64` crate, `platform/shared/helpers`                | 2 (open)                                                              |

## Landed (do not redo)

- **Comments** (engine ADR 1055): one model for every module. Document threads with item, page,
  region and cell anchors; people; tasks, reactions, review state; source blobs; derived
  orphaning; the host Comments panel and canvas pins; slide comments on engine threads; PDF
  comment annotations (`paged export --comments`). Open: Excel threaded comments (editable) and
  sheet notes sync, Word people, mentions and `commentsExtensible`, IDML notes, PDF annotation
  import, the `comments@1` door, a sheet cell resolver.
- **OOXML foundation:** one DrawingML theme reader (`paged-ooxml::drawingml::theme`) for sheet
  and doc; content-type and relationship writers (`render`, `patch`) in doc, slide and sheet
  exporters; HSL through `paged_ooxml::colour`; `paged_store::package::read_document` for
  exporters reading a `.paged`.
- **Numbering:** `paged_model::roman` / `alpha`; slide PowerPoint schemes and start values map
  to the engine's numbering format, expression and start.
- **Blend:** `paged-blend`, 27 modes (ADR 1034). **Geometry:** `paged-geom`. **Vector effects:**
  `paged-vector-fx` (ADR 1042, 1053). **Paint v2, pattern, mesh:** ADR 1007, 1041, 1048 exist in
  `paged-model`.
- **Host:** Free Transform, History, Appearance, Effects and Transparency panels, view modes,
  asset export, vector clipboard, Data panel and bind popover, handle and transform-box doors.

## Open, by domain

### Colour

sRGB and linear light, naive CMYK, HSL, HSB and ΔE copies in `paged-gpu`, `paged-model`,
`paged-compose`, `paged-fidelity`, `slide-anim`, `image-conformance`, the image kernels and
three TS files → `paged-color::math` (bit-exactness against the goldens first). Office tint:
one function in `paged-ooxml::colour`, wrappers in sheet-chart, sheet-format and docx-core.
Default Office palette ×2. TS colour (hex, HSB, Lab, harmony) → `platform/shared/helpers`.

### Raster, kernels, blend

Blend enums remaining: `scene_layer.rs` (`SceneBlendMode`), `paged-psd` ×2, `web-render` ×2,
`image-kernels` `compose_twin`; blend math in `svg_filter.rs` and the image WGSL. Kernel
definitions: `paged-kernels` is ~1.1k lines, `image-kernels/families` ~22k (ADR 1013 has no
file). Decoders bypassing `paged-raster`: renderer `image_decode.rs`, `paged-export-pdf/image.rs`
(loses CMYK/ICC), `pdf-import` encoders, `web-bundle/png.ts`. `paged-psd-fx` is wired nowhere.
Path coverage rasterizers ×3 in image-js.

### Geometry and vector

Flatten ×9, kappa ×5, affine types ×4 → `paged-geom`. Draw's TS copies of width, brush,
along-path, envelope and `appearance-bake.ts` → `paged-vector-fx`. `dml-native` still maps
pattern fill to a two-colour mix, drops gradient alpha and loses `clrChange`: adopt paint v2.
`a:custGeom` / `a:xfrm` writer (`pptx-export/geom.rs`) → `dml-geom`. Pie wedge ×3 → `dml-chart`.
The host `tools` package still imports `@paged-media/draw/geometry` and `/machines`.

### Text and fonts

`image-js` has its own harfrust, skrifa and ab_glyph beside `paged-text`. `pptx-fonts` and
`paged-fmt` belong at L2 (`paged-fmt` is used by engine crates from `platform/shared`).
Chart label width ×2 → `dml-chart`. Number and date formats: `paged-numfmt` out of `sheet-format`.

### Office / OOXML / ODF

Hand-written relationships remain in sheet links and chart_write; `sheet-xlsx` keeps its own
`opc.rs` and `rels.rs`. Theme readers: `pptx-import` and `slide-resolve` still have their own;
the engine model has no theme (colour slots, font and format schemes as swatches and styles).
Writable XML tree ×4. Minimal `.xlsx` writer ×3 (`slide-sheet`, `sheet-js` csv, ods). ODF layer
shared between `docx-odt` and `ods.rs`. docProps are read by nobody.

### Lowering

`docx-lower` keeps a plugin-local IR and lowers through TS host commands; the target is Rust
building `paged_model` directly, as slide does. Sheet and data each have their own lowering.

### Charts, data, scripting, PDF

Doc has no charts (reuse `dml-chart` and the sheet engine). Slide's chart data editing carries a
second compiled sheet engine. `paged-data-xlsx` (calamine) → `sheet-xlsx`; CSV ×2; two Boa
sandboxes; `data-script` and `data-cli` overlap `paged-script` and `paged-cli`. PDF read has two
hayro devices (placed PDF, pdf-import); blank IDML / OCF zip writers ×5.

### Host tools and panels (TS)

Module copies to delete or move to the host: draw's gradient annotator and stop machine,
appearance stack, opacity mask, pathfinder, reflect and transform again, live corners and star,
fill/stroke panels, measure, copy appearance, graphic default paint, colour guide, SVG import;
doc's text-format verbs; sheet's format fallback; image's history list and `type="color"` inputs;
slide's adjust handles on `contribute.overlay`; doc's word count.

### Reach (gaps between modules)

- **doc:** shapes (`dml-geom`), picture crop (`srcRect`), recolour, charts, SmartArt, drop caps,
  OpenType features, embedded fonts, equations.
- **sheet:** shapes, native picture frames (so engine filters apply), item hyperlinks.
- **slide:** hyphenation (forced off), bullet font/colour/size, fields beyond `slidenum`,
  autofit, date/time fields.
- **all:** path tools in every context (`CONTEXT_SHARED_TOOL_IDS` is Free Transform only);
  image filters as `actions@1` steps on any picture; barcode insert; ML service and door.

### Small helpers

FNV ×7, CRC-32 ×2, SHA-512 by hand (`sheet-xlsx` protection), base64 ×4; the TS equivalents;
loss and diagnostic report shapes (9+); oracle harnesses (five runners).

## What stays in each module (L4)

| Module  | Keeps                                                                                                                                                                   |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| draw    | path construction tools, shape builder, live paint, repeat, blend, symbolism, recolour, text on path, graphic styles, patterns, image trace, DXF, Flare                 |
| image   | brushes and dab engine, retouch, selection and masking, layers, smart objects, layered PSD/TIFF save, Photoshop-only filters, colour modes, raster type UI              |
| sheet   | the formula engine, grid surface and find, Excel chart profile, XLSX/ODS specifics, conditional formatting, protection                                                  |
| doc     | WordprocessingML model and import/export, Word layout quirks, the Word skin, RTF, content controls, save-back splice                                                    |
| slide   | PresentationML, the inheritance resolver, table styles, show and presenter view, animation and transitions, video output, handout layouts, the PowerPoint chart profile |
| data    | Data Merge, catalogues, record flow, record templates, sources, the `data@1` implementation, the SQL editor                                                             |
| web     | Blitz layout, CSS to native mapping, fragmentation, the source editor, baking                                                                                           |
| publish | IDML adapters, PDF IR to native mapper, PDFium bundle                                                                                                                   |
