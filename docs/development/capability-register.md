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

| Capability                     | Owner                                                                                                      | Copies outside it (baseline)                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| XML escaping                   | `paged-ooxml` `xml::escape_attr` / `escape_text`; `@paged-media/helpers` `escapeXmlText` / `escapeXmlAttr` | 12 (open)                                                                                              |
| `[Content_Types].xml`          | `paged-ooxml` `content_types`                                                                              | 18 (open); every writer moved, what remains is test fixtures and the in-test tables of three src files |
| Roman and alphabetic numbering | `paged-model` `roman` / `alpha`                                                                            | 0 (done)                                                                                               |
| sRGB transfer                  | `paged-color::math`, `paged-colour-math`                                                                   | 11 (open)                                                                                              |
| Blend modes                    | `paged-blend`                                                                                              | 6 (open)                                                                                               |
| FNV hash                       | `@paged-media/helpers` `fnv1a32` / `fnv1a32Hex` (TS); no Rust owner yet                                    | 8 (open)                                                                                               |
| CRC-32                         | `crc32fast` (Rust), `platform/shared/helpers` (TS)                                                         | 12 (open)                                                                                              |
| Base64                         | `base64` crate, `platform/shared/helpers`                                                                  | 2 (open)                                                                                               |

## Landed (do not redo)

- **Comments** (engine ADR 1055): one model for every module. Document threads with item, page,
  region and cell anchors; people; tasks, reactions, review state; source blobs; derived
  orphaning; the host Comments panel and canvas pins; slide comments on engine threads; PDF
  comment annotations out (`paged export --comments`) and in (`paged comments`, `paged-pdf-annots`; the PDF
  bundle imports them into the opened document, 2026-11-02). Oracles: PowerPoint opens the exported slide comments and
  re-saves them with every comment, reply and the resolved state intact; Word's review round trip is recorded in
  `modules/doc/docx-conformance/fixtures/review.word.json`. Excel threaded comments are read and written in
  `sheet-xlsx` (sheet ADR 528) and projected into the engine threads as cell anchors; Excel opens and keeps what
  the panel's reply, edit and resolve produce. Open: starting a thread from the panel on a cell, plain notes as
  threads, Word mentions (Word's own scripting makes none, so no marker is proven), IDML notes, the `comments@1` door. Word's `people.xml` and `commentsExtensible.xml` (exact UTC dates) are read and
  written (doc ADR 622); Word opens what paged saves with no repair prompt.
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
one function in `paged-colour-math` (f64; `paged-ooxml::colour` re-exports it, engine ADR 1056), wrappers in
sheet-chart, sheet-format and docx-core. `paged-colour-math` also owns the DrawingML colour-transform chain
(`transform`: lumMod, satOff, tint, shade, alpha …) and `Rgba`, proved bit-identical to the former
`paged-ooxml` code by `tests/oracle.rs`; the `srgb-transfer` single-owner rule baselines the other copies.
Default Office palette ×2. TS colour (hex, HSB, Lab, harmony) → `platform/shared/helpers`.

### Raster, kernels, blend

Blend enums remaining: `scene_layer.rs` (`SceneBlendMode`), `paged-psd` ×2, `web-render` ×2,
`image-kernels` `compose_twin`; blend math in `svg_filter.rs` and the image WGSL. Kernel
definitions: `paged-kernels` is ~1.1k lines, `image-kernels/families` ~22k (ADR 1013 has no
file). Decoders bypassing `paged-raster`: renderer `image_decode.rs`, `paged-export-pdf/image.rs`
(loses CMYK/ICC), `pdf-import` encoders, `web-bundle/png.ts`. `paged-psd-fx` is wired nowhere.
Path coverage rasterizers ×3 in image-js.

### Geometry and vector

Fixed-step f32 flattening is `paged_geom::flatten` (renderer stroke/placed-SVG/text-path, compose
mask/dash-fit, text frame shapes; bit-identical, tested against the old copies). Left: `winding.rs`
(`paged-model` sits below `paged-geom`), `image-js` masking (no engine geometry dependency in the
image bundle) and the tolerance-driven ones (`psd_vector_mask`, kurbo in `paged-ps`). Kappa:
`paged_geom::KAPPA` / `KAPPA_F32` (the `paged-gen` samples and the TS copies stay). The IDML
`[f32;6]` product and point map are `paged_geom::affine` (`paged-mutate`, `paged-canvas`, the
renderer); the inverse (three singularity tests), the `[f64;6]` copies (slide ×3, draw-dxf) and
the `Affine`/`Transform` newtypes of `paged-svg` and `paged-compose` → `paged-geom`.
Draw's TS copies of width, brush,
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
the engine model has a theme since engine ADR 1056 (slice 1: colour slots and font scheme on
`Document.theme`, filled by slide's import; the collection, operations, swatch references and
doc/sheet lowering are open; the format scheme is not modelled).
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

Status (draw items, one line each; updated as they land):

- Opacity mask: DONE 2026-11-01. The Transparency panel (`transparency-panel.tsx`) and the
  core commands `applyOpacityMask` / `releaseOpacityMask` (Object > Opacity mask) cover make,
  release, mode, clip, invert and edit-mask, and read the relation from the object model
  (`opacityMask`), so draw's metadata stamp (`data.opacityMask`, only ever read by draw) is
  gone with its writer; a stale stamp in an old document is inert. Draw's command ids and
  its Draw > Opacity mask menu left through the deprecation window (`deprecated-ids.json`).
- Graphic default paint: MERGED 2026-11-01. The decision (document defaults win, else the
  document's `[Normal Graphics Frame]`, else InDesign's 1 pt black stroke) and the batch
  builders (`resolveGraphicPaint`, `graphicPaintFromStyle`, `withGraphicPaint`) are one
  implementation in `platform/shared/helpers`. The editor's tools and draw's tools each keep
  only their two reads (client / `BundleHost`), which cannot be shared.
- Pathfinder: MERGED 2026-11-01. The host declares `paged.pathfinder.*` (all ten verbs,
  `pathfinder-commands.ts`), with Object > Pathfinder menu entries and palette rows; the panel's
  buttons run the same two functions. Draw's ten commands, its Draw > Pathfinder menu and its
  strings are gone (ids left through the deprecation window); what stays in draw is what its
  other tools build on (`pathfinderMutationFor`, the paint-order readers, the faces builder).
  Neither side had keybindings. After a success the shape modes leave the kept object selected
  and the region verbs clear the selection (draw's behaviour, now the host's).
- Gradient annotator and stop machine: KEEP. The host gradient tool commits an axis drag
  (and the freeform modes) but draws no axis for an existing gradient and has no stop markers on
  the canvas; draw's annotator shows the axis with a marker per stop and drags a stop along it
  (`GradientStopMachine`). The host's `gradient-editor.tsx` is a panel, not the canvas lane.
  Delete draw's when the host tool shows the axis and stops.
- Appearance stack: MERGED 2026-11-01. The host declares `paged.appearance.*` (Add fill, Add
  stroke, Clear, Remove layer, Move layer; `appearance-commands.ts`) over the panel's own list
  functions, with Object > Appearance entries for the first three and draw's payload addressing.
  Draw's five commands, their menu entries, typed twins, strings and the native list functions
  that duplicated the panel's are gone (draw ADR 367 amended). Kept in draw: the stack model, the
  conversion and migration of old metadata stacks, the group bake and release, the graphic styles.
- Reflect / Transform again: KEEP. The host has rotate, scale and shear tools and Transform
  each, but no Reflect and no repeat-last-transform; nothing to delete.
- Live corners: MERGED 2026-11-01. The host declares `paged.corners.*` (Rounded, Inverse rounded,
  Bevel, Fancy, None; `corner-commands.ts`) with Object > Corners entries; the eight writes are
  one shared builder in `platform/shared/helpers` (`cornerPresetOps`) that draw's Corner Radius
  tool also uses. Draw's five commands and Draw > Corners menu are gone (ids left through the
  deprecation window). The `liveCorners` metadata marker the commands stamped was never read;
  a stale one is inert (the InDesign round-trip recordings still echo it, see the case).
- Star and Flare: KEEP. The host's polygon tool draws a live star by drag, but there is no host
  command or dialog for a parametrised star (radius 1, radius 2, points, rotation) and nothing
  like Flare; draw's `Insert star…` / `Insert flare` and their Path Options sections stay.
- Fill / stroke / dash: DONE 2026-11-02. The schema panels were already gone. The host Stroke panel
  now has a dash editor (`panels/dash-editor.tsx`): the four presets, a "Dashed line" switch that
  keeps the typed pairs, three dash/gap pairs, and a read-back that follows the selection with a
  note when a dash has more than three pairs; beside it the generic list field takes any run
  ("6, 3"). The model (pairs of an array and back, the preset runs, the one write) is shared in
  `platform/shared/helpers`. The four preset commands are `paged.stroke.dash*` (palette) and
  Object > Stroke > Dashes… raises the panel. Draw's `Dashes…` command, its Path Options "Stroke
  dashes" section and all its helpers are gone (ids left through the deprecation window). Still in
  draw: the unregistered stroke schema (`panels/stroke-panel.ts`) whose dormant dash section only
  carries a pointer text, and the binding driver its specs exercise; delete both with the rest of
  that dormant module.
- SVG import registration: KEEP. The host has File > Import / Export SVG commands
  (`svg-commands.ts`); draw's `importer.svg/dxf/ai/eps` and `exporter.svg/dxf` are registry
  doors (Place, drop, scripts, data bindings), a different entry. Whether the host's drop path
  could use the registry's SVG door instead is open; not proven, not touched.
- Colour guide: KEEP. The host colour wheel (`color-wheel-panel.tsx`) authors a harmony from the
  wheel's own colour and adds swatches; draw's panel reads the selection's fill, offers the
  shade/tint, warm/cool and vivid/muted variation grids and paints the selection from a chip.
  Merging means adding those three things to the host wheel.
- Measure: KEEP. The host has no Measure tool (`built-in-tools.ts` records its retirement in
  favour of draw's); nothing to delete until the host builds one.
- Copy appearance: KEEP. The host eyedropper samples one composited pixel into a swatch and
  fills with it; draw's copies a whole appearance (fills, strokes, effects). Different feature.

### Reach (gaps between modules)

- **doc:** shapes (`dml-geom`), picture crop (`srcRect`), recolour, charts, SmartArt, drop caps,
  OpenType features, embedded fonts, equations.
- **sheet:** shapes, native picture frames (so engine filters apply), item hyperlinks.
- **slide:** autofit (stored `fontScale` is applied as fixed values). Done and checked against PowerPoint:
  date and time fields (the 13 `datetimeN` types are engine date fields, written back as `a:fld`), bullet
  font/colour/size (the marker's character style, written back as `buFont`/`buClr`/`buSzPct`). Hyphenation off is
  right: PowerPoint does not hyphenate.
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
