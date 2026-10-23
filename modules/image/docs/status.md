# Status

What `paged.image` ships and what it does not, read from the code at commit `f7d21e5`
(`@paged-media/image` 0.1.0-canary.16), with the changes of 2026-10-04 noted where they
landed. How the parts fit is in
[`architecture.md`](architecture.md).

## Shipped

- **Ingest.** "Adjust image" reads the original bytes of the one selected placed image; an
  importer takes `.psd`, `.psb`, `.png`, `.jpg` and `.jpeg` files. PNG and JPEG, including
  CMYK JPEG, are decoded by the codec adapters, a PSD from its merged composite (RGB,
  greyscale, and CMYK converted to sRGB through the file's embedded profile). EXIF
  orientation is applied. Decoding runs in a worker pool when the host grants workers.
  A file imported with one empty frame selected is placed in that frame: its composite is
  committed into it with its layers, as a commit does. A frame that already holds an image
  only previews the file.
  Each image starts with the panel at identity; values set on one image do not carry over
  to the next.
- **Adjustments.** The "Image" panel has a histogram and a re-runnable chain: exposure,
  brightness, contrast, saturation, temperature and tint, levels (composite and per
  channel), tone curves (composite and per channel), Hue/Saturation (master, six colour
  ranges, colorize), vibrance, colour balance, black and white, posterize, threshold,
  photo filter, channel mixer, blur, sharpen, hue rotate, invert, and "Auto-enhance". Apply
  runs it on the GPU, within the selection if there is one, and shows it inside the frame.
  Sliders preview live on a resampled proxy; full resolution follows when they rest.
- **Filters and fills.** One-shot kernels from the panel: gradient map, warp, emboss, find
  edges, motion and radial blur, mosaic, twelve gallery effects, despeckle, dust and
  scratches, offset, lens blur, reduce noise, smart sharpen, selective colour, median,
  maximum and minimum (3×3), colour lookup from a `.cube` file, shape blur; gradient (foreground
  to background), noise, solid, pattern and content-aware fills; Define pattern; the paint
  bucket; a gradient tool (drag the line); red-eye removal.
- **Selection.** Rectangle and ellipse marquee, lasso, polygonal lasso, magic wand and
  quick selection, combined by add, subtract and intersect; select all, deselect, invert,
  feather; expand, contract, border and smooth; wand and bucket tolerance and contiguity;
  a channel as selection; selection to path and path to selection.
- **Colour.** Foreground and background colour, swap, black and white, a picker; Alt-click
  with a paint tool samples the image.
- **Paint, retouch, type.** Brush, pencil, eraser, clone stamp and healing brush on the
  active layer; dodge and burn by tonal range (shadows, midtones, highlights) with an
  exposure, and the sponge (saturate or desaturate at the brush's flow) — filter strokes
  through the `adjust.dodge_burn` kernel, masked by the dabs' coverage; blur and sharpen
  brushes (the Gaussian/unsharp chain under the dabs, strength = flow); the spot healing
  brush (on release an exemplar search around the stroke picks a source offset, and the
  heal composite — source plus membrane tone correction — lands under the stroke); the patch
  tool (drag the selection onto the source; the selection is replaced by the region at that
  offset and healed to its surroundings); with size, hardness, opacity, flow, spacing, blend mode and pen pressure;
  presets from an `.abr` brush library. The type tool paints a shaped run of text into the
  active layer with font bytes the host serves for the document's fonts.
- **Layers.** Add, duplicate, remove, reorder; visibility, lock, opacity and 26 blend modes;
  a mask from the selection, Add layer mask (reveal all or hide all) and painting on a mask
  (a Pixels/Mask edit target: the brush and pencil paint the foreground's grey, the eraser
  reveals; each mask stroke is one undo step); groups; clipping; editable adjustment layers; smart objects
  (convert, re-render at a scale); bake the chain into a layer. One undo list covers pixel
  edits and every change to the stack ([ADR 463](adr/463-one-undo-list.md)); in the
  `rasterImage` context, entered by double-clicking an ingested frame, the host's undo
  reaches it and the host's Layers panel shows this stack.
- **Commit and reopen.** "Commit image edits to the document" stores the layers in the
  document's parts and puts their composite in the frame, as one document undo step;
  reopening the frame restores the layers ([ADR 462](adr/462-sessions-persist-in-parts.md)).
- **Canvas.** A crop tool with aspect presets and a straighten angle; resize with a
  nearest, Mitchell or Lanczos 3 filter; rotate 90°/180°, flip, and Canvas Size with an
  anchor over all layers; a Move tool and nudges for the selected pixels or the layer.
- **PSD.** A PSD whose layers the model reproduces opens as layers. Layers of the retained
  file can be renamed, removed and given another opacity before export. With no edit the
  writer reproduces the input bytes (`image-psd/tests/it/roundtrip.rs`). A session with more
  than one layer exports as a layered PSD (pixel layers, masks, groups, opacity, blend,
  visibility, clipping); with adjustment layers it is flattened, and says so.
- **Save-back and tiles.** "Apply to file" encodes the adjusted result as PSD, PNG or JPEG
  and "Save the adjusted file" hands it to the host's save door; three exporters offer the
  same formats. "Serve image tiles to the renderer" claims the frame's image resource.

## Object model, commands and template fields

Every image frame's layer stack is addressable through `host.objects` (kinds `image`,
`layer`, `mask`, `adjustment`, `smartObject`; `glue/src/object-model/`), headless and
without a GPU: a stack whose composite is not the identity is stored `pending` and the
frame keeps its previous image until a GPU realm re-composites it.

- **Canvas operations on a named image.** The image kind's `transform` (a quarter turn or a
  flip), `crop` and `canvasSize` rows rotate, flip, crop and resize the canvas of every
  layer and mask at once, in one undo step (`object-model/canvas-ops.ts`; pixels move,
  none is computed). The typed `rotateCw`, `rotateCcw`, `rotate180`, `flipHorizontal` and
  `flipVertical` take an optional `image`; `cropImage` and `canvasSize` are new. A stack
  holding a smart object is refused (its source re-renders on the GPU).
- **A typed `applyAdjustment`** `{ image, name?, params }` adds one adjustment layer with
  the given parameters, named, in one undo step.
- **A filter on a region.** The typed `filterRegion`
  `{ layer, params, region?, mask?, selection? }` runs the adjustment chain (blur, sharpen, hue, invert, exposure, levels, curves and the other
  adjustment-layer paths in `params`) on a pixel layer inside `region` (top, left, bottom and
  right in image pixels; the whole canvas without one), destructively, in one undo step; it
  is the layer kind's `filter` row. On the GPU where the realm has a device; headless (the
  Node CLI, the SDK's host) on the shipped CPU twins of the same nineteen kernels
  ([ADR 465](adr/465-cpu-twins-for-region-filters.md)), each within its kernel's tolerance of
  the reference, the two paths within one 8-bit level of each other. Adjustment layers, smart
  objects, locked and 16-bit layers are refused, and so is a filter that changes nothing.
  A selection is data headless: `mask` takes `polygons` (`[x, y]` image pixels,
  anti-aliased), `alpha` (one coverage byte per canvas pixel, or an image of the canvas size
  whose luminance times alpha is the coverage; `paged-node invoke` reads it from a file as
  `"@path"`) and `feather` (σ px), rasterised in Rust and clipped to `region`; partial
  coverage blends filtered and original pixels, the same mask on the GPU and the CPU path.
  Without `fillRule` each polygon fills alone and they union; `fillRule: "evenodd"` or
  `"nonzero"` fills them together as one path, so an inner polygon cuts a hole (non-zero:
  when wound the other way). `ops`, one `add` / `subtract` / `intersect` per polygon, folds
  the subtract and intersect polygons in order into the add polygons' shape (the whole
  image when there is no add polygon). `selection: true` filters within the editor's
  selection of that frame (intersected with any `mask`): the live one while the frame's
  image is open, and once another image opened, the one it had when it closed (the session
  keeps the last four frames' selections until another document opens). A selection made
  on the same image at another size (the aspect agrees within a pixel) is resampled to the
  canvas; one of another aspect (another crop) is refused, and so is a frame with no
  selection, headless or not, with the reason. A mask that covers no pixel is refused.
  `tests/plugin-surface/image-filter-selection.spec.ts` drives it in the running editor: a
  marquee drag, then the typed command, then one undo.
- **Interactive twins refuse headless.** A typed twin that acts on the image open in the
  editor fails with `unmapped:` when none is open, instead of doing nothing.

A template can open three parts of an edited image to a filler (extensions ADR 335;
`glue/src/object-model/template-fields.ts`). A field is the frame's `x-paged:template`
label; each kind grants `image.replace` (a write that leaves a one-layer composite places
the baked image), beside the module's own label on the frame.

| Kind                                 | Definition                    | Value                                         |
| ------------------------------------ | ----------------------------- | --------------------------------------------- |
| `media.paged.image.picture`          | `{ layer?, frame? }`          | `{ name, bytes }`; reads `{ name, pending }`  |
| `media.paged.image.adjustmentPreset` | `{ allowed, layer?, frame? }` | a preset's name (`allowed: [{ name, rows }]`) |
| `media.paged.image.layerVisibility`  | `{ layer, frame? }`           | a boolean                                     |

- `layer` is a layer's name; without it a picture field takes the bottom pixel layer. The
  picture replaces that layer's pixels as is, centred, so the adjustment layers above
  stay.
- A preset field keeps one adjustment layer (`layer`, default "Preset"): the first write
  creates it, later writes set every parameter to the preset's value or its default.
- The picture's read reports `pending`, so a form or `paged template fields` can say the
  frame still shows the previous composite.

## Limits of what is shipped

- **A GPU is required.** Only the region filter has a CPU path (ADR 465). Without WebGPU,
  the adjustment preview and Apply, the gallery and generator filters, painting, resize and
  the composite of more than one layer return an error; decode, the identity composite,
  selection, histograms and `filterRegion` still work.
- **The preview on the page** is one scene-layer image, cleared when the frame leaves the
  selection and on Reset. It goes through the scene layer's image doors (`submitImage`,
  `submitImageTiles`), so a brush sample sends only the rectangle it changed. Edits reach
  the document only by a commit (ADR 462). After each commit, revisions older than the last
  eight are deleted. Where the host has the binary mutation lane (`document.mutateBinary@1`)
  the baked PNG crosses as bytes; without it the bake is capped at 8 MB. Where the host
  announces saves (`document.onWillSave@1`), saving the document commits first.
- **Tiles** are level 0 only, served only after the command, and cut from the held image
  without the panel's chain. The mip export `image_tile_rgba8_level` has no TypeScript caller.
- **Colour.** Transforms run once, on the CPU, at decode: RGB with an embedded profile to
  sRGB (perceptual, no black-point compensation). CMYK (JPEG, and a PSD's composite and
  layer plates through one transform) goes to sRGB through its embedded profile with the
  perceptual table, which is how the lane approximates Photoshop's default view of a CMYK
  document (relative colorimetric with black-point compensation, which moxcms lacks): within
  4 levels, mean 0.44, on Coated FOGRA39 ink patches, up to 23 levels on saturated greens
  outside sRGB (`image-conformance/tests/it/psd_cmyk_photoshop.rs`). Without a profile, CMYK is
  converted by the plain ink formula, and the panel says so ("CMYK, converted to sRGB without a
  profile"); a converted CMYK source is stated as converted, not as managed RGB. The profile of
  an RGB PSD and of a PNG kept at 16 bits is not applied ("sRGB assumed"). There is no
  rendering-intent control. Kernels receive encoded values.
- **Depth.** A 16-bit RGB or RGBA PNG decoded on the main thread is held at 16 bits. The
  decode worker returns RGBA8, a 16-bit PSD is reduced to 8 bits, and a 16-bit greyscale
  PNG is refused (`image-js/src/ingest.rs:585-606`). `layers_open` (`image-js/src/lib.rs:2550`)
  and the panel's chain (`image-js/src/ingest.rs:1109`) take the held buffer as four bytes
  per pixel; `LayerStack::from_image_px`, which keeps the depth, is called only by tests.
  The scene-layer item, tiles and PSD save-back are 8-bit. A curve is a 256-entry table.
- **PSD.** The composite decode takes 8- and 16-bit RGB, greyscale or CMYK, raw or RLE (not
  16-bit RLE); other modes and depths are refused, and a transparent document's white-matted
  merged colour is un-matted (CMYK: matted against the paper). Layers are imported from RGB
  and CMYK files, each layer and its mask at its own bounds ([ADR 464](adr/464-layers-at-their-own-bounds.md);
  the 384 MiB budget counts the rectangles): pixel layers, groups and their user masks (an
  isolated group blends through its mask, a pass-through group's members each go through it),
  clipping, user masks, vector masks (drawn from their paths the way Photoshop draws them — a
  17×15 sample grid per pixel, per-component combine / subtract / intersect / exclude, even-odd
  or non-zero, invert — and multiplied with the user mask; on a fill/shape layer the stored
  pixels already are the shape; `image-psd/src/vector_mask.rs`), mask density and feather (a
  Gaussian of that sigma), fill opacity; smart objects as their stored render, accepted only
  where the file's merged composite agrees inside each one's footprint (a stale render, as on a
  corpus mock-up, opens flattened); text layers blended in a gamma space as Photoshop's are
  (`compose.normal_gamma`, 1.55: anti-aliased edges within 1–7 levels, where a plain blend was
  19–40 off; RGB documents, Normal mode); Curves, Levels, Exposure, Invert and Hue/Saturation
  adjustment layers (curves exact, the others within 1–4 levels of Photoshop-written layers);
  effects blocks that draw nothing; and Color Overlay, as a solid layer clipped to its base
  above the base's clipped layers (within 1 level). A file with other drawn effects, other
  adjustment layers (Photo Filter and Brightness/Contrast differ from Photoshop's), a group vector
  mask or a feathered shape mask opens flattened; artboards import (members cut to the
  artboard, its background beneath them), and says which (`PsdFile::layer_import_blockers` lists
  every reason; `image-psd/src/layer_pixels.rs`). A CMYK file's layers are converted to sRGB
  one by one and blended in RGB, which Photoshop does not do (it blends the inks), so a CMYK
  file opens flattened when a layer, group or overlay uses a mode other than Normal or Multiply
  (measured 9.9–50 ΔE00 p95 off on synthetic tiles), when it has no real merged data, or when
  its RGB flatten is more than 8 levels off the converted composite on over 1 % of the pixels or
  more than 2 levels off on over 5 % (a tint: Multiply over pale stock).
  Layers Photoshop writes for a 16-bit document (the `Lr16` block) are not read, so such a file
  opens flattened. Across the 157-file private corpus, 76 files open as layers and are measured
  against Photoshop's composite (3 did on 2026-10-04), all but one within 1.5 % of pixels more
  than 2 levels off; the rest open flattened, the commonest reasons being smart objects the
  composite does not vouch for (26, most of them Multiply smart objects in CMYK documents, which
  need ink-space blending), effects (16), CMYK blending (12) and fill opacity on special blend
  modes (8). Save-back is 8-bit RGB. "Apply to file" and
  the PNG and JPEG exporters encode the composite. The PSD exporter returns the retained file
  byte for byte only when the parameters are the identity and the pixels have not been edited since ingest; otherwise it
  runs the save-back, and when the save-back declines (a size change, a non-RGB or non-8-bit file) it exports nothing
  and says why (`glue/src/session.ts`, `psdExportBytes`; [ADR 460](adr/460-document-is-not-the-store.md)).
- **Layers and undo.** A layer is canvas-sized once edited (an imported layer keeps its bounds
  until then); the layer fold keeps whole-canvas accumulator textures, so the largest image is the device's texture limit (16384 px on Apple silicon,
  8192 on many others). A crop, resize or straighten replaces the stack with one layer and
  drops the history. The undo list keeps 200 structure steps; its pixel steps live in a tile
  journal of at most 32 entries and 256 MiB.
- **Raster type** has no line wrapping. **Content-aware fill** searches a bounded window.
- **Called only by tests:** Engine B's op-node evaluation and the residency manager's third
  tier (scratch storage), which returns an error.
- **Oracles.** Photoshop 2026's answers for 80 blend, adjustment and filter cases, seven
  layered RGB PSDs and six CMYK PSDs with Photoshop's own sRGB conversions are replayed in CI
  (`image-conformance/tests/it/oracle_photoshop.rs`, `psd_composite_photoshop.rs`,
  `psd_cmyk_photoshop.rs`): every case agrees, differs by a stated convention, or is declined
  on a measured disagreement; none is a defect. libvips's answers for the rows that name it are replayed by
  `oracle_vips.rs`; the GEGL-only rows have no runner.
- **Tests.** Device tests skip without a GPU adapter unless `PAGED_REQUIRE_GPU=1` is set, which
  turns the skip into a failure (`image-gpu/src/test_support.rs`). CI runs them on a software
  Vulkan adapter for every pull request and on Apple silicon after merges to main
  (`.github/workflows/ci.yml`, jobs `gpu-sw` and `gpu-metal`). The bundle specs run against a
  wasm built from the same commit; `glue/test/wasm-fresh.spec.ts` fails when the wasm was
  built from other sources.
- **Manifest.** It declares `rendering: hitTest` and `workers.sharedMemory`, which the
  bundle does not use, and caps the wasm at 8 MiB while the build script stops at 100 MB.
  The shipped `panels/image-adjustments.panel.json` is read by nothing.

## Not built

- Handing a GPU texture to the host ([ADR 459](adr/459-scene-layer-image-and-tiles.md)).
- A colour-transform kernel on the GPU ([ADR 457](adr/457-colour-management.md)).
- Image formats other than PNG, JPEG and PSD/PSB. `registry/codecs.yaml` records AVIF and
  JPEG XL as planned, camera RAW and HEIC as out of scope ([ADR 456](adr/456-codecs.md)).
- A writer for PSD descriptors, which are parsed read-only (`registry/psd-blocks.yaml`).
- A runner for the GEGL oracle the registry names for some rows.
- Rendering a smart object from its embedded source, layer effects other than Color Overlay, and reading PSD
  adjustment layers back as adjustment layers.
