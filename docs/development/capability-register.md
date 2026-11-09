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

| Capability                     | Owner                                                                                                      | Copies outside it (baseline)                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| XML escaping                   | `paged-ooxml` `xml::escape_attr` / `escape_text`; `@paged-media/helpers` `escapeXmlText` / `escapeXmlAttr` | 2 (open): `paged-gen`, `paged-store` (engine crates cannot depend on `paged-ooxml`)                               |
| `[Content_Types].xml`          | `paged-ooxml` `content_types`                                                                              | 15 (open): every writer moved; what remains is hand-written minimal packages used as independent reader input     |
| Roman and alphabetic numbering | `paged-model` `roman` / `alpha`                                                                            | 0 (done)                                                                                                          |
| sRGB transfer                  | `paged-color::math`, `paged-colour-math`; `@paged-media/helpers` `srgbToLinear` / `linearToSrgb` (TS)      | 0 (done); the WGSL sources of three image kernel families are allowed (the GPU cannot call Rust)                  |
| Blend modes                    | `paged-blend` (`compose_twin::Blend` is now `paged_blend::BlendMode`)                                      | 0 (done); the wire vocabularies `SceneBlendMode` and `web-render`'s two mirrors, and the ABR wrapper, are allowed |
| FNV hash                       | `@paged-media/helpers` `fnv1a32` / `fnv1a32Utf16` (TS); `paged_pixel::fnv1a_64` (Rust)                     | 0 (done); two Playwright `page.evaluate` bodies are allowed (the page cannot import)                              |
| CRC-32                         | `crc32fast` (Rust), `@paged-media/helpers` `crc32` (TS)                                                    | 0 (done)                                                                                                          |
| Base64                         | `base64` crate, `platform/shared/helpers`                                                                  | 1 (open)                                                                                                          |

## Landed (do not redo)

- **Comments** (engine ADR 1055): one model for every module. Document threads with item, page,
  region and cell anchors; people; tasks, reactions, review state; source blobs; derived
  orphaning; the host Comments panel and canvas pins; slide comments on engine threads; PDF
  comment annotations out (`paged export --comments`) and in (`paged comments`, `paged-pdf-annots`; the PDF
  bundle imports them into the opened document, 2026-11-02), and an unedited imported annotation written back from
  its kept dictionary on the thread's page and point (engine ADR 1055 amendment, 2026-11-08). Oracles: PowerPoint opens the exported slide comments and
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
The default Office palette is `paged_ooxml::drawingml::theme::OFFICE` (single-owner rule `office-theme-palette`; sheet-chart and sheet-xlsx take it from there; engine ADR 1057 moves the presets into `paged_model::theme::presets`). TS colour (hex, HSB, Lab, harmony) → `platform/shared/helpers`.

### Raster, kernels, blend

Blend enums: one, `paged_blend::BlendMode` (the image twin's `Blend` is that type; `compose_twin::from_kernel_id`
resolves `compose.<id>`). Allowed with a reason: the camelCase wire enum `SceneBlendMode` in `scene_layer.rs`,
`web-render`'s two mirrors of it, and the ABR wrapper in `paged-psd` (it adds ABR-only texture modes). Kernel
definitions (engine ADR 1013): the model (`KernelDef` and its types), the `kernel_family!` macro, the ABI assembler (`abi`), the reference prelude and the `conv`, point-op (`linear`, `arithmetic`, `cast`, `boolean`, `relational`, `minmax`, `band`, `adjust`) and `adjust_ext`, `develop`, `compose`, `select`, `stylize`, `gallery` and `blurgal` families are in
`paged-kernels` (`image-kernels` re-exports them; its `reference` / `cpu` features forward to `paged-kernels`); the families only paged.image runs (~10k lines in `image-kernels/families`: gen, geom, warp, morph, resample, render, style, distort, pixelate, gallery_ext) stay, by the
rule in the record, each behind the registry gate and the conformance goldens. Decoders: `paged-export-pdf/image.rs` decodes an encoded-only image through
`paged_raster::decode_rgba8_at_with` (a TIFF or PSD converts through its profile; PNG, WebP and the other
`image` formats are byte-identical to before), and `web-bundle`'s PNG writer is `@paged-media/helpers`'
`encodePng` with `storeBelow` (output byte-identical, pinned). Not routed, with reasons: the renderer's
`image_decode.rs` keeps `jpeg-decoder` for the DCT-scaled decode of oversized JPEGs (`paged-raster` has no
DCT scaling) and `image::load_from_memory` as the fallback for a file `paged-raster` could not read (HDR);
`pdf-import`'s `encode::png` writes through the `png` crate, whose bytes differ from `paged-raster`'s encoder
for the same pixels, so a move needs a stated reason to change the embedded bytes. `paged-psd-fx` is wired nowhere: engine ADR 1044 states why (placing a whole PSD draws its merged
composite, which already holds the styles; the consumer is a "PSD layer as a page item" flow that does not exist yet).
`paged-composition-render` had no consumer and was deleted.
CPU blurs (engine ADR 1013, amendment "Blur"): `paged_kernels::blur` owns the `u8` Gaussians and the box pass with an
explicit `Edge` and `Round`; the effects lane's RGBA and mask Gaussians, the SVG filter's Gaussian and box pass, the
compose masks' box passes and image-gpu's selection feather moved onto it, bit-exact against the old bodies. Allowed,
with reasons in the record: the f32 image-pipeline twin `cpu::gaussian_weights` (already here; other weights),
image-js Refine Edge's f32 `gaussian`, `psd_vector_mask`'s f32 box feather, the `style::blur` reference twin, and the GPU
blurs (Vello's layer blur, the `conv` and `style` WGSL).
Polygon coverage (engine ADR 1013, amendment "Coverage"): `paged_kernels::coverage::polygons` owns the analytic
four-sub-scanline scan; the lasso (`image-gpu` `SelectionCoverage::rasterize_polygon`) and the region filter's
`rasterize_polygons` call it (one body, bit-exact against the old one), and `masking.rs`' point-sampled
`rasterize_nonzero` (dead outside its own test) is deleted. Allowed, with reasons in the record: `psd_vector_mask`'s
17 × 15-sample scan with the component booleans (fitted to Photoshop's vector masks), the compose masks' binary
one-sample fill (the InDesign effects' masks and PDF stamps), raster type's `ab_glyph_rasterizer` (signed-area
accumulation; its goldens are its own), and vello_cpu for page paths.

### Geometry and vector

Fixed-step f32 flattening is `paged_geom::flatten` (`cubic_point_f64` for the engine crates that measure in double, `paged-canvas` group extents) (renderer stroke/placed-SVG/text-path, compose
mask/dash-fit, text frame shapes; bit-identical, tested against the old copies). Left: `winding.rs`
(`paged-model` sits below `paged-geom`), `image-js` masking (no engine geometry dependency in the
image bundle) and the tolerance-driven ones (`psd_vector_mask`, kurbo in `paged-ps`). Kappa:
`paged_geom::KAPPA` / `KAPPA_F32`, and `KAPPA` from `@paged-media/helpers` in TypeScript (`bake-plan.ts` and the full-precision
specs import it; the `paged-gen` samples and the specs that pin a truncated literal stay, allowed).
The TS sRGB curve is `srgbToLinear` / `linearToSrgb` there (four editor and draw copies removed);
`paged-gpu`'s filter tables use `paged_colour_math`; the image conformance twin uses `paged_color::math`.
The f64 samplers of `winding.rs`, `draw-trace`, `slide-anim` and `image-js` stay (allowed: those crates sit
below or beside `paged-geom`). The IDML
`[f32;6]` product and point map are `paged_geom::affine` (`paged-mutate`, `paged-canvas`, the
renderer); the f64 affine (`[f64;6]`: slide-resolve, pptx-export's `geom`, `dml-geom::live`, `slide-native`, draw-dxf) is `paged_geom::affine64`, product, point map and the inverse (one singularity rule, `|det| < 1e-12`), bit-identical and tested against each old copy (single-owner rule `affine-product`). The f32 inverse's arithmetic is `paged_geom::affine::invert_if` (`paged-mutate`, `idml-export`, `paged-canvas` hit test, `paged-compose`'s `Transform::inverse`); each caller keeps its own singularity test (`|det| < 1e-9`, `< 1e-12`, zero or non-finite), since unifying them would change which matrices invert (single-owner rule `affine-inverse`). Open: `slide-native`'s pattern-tile inverse, which solves the translation in another arrangement (not bit-identical, so left). The `Affine` of
`paged-svg` and `Transform` of `paged-compose` keep their types but their product and point map call
`paged_geom::affine`.
Draw's TS copies of width, brush,
along-path, envelope and `appearance-bake.ts` → `paged-vector-fx`. `dml-native` adopts paint v2 where the
module's items are the engine's own (paged.slide, `Mapper::alpha_stops` / `pattern_swatches`): a gradient
whose stops differ in alpha keeps it as the swatch's opacity stops (ADR 1007; no gradient feather rides
on the item, and a gradient stroke fades too), and an opaque `a:pattFill` as a stroke's pattern swatch
(ADR 1041; the 8 x 8 pt cell as vector items). Open: the doc and sheet lane (`NativeFx` onto the wire,
TypeScript lowerings) still carries the feather and the two-colour mix until its lowerings take opacity
stops and pattern swatches; slide's pattern fill stays a picture of PowerPoint-measured tiles (an engine
pattern would need the slide-grid phase through `pattern_transform` per frame and would move the
goldens); a translucent pattern has no swatch (a tile item paints a colour without alpha). `a:clrChange`
stays a recorded loss: the filter stack (`RasterOp`) has no colour-replace op.
`a:custGeom` / `a:xfrm` writer and the placement maths: `dml-geom::place` (`Xfrm`, `Placed`, `Space`, `xfrm_xml`, `cust_geom`; `pptx-export`'s `geom` re-exports it, `pptx-core::Xfrm` is the same type), for doc and sheet writers too. Pie wedge ×3: examined, left open, they are not copies of one another: `slide-chart`'s `outline` (slide-resolve's and doc's charts, doc ADR 628) builds clockwise-from-12-o'clock `SubPath`s with arcs split at 90° by `ceil(|sweep|/90)`, `sheet-chart` emits a `Primitive::Wedge` that its renderer draws, and the engine's `pie_anchors` is f32, counter-clockwise from 3 o'clock with a `ceil(sweep/(pi/2) - 1e-9)` split; a shared primitive would move anchors in the last bits and the slide goldens with them. Chart label width ×2: also left open, `sheet-chart` counts characters at one advance (`ADVANCE_EM`), `slide-chart` weighs digits, separators and letters apart, so they measure differently on purpose (neither goes through `paged-text`). Default Office palette and theme readers: `pptx-import` and `slide-resolve` re-examined 2026-11-08 (see the OOXML foundation row): fonts and `SLOTS` shared, the colour reader kept for the unresolved `Color` the goldens rest on.
Draw's TS geometry and vector-tool machines moved to `platform/shared/vector-geometry` and `platform/shared/vector-tools` (C15), so the host `tools` package and draw both import shared packages; draw keeps only its Illustrator workflows in `draw-bundle`.

### Text and fonts

`image-js` keeps its own harfrust + skrifa shaping and outlines beside `paged-text`: raster type
does not take `paged-text` (it would pull the model and composer into the image wasm, and its
1/64 pt advance rounding is not pixel-identical); the fontations stack is pinned once in the
engine workspace (engine ADR 1058). `pptx-fonts` and `paged-fmt` now live at L2 (`engine/core/crates/pptx-fonts`, `engine/core/crates/paged-fmt`).
Chart label width ×2 → `dml-chart`. Number and date formats: `paged-numfmt` out of `sheet-format`.

### Office / OOXML / ODF

Hand-written relationships remain in sheet links and chart_write; `sheet-xlsx` keeps its own
`opc.rs` and `rels.rs`. Theme: one DrawingML reader (`paged-ooxml::drawingml::theme`) and one lowering
onto the engine's `Document.theme` (`dml-native::theme`: the part, the wire form a module's IR carries,
the swatch convention). Slide, doc and sheet use both; doc and sheet send `setTheme` on open and their
theme-coloured swatches follow a slot (engine ADR 1056, slice 4). `pptx-import` reads the font
scheme through the shared reader and keeps its own colour reader (its model holds each slot as an
unresolved `Color`, base and transforms, where the shared `Theme` holds resolved `Rgba` and drops a system
colour without `lastClr`; moving it would change the model, the serialised form and the resolver's input, and
the PowerPoint-verified slide goldens with them, so it stays, with the format scheme for slide's resolver and
slots outside the twelve); `slide-resolve` has no XML reader of a theme (`ThemeIr::of` projects the model, and
`rewrite_theme_xml` splices a part's text), takes `SLOTS` from the shared module, and keeps its key/variant
logic. Decided 2026-11-08. The format scheme is not modelled (ADR 1056,
Amendment 1).
Themes in IDML (engine ADR 1057, built): plain swatches for InDesign, the theme in the document label `x-paged:core.theme`, \"create theme from swatches\", font references on styles, presets owned by `paged_model::theme::presets`.
Writable XML tree: the one writable tree (`XNode`) now lives in `paged_ooxml::tree` (W5; `sheet-xlsx` re-exports it). The other three are not copies of it: `docx-odt`'s `El` is a read-only ODF tree with mixed text, `pptx-export`'s `El` and `docx-export/splice.rs` are byte locators that tolerate malformed text (`paged_ooxml::splice` reports it), so they stay. Minimal `.xlsx` writer: DONE (W5), one `sheet_xlsx::minimal` (package, A1 addressing, inline-string cell) used by `slide-sheet`, `sheet-js` csv and ods. ODF layer
shared between `docx-odt` and `ods.rs`. docProps: DONE (W5, `paged_ooxml::docprops`, PM-0018): read once, kept as document properties (`DocxDocument`, `Presentation`/`Deck`, `XlsxDocument::properties`) and carried into the engine document as the label `x-paged:core.docprops` for doc and slide; sheet has no engine document, a host reads `XlsxDocument::properties`. The parts themselves are untouched on save.

Equations (engine ADR 1090, slices 1 and 2 built): `paged-math` is the neutral math tree and its TeX-rule layout
(fractions, scripts, radicals, n-ary operators, delimiters, matrices, accents) onto glyph runs, rules and strokes
through a `MathMetrics` seam; `paged_ooxml::omml` is the one OMML reader for doc and slide (`m:oMath`,
`m:oMathPara`, transitional and strict; `in_part` for an importer's walk). The model holds an equation as an
inline object of its paragraph (`Paragraph.equations`); the renderer's one metrics adapter and paint are
`paged-renderer` `pipeline/equations.rs` (math face, OpenType `MATH` constants, the math alphabet
`paged_math::alphabet`); doc imports through the native builder, slide through `pptx-import` (the choice of an
equation's alternate content) and `slide-native`. Open: equations in table cells, a wire door, the Word-oracle
comparison. Text envelope (engine ADR 1091, slices 1 and 2 built): `paged_ooxml::drawingml::textwarp` reads `a:bodyPr/a:prstTxWarp` (41 presets, families,
adjusts) for doc, slide and sheet; `paged_warp::textshape` is the one set of preset guides; the frame's `text_warp` is bent by the
renderer's one pass (`pipeline/text_warp.rs`) over the text's outlines; doc and slide import it. Open: a measured match, write-back, handles.
ML: the first action over the ML doors is `media.paged.image/remove-background` (extensions ADR 1100, Amendment 1; tested on the fake
provider); `apps/ml-host` runs a user-installed matting runner (`matting` job, Amendment 2), which `mlHostProvider` serves as
`ml.matting@1` while the host's health lists it. Tier-A matting models are open.
Oracle scripts live in `tooling/oracle/` (one place for the InDesign,
Illustrator, Photoshop, Word and PowerPoint runners; windowless only).

### Lowering

`docx-lower` keeps a plugin-local IR and lowers through TS host commands; the target is Rust
building `paged_model` directly, as slide does (doc ADR 625: a seven-slice plan, the IR retires
slice by slice, the old path stays until the last). Built so far in `docx_skeleton::body` (each proven
against the old pour on the real engine: same text, page count and per-paragraph geometry, same unedited
export): body paragraphs and runs with direct formatting as the model's own fields instead of
`docx-auto-*` styles, lists, drop caps, plain tables (spans, insets, borders, shading, Word layout),
inline and floating pictures with crop and DrawingML looks (shadows, glows, gradients, effect stacks, a hand
port of the lowering kit's translator), text boxes with their looks, live fields and hyperlinks, footnotes
and endnotes (the endnote story and its page), comments and tracked changes, bookmarks, nested tables, breaks
inside a paragraph, headers and footers. They open as a prefilled skeleton when the whole body is native
(`NATIVE_BODY.enabled`, on); no `paged-mutate` is linked into the doc wasm. Still the old pour (the whole
document, never half): content controls, hyperlinked or reviewed fields, an endnote in a table cell. Sheet and
data each have their own lowering. Sheet and data each have their own lowering.

### Charts, data, scripting, PDF

Doc's charts (doc ADR 628) are read by `dml-chart` into slide's chart model and drawn from their cached values by
`slide-chart` (one layout for PowerPoint and Word), as anchored groups; the sheet engine is not linked (doc edits no chart
data yet). The doc wasm's ceiling went to 9 MiB for charts and SmartArt (doc ADR 627 amendment); it links `dml-geom` (doc ADR 629). Slide's chart data editing carries a
second compiled sheet engine (blocked on a host door: slide ADR 724). `paged-data-xlsx` reads through `sheet-xlsx` (calamine deleted, W5); CSV ×2 (open: `paged-data-store` links turso and parquet, which `sheet-js` must not; the owner has to be a small leaf crate, and the two readers differ on blank lines, delimiter sniffing and `|`, so it is not a bit-identical swap); two Boa
sandboxes; `data-script` and `data-cli` are folded (W9, engine ADR 1059): `paged-action`'s `js::sandbox_context` is the one Boa sandbox (paged-script uses it too), the script surface and the batch runner are modules of `paged-data-session`, and `paged data batch` replaces the `paged-data-batch` binary. PDF read: the two hayro devices (placed PDF, pdf-import) stay two (different targets) and share `paged-pdf-page` for page box geometry and blend modes (engine ADR 1058, W9); blank IDML / OCF zip writers ×5.

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
- Gradient annotator and stop machine: DONE 2026-11-02. The host Gradient tool (linear mode) now
  shows the selected object's gradient axis with a diamond marker at every stop
  (`handlers/gradient-annotation.ts`); a press on a marker grabs that stop, it slides along the axis
  between its neighbours, and the release writes one `editGradient` (one undo step, every other stop
  field kept; the spec of a moved stop is shared in `platform/shared/helpers`). A press elsewhere is
  the axis drag as before, Esc cancels. The line is drawn from the frame's centre and the gradient
  is a swatch (every object using it changes), as draw's note said. Draw's tool, handler, specs and
  the axis builder are gone (tool id left through the deprecation window). The stop machine stays
  in `@paged-media/vector-tools`. The annotation's gesture tests run on the fake client; the
  canvas behaviour is covered by the gradient e2e (now on the host tool).
- Appearance stack: MERGED 2026-11-01. The host declares `paged.appearance.*` (Add fill, Add
  stroke, Clear, Remove layer, Move layer; `appearance-commands.ts`) over the panel's own list
  functions, with Object > Appearance entries for the first three and draw's payload addressing.
  Draw's five commands, their menu entries, typed twins, strings and the native list functions
  that duplicated the panel's are gone (draw ADR 367 amended). Kept in draw: the stack model, the
  conversion and migration of old metadata stacks, the group bake and release, the graphic styles.
- Reflect / Transform again: MERGED 2026-11-02. The host declares `paged.transform.reflectHorizontal`,
  `reflectVertical`, `reflectOptions` (a dialog: axis angle, optional page-space axis point, Copy)
  and `again` (`reflect-commands.ts`, `panels/reflect-dialog.tsx`), with Object > Transform
  entries. They write through Transform Each's door (`R ∘ M` for an item, `setGroupTransform` in
  the parent frame for a group, one batch; Copy is `core.duplicateElements` first). The matrix
  algebra and the session's last-transform record are one implementation in
  `platform/shared/helpers` (`transform`); the host's Rotate, Scale and Shear tools record the
  linear part of what a drag did, so Transform again repeats those as well (draw's repeated only
  its own reflects). Draw's three commands, Reflect…, its Draw > Transform menu, typed twins,
  Path Options Reflect section, Reflect tool and `ReflectMachine` are gone (ids left through the
  deprecation window; draw ADR 359 amended). Not carried over: the tool's interactive axis (click
  for the axis point, drag to turn it, Alt+click for the options). The dialog types the same
  angle and point; a tool would need the host's tools to run a command.
- Live corners: MERGED 2026-11-01. The host declares `paged.corners.*` (Rounded, Inverse rounded,
  Bevel, Fancy, None; `corner-commands.ts`) with Object > Corners entries; the eight writes are
  one shared builder in `platform/shared/helpers` (`cornerPresetOps`) that draw's Corner Radius
  tool also uses. Draw's five commands and Draw > Corners menu are gone (ids left through the
  deprecation window). The `liveCorners` metadata marker the commands stamped was never read;
  a stale one is inert (the InDesign round-trip recordings still echo it, see the case).
- Star: MERGED 2026-11-02. The host declares `paged.insert.star` (`star-commands.ts`,
  `panels/star-dialog.tsx`): bare it opens a dialog (radius 1, radius 2, points, rotation), with a
  payload it inserts, centred on the page. The write is one implementation in
  `platform/shared/helpers` (`star`): a live star (`frameShapeSides` + `frameShapeStarInset`) only
  when upright and radius 2 < radius 1, else a plain path. The host Polygon tool has a Star option
  (default inset 50 % when none is set). Draw's Insert star command, its Path Options section, the
  Star tool, `StarMachine` and `starPath` are gone (ids left through the deprecation window; draw
  ADR 359 amended). Not carried over: the old tool's rotate-by-drag and click-for-dialog.
  Flare: KEEP (nothing like it in the host; draw's `Insert flare` and its section stay).
- Fill / stroke / dash: DONE 2026-11-02. The schema panels were already gone. The host Stroke panel
  now has a dash editor (`panels/dash-editor.tsx`): the four presets, a "Dashed line" switch that
  keeps the typed pairs, three dash/gap pairs, and a read-back that follows the selection with a
  note when a dash has more than three pairs; beside it the generic list field takes any run
  ("6, 3"). The model (pairs of an array and back, the preset runs, the one write) is shared in
  `platform/shared/helpers`. The four preset commands are `paged.stroke.dash*` (palette) and
  Object > Stroke > Dashes… raises the panel. Draw's `Dashes…` command, its Path Options "Stroke
  dashes" section and all its helpers are gone (ids left through the deprecation window). The dormant draw Stroke and Fill schema panels (never registered), their binding
  drivers and specs are deleted too.
- SVG import registration: KEEP, with the evidence for it (2026-11-02). There is one reader: the
  engine's (`requestSvgImport` / `exportSvg`, `paged-svg`). The host's File > Import / Export SVG
  commands (`svg-commands.ts`) and draw's `importer.svg` / `exporter.svg` registry doors both call that
  door and nothing else (draw ADR 364: the module's own TS reader and writer are deleted); AI and EPS
  go through paged.pdf's placement. What draw adds is the registration in the plugin registry
  (Place, drop, scripts and data bindings find importers there), and DXF, which the host does not
  have. Unifying the two entry points means a host importer registry the extension contract does
  not have; that is a contract change, not a duplicate to delete, so it is not done here.
- Colour guide: DONE 2026-11-02. The host Color Wheel panel has a Color Guide section: the
  selection's fill as the base (as the document shows it), a harmony rule menu, the harmony chips,
  and a row of variations per harmony colour (shades and tints, warm and cool, vivid and muted);
  a click paints the selection's fill through a swatch named for the hex (found or created, one
  batch), Alt-click its stroke. The maths is `@paged-media/vector-geometry`'s, shared with Recolor
  Artwork. Draw's panel and its `applyGuideColor` command are gone (ids left through the
  deprecation window; draw ADR 362 amended). Not verified locally: the section's DOM behaviour
  (no DOM test could run without wasm); the reads and the write are unit-tested.
- Measure: DONE 2026-11-02. The host has a Measure tool again (`paged.tool.measure`,
  `handlers/measure-tool.ts`, `shift+m`): drag to read a distance and an angle, the segment and its
  label as one preview that stays after the release, Esc clears, Shift snaps to 45 degrees, and the
  origin snaps to the nearest point on the path under the press (the hit-test's transform is reused,
  so no anchor table is read). It drives `MeasureMachine` from `@paged-media/vector-tools`. Draw's
  tool, handler, the raw nearest-point read, its readout binding (nothing read it) and specs are
  gone; the tool id leaves through the deprecation window.
- Copy appearance: DONE 2026-11-02. The host Eyedropper has a `mode` option (Pixel, as before,
  and Object appearance): click an element, its fill colour and tint, stroke colour and weight and
  opacity land on the selection in one batch, each target written only what its own snapshot
  exposes; Alt+click samples only. This is exactly what draw's tool sampled (typed properties; it
  never copied effects, which an earlier note here got wrong). The sampling and the write are
  shared in `platform/shared/helpers` (`sampled-style`). Draw's tool, its `shift+d` key and its
  feature id are gone (draw ADR 359 amended). Slide's format painter was not touched: it copies
  slide text and shape formatting, not this set.
- Sheet format fallback: DONE 2026-11-03. The workbook panel's Format section no longer renders a
  second copy of number format, font, fill, alignment, wrap and iterative calculation on a host
  without the Sheet properties panel (`DuplicatedFormatRows`, its presets and 43 strings are gone).
  Those rows live in the Sheet properties panel (character and paragraph text formatting of cells
  there is the host's text provider); borders, merge, freeze and sizes stay in the section.
- Image history list and colour inputs: DONE 2026-11-03. The Layers section's step list
  (`data-image-history-list`) duplicated the host History panel, which already lists the image
  context's history with the snapshots (`context-history.ts`); the list, its three strings and the
  `onUndoTo` / `onRedoTo` props are gone (the Undo / Redo buttons and the memory readout stay).
  The snapshot section stays: taking, renaming and deleting snapshots and the History brush source
  have no host counterpart. All six remaining `type="color"` inputs (layer properties and stops,
  layer styles, channels and new spot colour, filter dialog) go through `ColorInput`
  (`panels/sections/color-input.tsx`): the host's `widgets.ColorPicker` when offered, the browser
  input otherwise.
- Doc word count: DONE 2026-11-03. The host Info panel has a Text section (Words, Characters;
  `info-panel.tsx`, arithmetic in `info-readouts.ts`): the document's totals over every story the
  engine reports, and the words of a selected range as "n of total". It serves any module's text.
  Doc's Words status item, its `word-count.ts`, the store's `words` and two strings are gone
  (status items are not feature ids, so no deprecation entry). Not carried over: the Word status
  bar line itself; the count now sits in Info.
- Doc text-format verbs: DONE 2026-11-03. The verbs' arithmetic and runner are one implementation
  in `platform/shared/helpers` (`text-format.ts`: bold / italic toggles, underline, strikethrough,
  sub / superscript, caps, size steps, the four alignments, indent steps, line spacing 1 / 1.5 / 2;
  `runTextVerb` over a `TextDoor`). The host declares `paged.text.*` (`text-format-commands.ts`) with
  Type > Format entries and palette rows, over the live content selection and the engine's
  story-range reads and writes (a caret formats the word around it; one batch, one undo step);
  slide text gets them in every context that has a text selection. Doc keeps the Word skin: its
  scoped keys, control bar (`home-group.tsx`) and command ids are unchanged and run the same
  `runTextVerb` through `host.text` (doc's own verb code and `format.ts` arithmetic are gone, its
  recording-host spec passes unchanged). No doc id was removed, so no deprecation entry. Kept in
  doc, not generic: the multilevel list presets (`lists.ts`: Word's `1. a. i.` / `1.1.1.`), styles,
  highlight, borders. Host key bindings: DONE 2026-11-08 (`TEXT_FORMAT_KEYBINDINGS`, each with its Cmd and
  Ctrl twin): Cmd/Ctrl+B bold, I italic, U underline, and InDesign's chords for the rest (Shift+L / C / R / J
  align, Shift+K all caps, Shift+H small caps, Shift+/ strikethrough, Shift+= superscript, Alt+Shift+= subscript,
  Shift+. and Shift+, the size steps; the indents and line spacings have no convention and no key). They are guarded
  on a text selection with no form field holding focus (the canvas text surface is not one: it handles only Cmd+Z,
  A, C, X and the arrows), so they never shadow the text input. A guarded binding beats an unguarded one on a
  chord, so Cmd+U underlines while text is selected and stays Smart Guides otherwise; a Word document's scoped
  Cmd+B / I / U (rank 100) still wins inside it. Not done: slide's own format painter was not touched.
- PDF vectors dialog: DONE 2026-11-03. File > Import > PDF or AI as Vectors… is paged.pdf's now: a
  panel (`media.paged.pdf.panel.importVectors`, `vectors/import-panel.tsx`), the command
  `media.paged.pdf.command.importVectors` and the same menu row, all contributed by the bundle. The panel
  calls `inspectPdf` / `placeVectors` directly (the host dialog went through the two typed commands,
  which stay for scripts and the CLI) and picks the file with `host.shell.pickFile`. The host dialog,
  its DOM spec and its `app.pdfVectors.*` strings are gone; `paged.file.importPdfVectors` left through
  the deprecation window. Differences: a panel instead of a modal (it stays open after Place and always
  lists the report; "Start over" replaces Cancel).
- Slide adjust handles: KEEP for now, with the evidence (2026-11-03). `overlay.handles@1` reports a
  hit only to the bundle's OWN tools (`hitHandle` on their pointer events, extensions ADR 339), and
  slide contributes no tool: the selection is the host's Selection tool, which never asks a bundle's
  handle set. Moving the handles means slide shipping a selection tool of its own (losing the host's
  move / marquee / resize) or the host's Selection tool routing handle hits to the owning bundle (a
  contract change, as editor ADR 310 decided for the live-shape widgets). Neither is a safe port, so
  `adjust-handles.tsx` stays on `contribute.overlay`.
- Bind from the property field: PARTLY DONE 2026-11-03. The badge's "is this path bound" read no longer
  invokes `media.paged.data.propertyBindings`: `probeBound` asks the data door (`data@1`
  `bindings()`, the target an address or a selector resolved through `host.objects.query`), whichever
  bundle serves it (spec: `test/state/property-bound-probe.test.ts`). The bind popover already used
  `data@1` when a service is up. Still there: the no-service fallback that invokes
  `media.paged.data.bindProperty` (it opens paged.data's Bindings panel prefilled) in `object-field.tsx`
  and its typed args in `registries/command.ts`; with no data door nothing can bind, so it is dead
  weight to delete next, with the `BindNotice` command text.
- Path and shape tools in every context: DONE 2026-11-03. `CONTEXT_SHARED_TOOL_IDS` lists Pen, Direct
  Selection, Line, Rectangle, Ellipse and Polygon besides Free Transform; solo profiles keep the same list.
  The unit spec (`host-panels-every-context.test.ts`) and the parked e2e (`tests/host-panels-every-context.spec.ts`)
  are updated; the e2e was not run (suite parked).
- LossReport (C18): STARTED 2026-11-03. One shape: `LossReport { losses: LossEntry[] }`,
  `LossEntry { code, count, pages?, message }` in `@paged-media/plugin-api` (`host.ts`, contract canary 78) and
  `paged_model::report::{LossEntry, LossReport}` in Rust (empty `pages` / `message` stay off the wire).
  Migrated: paged-pdf-annots' `Loss` (now `LossEntry`; `kind` / `reason` became `code` / `message`, with the
  bundle's `PdfLoss` and its spec) and the PDF bundle's `LossLine` (now the contract type, same fields).
  Not migrated (each is its own producer shape): pdf-import's vector-place `Loss { code: &'static str, count }`
  (a `&'static str` code threaded through the device and snippet collectors; its JSON is already a subset of
  `LossEntry`, so the move is mechanical but wide), image-js `LosslessShape` (a save-back classification, not
  a count), paged-psd-fx `StyleLoss { effect, what }` (Display only), and the TS/Rust diagnostics of sheet-xlsx,
  doc (docx lowering notes), slide (PPTX) and the IDML import report, which are free-form note lists.

### W9 status (2026-11-08): PDF, scripting, data leftovers

- **Done:** one PDF page reader for the placed PDF and place-as-vectors (`paged-pdf-page`, engine ADR 1060); one
  Boa sandbox, `data-script` and `data-cli` folded into `paged-data-session`, `paged data batch` (engine ADR 1059).
- **Slide handout PDF (`slide-output/pdf.rs`): stays its own writer, for now.** It is 70 lines of object
  serialisation (classic xref, one Helvetica Type1 font, RGB Flate image XObjects) under the handout layouts, which
  stay in slide. `paged-export-pdf` is a display-list backend (subset CID fonts, ICC, PDF/X); moving the handouts
  onto it means building a display list of image and Helvetica text commands, and the bytes change (object order,
  font object, no `/Info` title string form), with no visible gain; the tests pin the structure, not a golden. The
  profitable change is the other way round: a `pdf-writer`-based `serialize` (the crate `paged-export-pdf` already
  builds on) would drop the hand-written xref, but it is a byte change for nothing the user sees. Open, not
  blocked. The host `ExportPdfDialog` and the bundle's `exportPdf` already share the engine's `exportPdfBegin`
  options (`ExportPdfWireOptions`); a shared host service would only move the option defaults, so it was not made.
- **Illustrator graph data:** stays carried, data ADR 565 (no chart item in the engine, opaque payload, no charts
  in doc).
- **Barcode insert in doc and slide:** built (engine ADR 1092, editor ADR 314). The encoder was already an engine
  crate; it is now reachable as `paged.barcode(symbology, data, quietZone?)` on the script surface (a pure read,
  no protocol bump; catalog row and contract canary 79), and the host's `paged.insert.barcode` (dialog: data,
  symbology) draws it as grouped vector modules in one undo step, with `Object ▸ Insert barcode…` in every kind
  of document and German strings. The row is the host's, not a doc or slide bundle entry (a bundle entry names a
  command the bundle registered). No human-readable line under a 1D symbol; paged.data's bound barcode keeps
  `lower_barcode`. Wasm size impact is gated by core / ci, not measured locally.
- **CLI data verbs onto `data@1`:** open, and smaller than it looked. `data@1` has `query(sql)`, `bind` and
  `bindings`; it has no `importSource`, `merge`, `planBatch` or `apply`, which are most of `apps/cli/src/data.ts`.
  Only `previewQuery` (-> `query`, a different row shape and no `total`) and `defineProperty` (-> `bind`, property
  bindings only) have door equivalents. Moving them splits the verbs across two doors for two calls; do it together
  with `importSource`/`merge`/`apply` moving into the door.
- **Publish preflight-fix actions:** open. `media.paged.publish.preflight` answers findings; a fix is an
  `actions@1` step per finding kind, which needs the finding kinds to carry an addressable target first.

### Reach (gaps between modules)

- **doc:** recolour, chart data editing, SmartArt editing, OpenType features, equations. Charts: DONE from the cached values
  (doc ADR 628, `slide-chart`'s layout, anchored groups; chart data editing through the sheet engine is open). SmartArt:
  DONE as drawn (doc ADR 629: the `dsp:drawing` Word saved, as an anchored group of shapes and text frames; editing the
  diagram is open). Shapes: PARTLY DONE (doc ADR 627: non-text `wps:wsp` as anchored Rectangle frames drawn along their
  outline, every Annex D preset through `dml-geom` since doc ADR 629 and literal custom geometry, `wps:style` completing
  the look; a shape's own text wrap is open). Embedded fonts: DONE (doc ADR 626: Word's obfuscated `.odttf` faces are unlocked, held to
  their `fsType` licence and given to the document-font door, as slide does; the shared part is
  `paged_ooxml::fonts`). Drop caps are the engine's paragraph drop cap (doc ADR 624), checked
  against Word's render: a 2-line cap matches, a 3-line cap is +10 % tall and 2.1 pt wide, a following
  paragraph is not wrapped beside a cap taller than its own (known differences, in the note). Picture crop (`srcRect`) is done (doc ADR 623): the lowering sets
  the picture's placement on its anchored frame (`imageContentTransform`, engine ADR 1045's
  amendment of 2026-11-02), and Word's render matches the OOXML definition for all eight fixture
  pictures. A crop changed in the editor is written back as the picture's `a:srcRect` (inverse of the
  placement; unchanged crops stay byte-identical; a picture of unknown size, a metafile, is
  reported), in the body and in table cells; pictures in nested tables and in headers are not.
- **sheet:** done (W7, sheet ADR 529 to 531): pictures keep their crop (`a:srcRect` as the frame's
  image placement) and picture corrections (`a:lum`, `a:duotone`, `a:grayscl`, `a:biLevel`, `a:hsl`,
  `a:blur` as the engine's filter stack, engine ADR 1037); `xdr:sp` / `xdr:cxnSp` shapes are read, their
  preset and custom outlines evaluated by `dml-geom` and their paint mapped by `dml-native`, and drawn
  as native paths over the placed table; a picture's or shape's `a:hlinkClick` is the engine's item
  hyperlink (`insertItemHyperlink`; cell links stay sheet's). Open, reported as losses: the text of a
  shape or text box, arrowheads, shapes in groups, the in-frame grid (draws pictures raw and no
  shapes), a rotated `xdr:pic`.
- **slide:** autofit (stored `fontScale` / `lnSpcReduction` are applied as fixed values, which is what
  PowerPoint draws on open; the engine has no shrink-to-fit, only frame growth: slide ADR 724). Chart
  data editing still carries its second compiled sheet engine (`slide-sheet`); sharing sheet's needs a
  host door that does not exist (PM-0002, slide ADR 724). Done and checked against PowerPoint:
  date and time fields (the 13 `datetimeN` types are engine date fields, written back as `a:fld`), bullet
  font/colour/size (the marker's character style, written back as `buFont`/`buClr`/`buSzPct`). Hyphenation off is
  right: PowerPoint does not hyphenate.
- **all:** path tools in every context (DONE 2026-11-03: `CONTEXT_SHARED_TOOL_IDS` adds Pen, Direct Selection, Line, Rectangle, Ellipse, Polygon; editor ADR 311 amended);
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
