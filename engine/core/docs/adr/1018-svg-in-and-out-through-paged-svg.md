# ADR 1018 — SVG in and out through `paged-svg`

- **Status:** Accepted 2026-10-24.
- **Scope:** protocol v77. The new crate `crates/paged-svg` (import and export);
  `paged-canvas` (`svg_io.rs`, the `RequestSvgImport` / `ExportSvg` messages and their
  replies); `paged-canvas-wasm` (`dispatch.rs`); `paged-mutate`
  (`PropertyPath::FrameGradientFillStart`); `paged-introspect` (its `frameGradientFillStart`
  row); `paged-gpu` (`svg.rs`) and `paged-renderer` (`pipeline/placed_svg.rs`), which walk
  usvg trees through `paged_svg::walk` (plan item C9). Consumers: the editor's File ▸ Import ▸ SVG and Export ▸ SVG, paged.draw's SVG
  importer and exporter (through the SDK doors `document.importSvg@1` and
  `document.exportSvg@1`). Gaps D-58 and D-59 (master plan WP4.12, WP4.8, WP6.10).

## Context

The renderer already parses SVG with `usvg` 0.48, but only to draw a placed SVG (ADR 190;
its vector lane `placed_svg.rs`). Bringing an SVG into a document as editable page items was
paged.draw's TypeScript reader: paths, basic shapes, group transforms, solid colours and
compound shapes. It left out gradients, text, images, `<use>` / `<defs>` / `<symbol>`, clip
paths, masks and CSS stylesheets, and every other module had nothing. Export was draw's too:
the selection's paths in solid colours.

What an SVG means is a large specification (CSS cascade, `<use>` instancing, units and
`viewBox`, markers, inheritance) that `usvg` resolves into a small tree. The engine's own
vocabulary for page items is the wire `Mutation`. And what every module draws, at last, is a
page's display list.

## Decision

**One crate, two halves.** `paged-svg` is pure Rust and wasm-safe, and reads no file and no
system font.

**One walk (plan item C9).** Three consumers read a parsed SVG: the raster lane
(`paged-gpu` draws it with vello_cpu), the placed-SVG vector lane (`paged-renderer` writes it
into the display list) and the import. They walked the tree three times, each with its own
idea of which transform a node is in, what a nested SVG image or a text is, and which shapes
a clip path is made of. `paged_svg::walk` is that walk, once: a `Visitor` (`enter_group` /
`leave_group`, `path`, `image`, `nested_svg`, `text`) over `walk_children` / `walk_group` /
`walk_tree`, and `clip_nodes` for a clip path's shapes and the groups in it that clip again.
Transforms compose in the visitor's own type (`Visitor::Ts`): the raster lane keeps kurbo's
`f64` affines, so not a pixel of its output moves; the vector lane reads usvg's absolute
transforms and composes nothing; the import composes its own `f32` affine. The walk needs
only usvg: the renderer and paged-gpu take the crate with no default features, so the
read-only viewer links neither the mutation crates nor usvg's text shaper.

**Import = a usvg tree lowered to ONE wire batch.** `plan_import` parses with `usvg` (with
`text`; the caller's fonts in its database, generic families mapped to the first of them; a
link to an outside file resolves to nothing and is reported) and walks the tree with explicit
transforms into one `Mutation::Batch`. Every created item is named by a `bindCreated` handle
right after its creating child, so later children paint, group, clip and mask it. Applying
the batch is one undo step through the ordinary `Mutate` lane: the engine plans
(`RequestSvgImport`, a read), the caller applies. A user unit is a point (usvg runs at 72 dpi,
so `width="612pt"` is 612 units), the convention Illustrator and paged.draw read SVG by.

| SVG | Native |
|---|---|
| a path, a basic shape | `insertPath` (first contour, page-local), and for several contours the whole table through `framePath` + `frameBounds` (spread space): one compound element. Transforms are baked into the anchors. A stroke-only shape with open contours becomes one element per contour (`framePath` has no open flags), which draws the same |
| fill / stroke colour | a swatch per distinct colour, `Color/svg-rrggbb`, named with its hex; reused when the document has it |
| opacity, fill-opacity, stroke-opacity | `frameOpacity`, `frameFillOpacity`, `frameStrokeOpacity` |
| fill-rule | `frameFillRule` (ADR 1006) |
| stroke width, caps, joins, miter limit, dashes | `frameStrokeWeight`, `frameStrokeEndCap`, `frameStrokeJoin`, `frameStrokeMiterLimit`, `frameStrokeDashArray` (scaled by the transform) |
| linear / radial gradient | `createGradient` with a swatch per stop; `frameGradientFillStart` / `Angle` / `Length`. A linear axis is SOLVED in page space (the normal of the mapped isolines), so a skewed gradient is exact |
| stop opacity that differs between stops | a gradient feather on the same axis (`frameGradientFeather`) |
| `<g>` | `createGroup` with its opacity, blend mode and isolation; a group of one item folds into the item |
| clip-path | each clipped leaf is pasted into its own frame of the clip shape (`pasteInto`) — the pixels of one clip over the group, in the model the engine has before clip groups (ADR 1010) |
| mask | `applyOpacityMask` (luminance or alpha) when the mask is one shape; each masked leaf takes its own copy |
| `<image>` | a frame with the picture as a `data:` URI (ADR 208), fitted content-to-frame; a rotated or skewed one keeps its transform (`moveFrame`). A nested SVG image is imported as vectors |
| `<text>` | a text frame per text chunk (family, style, size, fill, tracking, underline, strike-through, the anchor as the justification), its first baseline on the SVG baseline, when the family is a document font and the text is plain; its outlines otherwise |
| `<use>`, `<symbol>`, CSS, markers, `viewBox`, units | resolved by usvg before the walk |

`frameGradientFillStart` is new: the model always had `gradient_fill_start` (IDML's
`GradientFillStart`, read and written by the adapter) but no write. It is an additive
`PropertyPath` (`Value::Lengths [x, y]`, `[]` clears).

**Export = a display list written as SVG.** `export_display_list` writes a page's list (the
export build, so glyph runs are known and the canvas's markers are not drawn): paths in page
coordinates (the list strokes in page space, so widths carry over), linear and radial
gradients in page space, clips as `<clipPath>`, blend groups and layers as `<g>` with
`opacity`, `mix-blend-mode`, `isolation` and a Gaussian blur, soft masks as `<mask>`, a
gradient feather as a `<mask>` over its object's run, drop shadows as a blurred offset copy,
images as data URIs (PNG / JPEG / GIF / WebP as they are, anything else re-encoded as PNG),
and text as outlines (the default) or `<text>` naming the registered family. Colours are the
list's linear light written as sRGB. A page, or some items (`elementIds`: the view box fitted
to what they draw), or a region; `minify` writes one line.

**Every loss is named.** Both halves return an `SvgReport`: one row per code, its severity
(`approximated` / `dropped`), a sentence and a count. Import codes: `filter`, `pattern`,
`image.external`, `text.noFont`, `text.outlined`, `gradient.spread`, `gradient.focal`,
`gradient.radialSkew`, `gradient.stroke`, `gradient.stopOpacity`, `stroke.nonUniform`,
`stroke.dashOffset`, `stroke.miterClip`, `paintOrder`, `path.openCompound`, `path.nonFinite`,
`clip.nested`, `clip.compound`, `clip.empty`, `clip.group`, `mask.nested`, `mask.perItem`,
`mask.target`, `mask.empty`, `mask.complex`, `opacity.group`, `blend.group`, `blend.nested`.
Export codes: `gradient.conic` (a sweep gradient is its mean colour: SVG has none),
`overprint`, `stroke.marks`, `group.knockout`, `mask.invert`, `effect.*` (inner shadow, glows,
bevel, satin, feather), `image.undecoded`, `text.outlined`, `list.unbalanced`.

**The wire (v77).** `RequestSvgImport { pageId, bytes, options }` → `SvgImportPlanned
{ mutation, report, width, height, error }`; `ExportSvg { pageId, elementIds, options }` →
`SvgExported { svg, report }` / `ExportSvgFailed { error }`. New message kinds, hence the bump.

## Consequences

- Every module context imports SVG as native items with one undo step, and exports any page
  or selection as SVG; paged.draw's TypeScript reader and writer stay only as the fallback for
  an engine before v77.
- `usvg`'s `text` feature is now in the engine wasm (about 0.9 MB, the shaper the renderer
  declined for placed SVGs). Feature unification turns it on for the renderer's `usvg` too;
  the renderer hands usvg no fonts, so a placed SVG still draws no text, as before.
- An import → export → import is a fixed point (`svg_io.rs`).
- A change to how SVG is walked (a new node kind in usvg, how text or a nested image is
  read) is made once, in `walk.rs`, for drawing, the vector lane and the import alike.
- Clip groups (ADR 1010), per-stop opacity and conic paints (ADR 1007) and symbols (ADR 1012)
  will replace the per-leaf clips, the feather and the reported losses; the codes say where.
