# Status

What `paged.image` ships and what it does not, read from the code on `main`, 2026-10-24, at
`@paged-media/image` 0.1.0-canary.21 (manifest version 0.1.0). How the parts fit is in
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
  The PSD reader is the engine's `paged-psd` (WP1.2), so the canvas draws a placed PSD or
  PSB's merged composite before this module opens it, decoded the same way.
- **Adjustments.** The "Image" panel has a histogram and a re-runnable chain: exposure,
  brightness, contrast, saturation, temperature and tint, levels (composite and per
  channel), tone curves (composite and per channel), Hue/Saturation (master, six colour
  ranges, colorize), vibrance, colour balance, black and white, posterize, threshold,
  photo filter, channel mixer, blur, sharpen, hue rotate, invert, and "Auto-enhance". Apply
  runs it on the GPU, within the selection if there is one, and shows it inside the frame.
  Sliders preview live on a resampled proxy; full resolution follows when they rest.
- **Filters and fills.** Each one-shot filter opens one generic Filter dialog
  (`glue/src/filters.ts`, `panels/sections/filter-dialog.tsx`; Image ▸ Filter ▸ … and the
  panel's buttons): every parameter of its kernel as a slider, an angle dial, a choice, a
  switch or a colour, previewed on the canvas — on a resampled proxy while a value moves
  (one-layer image, no selection; px lengths scaled with it), at full resolution when it
  rests — with Preview and a before/after toggle; OK keeps the filter as one undo step in
  the active layer and inside the selection, Cancel leaves the image as it was. The filters:
  box blur, surface blur, motion and radial blur, lens blur, add noise (uniform or
  gaussian, monochromatic), despeckle, dust and scratches, median (radius ≤ 10), reduce
  noise, high pass, maximum and minimum (radius ≤ 32, square or round), offset, smart
  sharpen, emboss, find edges, glowing edges, mosaic, ten gallery effects, gradient map
  and selective colour; average (no dialog) fills the selection with its average colour.
  WP5.2 adds ([ADR 473](adr/473-filter-families-and-galleries.md)): **Distort** (displace
  with a map from the composite or a file, polar coordinates both ways, ripple, shear on a
  five-point curve, zigzag), **Render** (clouds, difference clouds, fibers in the
  foreground/background colours, lens flare in four lens types, lighting effects with one
  spot, point or infinite light and a texture channel), **Stylize** (wind, extrude, tiles,
  trace contour, solarize), **Pixelate** (crystallize, pointillize, mezzotint, facet, colour
  halftone with a screen per channel), **Adjust** (shadows/highlights, HDR toning, match
  colour, replace colour, equalize, desaturate, and Develop — white balance, tone, presence,
  HSL in eight ranges, colour grading, a parametric tone curve, sharpening and noise
  reduction, also as a Develop adjustment layer with its own panel in the layer's
  Properties). The **Filter Gallery** workspace stacks effect layers (eye, reorder, add,
  delete) over all 47 of Photoshop's gallery effects, applied as one undo step; the
  **Blur Gallery** workspace runs field (pins), iris, tilt-shift, path and spin blur,
  together if wanted, with its pins and handles on the canvas (any image tool's drag moves
  them). **Curves' targeted adjustment**: armed, a drag on the image moves the curve at the
  tone under the pointer. Warp and glass have their own Distort section; colour lookup from a
  `.cube` file, shape blur; gradient (foreground
  to background), noise, solid, pattern and content-aware fills; Define pattern; the paint
  bucket; a gradient tool (drag the line) in five geometries, linear, radial, angular,
  reflected and diamond (a tool option and the colour section's choice); red-eye removal.
- **Selection.** Rectangle and ellipse marquee, lasso, polygonal lasso, magic wand and
  quick selection, combined by add, subtract and intersect; select all, deselect, invert,
  feather; expand, contract, border and smooth; wand and bucket tolerance and contiguity;
  a channel as selection; selection to path and path to selection.
- **Colour.** Foreground and background colour, swap, black and white, a picker; Alt-click
  with a paint tool or the bucket samples the composite, a 3×3 average. The session's
  eyedropper (`sampleColor`, `glue/src/color-state.ts`) takes a point, 3×3 or 5×5 sample into
  the foreground or the background.
- **Paint, retouch, type.** Brush, pencil, eraser, clone stamp and healing brush on the
  active layer; dodge and burn by tonal range (shadows, midtones, highlights) with an
  exposure, and the sponge (saturate or desaturate at the brush's flow) — filter strokes
  through the `adjust.dodge_burn` kernel, masked by the dabs' coverage; blur and sharpen
  brushes (the Gaussian/unsharp chain under the dabs, strength = flow); the spot healing
  brush (on release an exemplar search around the stroke picks a source offset, and the
  heal composite — source plus membrane tone correction — lands under the stroke); the patch
  tool (drag the selection onto the source; the selection is replaced by the region at that
  offset and healed to its surroundings); with size, hardness, opacity, flow, spacing, blend mode and pen pressure;
  Content-Aware Move (move or extend the selection, structure 1–7, colour 0–10, a scale and
  angle on drop, sample all layers: the hole is filled and the seam re-synthesised); the
  Content-Aware Fill workspace (Edit ▸ Content-Aware Fill…: an automatic, rectangular or
  painted sampling area shown on the canvas, colour and rotation adaptation, scale, mirror, a
  preview, output to the layer, a new layer or a duplicate); the Remove tool (a stroke is filled
  from its surroundings; an `ml.inpaint` provider is asked first when one is installed — none
  ships); the Clone Source panel (five sources, each with an offset, width / height, angle and
  flip; an overlay with opacity, clipped, auto hide and invert; sample current layer, current
  and below, or all layers, also for the healing and spot healing brushes); healing diffusion
  1–7; spot healing types content-aware, create texture and proximity match. All of these run
  on a multi-resolution PatchMatch search ([ADR 469](adr/469-patchmatch-retouching.md)), with
  the final vote on the GPU (`geom.patch_vote`) or its CPU twin;
  presets from an `.abr` brush library. The type tool paints a shaped run of text into the
  active layer with font bytes the host serves for the document's fonts.
- **Layers.** Add, duplicate, remove, reorder; visibility, lock, opacity and 26 blend modes;
  a mask from the selection, Add layer mask (reveal all or hide all) and painting on a mask
  (a Pixels/Mask edit target: the brush and pencil paint the foreground's grey, the eraser
  reveals; each mask stroke is one undo step); groups; clipping; editable adjustment layers; smart objects
  in full ([ADR 482](adr/482-smart-objects-in-full.md)): a smart object is its source (the
  pixels it was converted from, an embedded or linked file, or page items), its placement (four
  corners: scale, rotate, skew, flip, perspective — Layer ▸ Smart objects ▸ Transform…, the move
  tool, every canvas op) and its smart filters with a filter mask, and its pixels are re-rendered
  from the three whenever one changes (the placement drawn on the CPU, Lanczos-reduced then
  bicubic; the filters on the GPU through the Filter dialog's catalogue); Edit Contents opens the
  source as a nested document and saving it is one step in the parent; Replace Contents, Relink,
  Update from file, Embed linked and Export contents; Place selected page items makes a vector
  smart object drawn again at a higher resolution when it grows; the host Links panel lists the
  smart objects' files while the image is open. Painting on a smart object is refused, as in
  Photoshop; bake the chain into a layer. One undo list covers pixel
  edits and every change to the stack ([ADR 463](adr/463-one-undo-list.md)); in the
  `rasterImage` context, entered by double-clicking an ingested frame, the host's undo
  reaches it and the host's Layers panel shows this stack. The Image panel's history list
  shows every step, oldest first, with the current position marked; a click walks the journal
  to that step.
- **Photoshop layer parity** (`image-js/src/layers/{kinds,verbs,fill_render}.rs`). Fill layers
  (solid colour, a gradient of any number of stops in five styles, a pattern), rendered by the
  `gen.*` kernels and re-rendered on edit or a canvas operation. Adjustment layers hold one
  adjustment each, in Photoshop's units, sixteen kinds with their own Properties (Brightness/
  Contrast, Levels, Curves, Exposure, Vibrance, Hue/Saturation, Color Balance, Black & White,
  Photo Filter, Channel Mixer, Color Lookup, Invert, Posterize, Threshold, Gradient Map,
  Selective Color); Gradient Map, Selective Color and Color Lookup run on the resident
  accumulator. A stored chain with one stage opens as its typed layer; a chain of several stays
  a chain. Blending Options: fill opacity (a multiplier outside the eight special modes; on them
  it moves the source toward the mode's neutral colour, a model no Photoshop recording has
  checked yet), knockout shallow and deep, Blend If per gray/red/green/blue with split sliders.
  Locks: transparent pixels, image pixels, position, all. Merge Down, Merge Visible, Merge
  Group, Stamp Visible, Flatten Image (over white), Layer via Copy and Cut, layer comps
  (visibility, position — the pixels as placed — and appearance), links (moved together),
  colour labels, search and filter of the list, align and distribute (to the canvas, the
  selection or the linked layers). Each verb is one undo step; the merges composite their
  layers on the GPU.
- **Commit and reopen.** "Commit image edits to the document" stores the layers in the
  document's parts and puts their composite in the frame, as one document undo step;
  reopening the frame restores the layers ([ADR 462](adr/462-sessions-persist-in-parts.md)).
- **Canvas.** A crop tool with aspect presets and a straighten angle; an Image Size dialog
  (pixel and printed size, resolution in ppi, constrain proportions, resample with a
  nearest, Mitchell or Lanczos 3 filter, or change only the resolution); Trim by
  transparent pixels or the top-left or bottom-right colour; rotate 90°/180°, any angle
  (Image Rotation ▸ Arbitrary: the canvas grows, the corners are transparent; quarter turns
  are exact), flip, and Canvas Size with an anchor — all over every layer and mask, each one
  undo step; a Move tool and nudges for the selected pixels or the layer. The resolution
  is read from a PNG's `pHYs` or a JPEG's JFIF density on open and written into PNG and
  JPEG exports; a PSD keeps its own resolution resource.
- **Curves tools.** Auto (each channel's own contrast, 0.1 % clipped at each end) and black,
  grey and white point eyedroppers: an armed eyedropper takes the next click on the image
  with an image tool and sets the channel curves from the sampled colour.
- **PSD.** A PSD whose layers the model reproduces opens as layers. Layers of the retained
  file can be renamed, removed and given another opacity before export. With no edit the
  writer reproduces the input bytes (`engine/core/crates/paged-psd/tests/it/roundtrip.rs`). A session with more
  than one layer exports as a layered PSD (pixel layers, masks, groups, opacity, blend,
  visibility, clipping); with adjustment layers it is flattened, and says so.
- **Panels, menu, shortcuts, language.** Beside the "Image" panel, an "Image properties"
  schema panel shows the selected frame's layer stack as property rows the host renders over
  `host.objects` (a layer list, then the picked layer's mask, adjustment and smart-object
  fields; `glue/src/panels/properties-panel.ts`). In the `rasterImage` context the bundle
  answers the host's Layers panel (the raster stack, groups as tree rows) and, while the type
  tool is in hand, the host's Character panel, whose raster-type settings are writable
  (`glue/src/binding-provider/`). A top-level `Image` menu carries the commands; the
  selection-to-path pair sits in `Edit` (`glue/src/menu.ts`). Tool shortcuts: crop `shift+x`,
  rectangle and ellipse marquee `y` / `shift+y`, lasso `shift+l` (the polygonal lasso shares
  it), magic wand `shift+w`, brush `q`, pencil `shift+f`, eraser `shift+e`, clone stamp
  `shift+t`, healing brush `j`, raster type `shift+z`; the other tools share a slot and have
  none (`glue/src/activate.ts`). The bundle's strings have a German translation
  (`glue/locales/de.json`).
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
  holding a smart object is refused (its placement moves with the op, which the headless
  manifest edit does not draw; the editor's canvas ops do, ADR 482).
- **A typed `replaceLayerPixels`** `{ layer, source }` replaces a pixel layer's pixels from
  an asset (a data: URL, or the address of a page item whose placed image supplies them),
  placed as is and centred, in one undo step; it is the layer kind's `pixelSource` row
  (`object-model/contribute.ts`, `image-objects.ts`).
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
  keeps the last four frames' selections until another document opens). When that frame's
  image opens again, its kept selection is set back into the engine and is the live
  selection again (`selection_set_coverage`; resampled to the image when it is the same
  image at another size, dropped when it is another crop). A kept selection belongs to the
  stored revision of the frame it was made on (its marker's record): a quarter turn or flip
  committed on that frame through the object model carries it along to the revision it makes
  (the revision before keeps the old one, for an undo), a crop or canvas resize drops it as
  the editor's own do, and on any revision it was not carried to it is refused with the
  reason that the image changed since, so it is never laid over pixels an edit moved. A
  selection made on the same image at another size (the aspect agrees within a pixel) is
  resampled to the canvas; one of another aspect (another crop, whose offset nothing
  records) is refused, and so is a frame with no selection, headless or not, with the
  reason. A mask that covers no pixel is refused.
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

## Actions

On a host with `actions@1` (extensions ADR 344, PM-0015) the bundle registers pure steps over
an encoded picture (`glue/src/actions.ts`; manifest `capabilities.actions.register`). Each
takes a PNG, JPEG or PSD composite (sniffed) and, but `info`, gives back a PNG or JPEG
(`format`: `keep` — JPEG for a JPEG, PNG otherwise — `png` or `jpeg`; `quality` 1–100). They
run on the engine wasm's CPU lane, so they need no GPU device:

| Id                            | In → out      | What it does                                                                                                                |
| ----------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `media.paged.image/info`      | asset → value | width, height, format, colour treatment at decode, 16-bit reduction, ppi                                                    |
| `media.paged.image/convert`   | asset → asset | decode to sRGB (CMYK and ICC profiles converted) and encode as `format` (default PNG)                                       |
| `media.paged.image/crop`      | asset → asset | cut `x`, `y`, `width`, `height` (0 = to the edge); `aspect` > 0 takes the largest centred rectangle of that shape inside it |
| `media.paged.image/adjust`    | asset → asset | the adjustment chain, `adjust` mapping the adjustment layer's parameter paths to values                                     |
| `media.paged.image/greyscale` | asset → asset | the Black & White stage at its default mix                                                                                  |
| `media.paged.image/sharpen`   | asset → asset | the unsharp stage at `amount`                                                                                               |

The chain runs on the GPU when this realm's engine has a device and on the CPU twins
otherwise (ADR 465). Not registered, and why: a resize or fit to a box is a resample, and the
resample kernels are GPU-only (`resize_image`), as is a straightened crop; an action may not
depend on whether the realm has a device. They wait for a CPU resample from the engine's
`paged-raster` / `paged-kernels` (PM-0014). WebP is neither decoded nor encoded.

## Limits of what is shipped

- **A GPU is required.** Only the region filter has a CPU path (ADR 465). Without WebGPU,
  the adjustment preview and Apply, the filter dialogs' preview and OK, the generator
  filters, painting, resize, arbitrary rotation and the composite of more than one layer
  return an error; decode, the identity composite, selection, histograms, Trim, quarter
  turns, the Curves tools and `filterRegion` still work.
- **Filter dialog limits.** Cancel leaves the filter as a redo step. The radius bounds are
  the kernels' windows (median 10 px, maximum/minimum and box blur 32 px, surface blur
  16 px, high pass σ 10 px); Photoshop's go further. There is no Reveal All: layers are
  stored within the canvas (ADR 464 clips their bounds to it), so nothing lies beyond it to
  reveal. Trim trims all four sides (no per-side choice).
- **WP5.2 filter limits.** The Filter Gallery effects and the Sketch filters are recipes over
  a dozen gallery operations, not Photoshop's algorithms; the Photoshop ledger records the
  distance (mostly `convention`). Lighting Effects takes one light, not several; Match Colour
  matches whole-image statistics (no source layer list inside a document); Replace Colour
  samples one colour (no colour-range preview or eyedropper sampling); the Blur Gallery has no
  per-pin focus ellipses beyond iris and spin, and Path Blur takes one polyline of up to eight
  points. HDR Toning, Lighting Effects and both galleries have no Photoshop recording (not
  scriptable).
- **The preview on the page** is one scene-layer image, cleared when the frame leaves the
  selection and on Reset. It goes through the scene layer's image doors (`submitImage`,
  `submitImageTiles`), so a brush sample sends only the rectangle it changed. Edits reach
  the document only by a commit (ADR 462). After each commit, revisions older than the last
  eight are deleted. Where the host has the binary mutation lane (`document.mutateBinary@1`)
  the baked PNG crosses as bytes; without it the bake is capped at 8 MB. Where the host
  announces saves (`document.onWillSave@1`), saving the document commits first.
- **Tiles** are level 0 only, served only after the command, and cut from the held image
  without the panel's chain. The mip export `image_tile_rgba8_level` has no TypeScript caller.
- **Colour.** Transforms run once, on the CPU, at decode, through the engine's CMS
  (`paged_color::cms`, [ADR 457](adr/457-colour-management.md)): RGB with an embedded profile to
  sRGB (qcms, perceptual, no black-point compensation). CMYK (JPEG, and a PSD's composite and
  layer plates through one transform) goes to sRGB through its embedded profile with relative
  colorimetric and black-point compensation, Photoshop's default view of a CMYK document: within
  1 level, mean 0.06, on Coated FOGRA39 ink patches, 4 levels on the saturated green outside sRGB
  that Photoshop clips differently (`image-conformance/tests/it/psd_cmyk_photoshop.rs`). Without
  a profile, CMYK is converted by the plain ink formula, and the panel says so ("CMYK, converted
  to sRGB without a profile"); a converted CMYK source is stated as converted, not as managed
  RGB. The profile of an RGB PSD and of a PNG kept at 16 bits is not applied ("sRGB assumed").
  There is no rendering-intent control. Kernels receive encoded values.
- **Depth.** A 16-bit RGB or RGBA source (PNG, TIFF, a 16-bit RGB PSD's layers) is held at 16
  bits, through the decode worker too ([ADR 479](adr/479-depth-and-colour-modes.md)). The layer
  stack, the fold, the panel's adjustment chain and Bake, undo, persistence, the layered PSD save
  and the 16-bit exporters keep the depth; an 8-bit tool's edit on a 16-bit layer lands at 16 bits
  inside its damage. Image ▸ Mode ▸ 8/16 Bits/Channel converts every layer as one undo step. The
  kernels compute in f32 and store f16, so a 16-bit document keeps about 11 bits in the highlights
  through a kernel (2826 distinct levels on a 16384-level ramp under a Levels gamma of 2.2, where
  Photoshop keeps 16259 and an 8-bit document 184). The scene-layer item and tiles are 8-bit (the
  display view). A 16-bit CMYK PSD, a 16-bit RLE layer channel and 32-bit sources are reduced to 8
  bits and say so. A curve is a 256-entry table.
- **Colour modes.** Image ▸ Mode ▸ Greyscale, RGB colour, CMYK colour and Lab colour convert every
  layer through the engine's CMS (Gray Gamma 2.2, the session's CMYK profile, CIE Lab) and keep the
  document inside that mode: a pixel edit lands projected inside its damage. The stack still works
  in RGB — layers are not ink planes and blends are not subtractive, and Indexed, Duotone and
  Multichannel are not offered. Against Photoshop: greyscale and 16-bit Lab within 0.05 of a level,
  CMYK (Coated FOGRA39) and 8-bit Lab within 1.8 ΔE at the 99th percentile. CMYK without a profile
  changes no colour, and the status says so. Image ▸ Proof shows Proof colours and the Gamut warning
  (Gray Gamma 2.2 or the CMYK profile) on the preview without touching the document. The layered PSD
  save keeps the file's own depth and mode.
- **PSD.** The composite decode takes 8- and 16-bit RGB, greyscale or CMYK, raw or RLE (not
  16-bit RLE); other modes and depths are refused, and a transparent document's white-matted
  merged colour is un-matted (CMYK: matted against the paper). Layers are imported from RGB
  and CMYK files, each layer and its mask at its own bounds ([ADR 464](adr/464-layers-at-their-own-bounds.md);
  the 384 MiB budget counts the rectangles): pixel layers, groups and their user masks (an
  isolated group blends through its mask, a pass-through group's members each go through it),
  clipping, user masks, vector masks (drawn from their paths the way Photoshop draws them — a
  17×15 sample grid per pixel, per-component combine / subtract / intersect / exclude, even-odd
  or non-zero, invert — and multiplied with the user mask; on a fill/shape layer the stored
  pixels already are the shape; `engine/core/crates/paged-psd/src/vector_mask.rs`), mask density and feather (a
  Gaussian of that sigma), fill opacity; smart objects as their stored render with their source, placement, smart
  filters and filter mask kept live (ADR 482), accepted where the file's merged composite agrees
  inside each one's footprint — a stale render (a corpus mock-up) is drawn from its source and
  judged again before the file opens flattened; text layers blended in a gamma space as Photoshop's are
  (`compose.normal_gamma`, 1.55: anti-aliased edges within 1–7 levels, where a plain blend was
  19–40 off; RGB documents, Normal mode); Curves, Levels, Exposure, Invert and Hue/Saturation
  adjustment layers (curves exact, the others within 1–4 levels of Photoshop-written layers),
  each opened as an editable typed adjustment layer; a layer's fill opacity, Blend If (the
  record's blending ranges), knockout, locks and colour label; solid-colour and gradient fill
  layers that are not shapes, as editable fill layers keeping Photoshop's render until edited
  (a pattern fill, whose pixels sit in the document's pattern block, stays pixels, and so does
  a gradient with transparency or noise);
  effects blocks that draw nothing; and Color Overlay, as a solid layer clipped to its base
  above the base's clipped layers (within 1 level). A file with other drawn effects, other
  adjustment layers (Photo Filter and Brightness/Contrast differ from Photoshop's), a group vector
  mask or a feathered shape mask opens flattened; artboards import (members cut to the
  artboard, its background beneath them), and says which (`PsdFile::layer_import_blockers` lists
  every reason; `engine/core/crates/paged-psd/src/layer_pixels.rs`). A CMYK file's layers are converted to sRGB
  one by one and blended in RGB, which Photoshop does not do (it blends the inks), so a CMYK
  file opens flattened when a layer, group or overlay uses a mode other than Normal or Multiply
  (measured 9.9–50 ΔE00 p95 off on synthetic tiles), when it has no real merged data, or when
  its RGB flatten is more than 8 levels off the converted composite on over 1 % of the pixels or
  more than 2 levels off on over 5 % (a tint: Multiply over pale stock). Every Photoshop
  adjustment kind but Color Lookup is read; Black & White, Channel Mixer, Posterize and
  Threshold are drawn, while Brightness/Contrast, Color Balance, Vibrance, Photo Filter, Gradient
  Map and Selective Color still open flattened (measured 25–109 levels from Photoshop; image
  ADR 478); fill opacity on a special mode still declines (the in-app model is unverified).
  Layers Photoshop writes for a 16-bit document (the `Lr16` block) are read into the layer list
  at parse and import like any others (ADR 478). Across the 157-file private corpus, 76 files open as layers and are measured
  against Photoshop's composite (3 did on 2026-10-04), all but one within 1.5 % of pixels more
  than 2 levels off; the rest open flattened, the commonest reasons being smart objects the
  composite does not vouch for (26, most of them Multiply smart objects in CMYK documents, which
  need ink-space blending), effects (16), CMYK blending (12) and fill opacity on special blend
  modes (8). The layered save writes 8- and 16-bit RGB and CMYK PSDs and PSBs: an unedited
  layer as the record it was read from, an edited one with only its edits replaced (text
  and vector masks stay live until their pixels change; a smart object stays live whatever is done
  to it — transformed, re-filtered or with new contents it is written with its corners, filters,
  filter mask and source, and Photoshop reopens it live, ADR 482), every adjustment kind
  Photoshop has a layer for (not Color Lookup or Develop), fill layers and styles — Photoshop
  reopens them as live layers ([ADR 478](adr/478-psd-write-depth.md)). "Apply to file" and
  the PNG and JPEG exporters encode the composite. The PSD exporter returns the retained file
  byte for byte only when the parameters are the identity and the pixels have not been edited since ingest; otherwise it
  runs the save-back, and when the save-back declines (a size change, a non-RGB or non-8-bit file) it exports nothing
  and says why (`glue/src/session.ts`, `psdExportBytes`; [ADR 460](adr/460-document-is-not-the-store.md)).
- **Layer parity limits.** Blend If is not offered on adjustment layers; knockout on a clipped
  layer is ignored; a clipping base's blending options apply only to the base; a gradient fill
  is aligned with the canvas (Photoshop's "Align with layer") and has no transparency stops; a
  layer comp's position is the layer's pixels, so applying it puts back the pixels as recorded,
  and a canvas operation drops the recorded positions. The layered PSD save writes colour and gradient fills, Curves, Levels, Exposure,
  Invert and Hue/Saturation adjustment layers and the blending properties; a pattern fill is
  written as its render, and any other adjustment kind makes the save flatten, naming the layer.
- **Layers and undo.** A layer is canvas-sized once edited (an imported layer keeps its bounds
  until then); the layer fold keeps whole-canvas accumulator textures, so the largest image is the device's texture limit (16384 px on Apple silicon,
  8192 on many others). A crop, resize or straighten keeps every layer and mask, is one undo
  step that keeps the history, and drops the selection (a crop does in Photoshop too); a
  quarter turn or flip carries the selection with the pixels, and a canvas resize drops it.
  A selection is session state ([ADR 460](adr/460-document-is-not-the-store.md)): it is
  never written to the document, so a reopened document has none, as in Photoshop, where
  keeping one means saving it as a channel. The undo list keeps 200 structure steps; its pixel steps live in a tile
  journal of at most 32 entries and 256 MiB.
- **Raster type** has no line wrapping.
- **Retouching.** The PatchMatch search is CPU and single-threaded; a fill of a few hundred
  thousand hole pixels takes seconds in wasm, and the workspace previews on a copy reduced to
  512 px. Photoshop's content-aware results cannot be reproduced numerically, so they have no
  oracle: quality is measured on synthetic stimuli (colour error and seam excess against a
  known background). The Content-Aware Move transform is a scale and angle typed on drop, not
  on-canvas handles. The Clone Source overlay replaces the frame's image while it shows. A
  multi-layer image needs a GPU for the composite after a retouch, as every layer edit does.
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
  bundle does not use, and caps the wasm at 9 MiB (raised from 8 MiB by ADR 479, at 8.39 MB)
  while the build script stops at 100 MB.
  The shipped `panels/image-adjustments.panel.json` is read by nothing.

## Not built

- Handing a GPU texture to the host ([ADR 459](adr/459-scene-layer-image-and-tiles.md)).
- A colour-transform kernel on the GPU ([ADR 457](adr/457-colour-management.md)).
- Image formats other than PNG, JPEG and PSD/PSB. `registry/codecs.yaml` records AVIF and
  JPEG XL as planned, camera RAW and HEIC as out of scope ([ADR 456](adr/456-codecs.md)).
- A runner for the GEGL oracle the registry names for some rows.
- Drawing the PSD adjustment kinds the import declines (above) as Photoshop does, and writing Color
  Lookup layers, text (`TySh`, WP5.10), vector masks and shapes (WP5.11).
- Smart objects (ADR 482): a warp (`customEnvelopeWarp`) is read and kept, not drawn; smart
  filters blend in Normal mode only and run at 8 bits; the filter mask is set from the selection,
  inverted, cleared or switched, not painted; a linked file is read again only through a picker;
  multi-page (PDF/AI) sources and the contents' layer comps are not offered.
