# ADR 1041 — A pattern is a swatch: a tile of vector items, repeated as a cached raster and written as a PDF tiling pattern

- **Status:** Accepted 2026-10-29.
- **Scope:** protocol v76 (additive; no bump). `paged-model` (`pattern.rs`: `PatternEntry`,
  `PatternLayout`, `PatternTileKind`, `PatternPlacement`, `PatternItem`, `PatternColor`,
  `PatternCell`; `Graphic::patterns`; the `pattern_transform` field of `TextFrame`, `Rectangle`,
  `Oval`, `Polygon` and `GraphicLine`); `paged-compose` (`pattern.rs`: `PatternId`, `PatternTile`,
  `PatternShape`, `PatternPaint`; `Paint::Pattern`, `DisplayList::patterns`); `paged-renderer`
  (`pipeline/pattern_paint.rs`, the fill, stroke and line modules); `paged-gpu`
  (`pattern_raster.rs`, `vello_map::pattern_brush`, both lanes, the CPU lane's ink planes);
  `paged-export-pdf` (`page.rs`: the tiling pattern); `paged-mutate` (`SwatchSpec::pattern`,
  `PatternSpec` and its parts, `PropertyPath::FramePatternTransform`,
  `OperationError::InvalidSwatch`); `paged-introspect` (the `framePatternTransform` row);
  `paged-canvas` (`swatches()` lists patterns, `pattern_detail`, `pattern_export.rs`);
  `idml-import` (the label restore). Gaps D-16, X-3 (pattern); work package WP7.1.

## Context

Illustrator, SVG (`<pattern>`), PDF (tiling patterns) and DrawingML (`<a:pattFill>`, and picture
tiles) all paint a shape with a repeated tile. InDesign has no pattern swatch, and neither did the
engine: a swatch was a colour or a gradient, and paged.draw's pattern feature could only bake the
tile into artwork (copies on a lattice, RFI C-31), never a fill another object could take. ADR 1007
named the pattern among the paints it left open.

A pattern is unlike ADR 1048's mesh in one way that decides its home: it belongs to no object.
The same pattern fills many frames, and a stroke as readily as a fill, as a gradient does. It is
a swatch.

## Decision

**The model: a swatch in the palette.** `Graphic::patterns`, keyed `Pattern/<id>`, holds
`PatternEntry`s; a frame shows one by naming its key as `fill_color` or `stroke_color`, exactly as
it names a gradient. An entry is:

- the **tile** rectangle `0..width × 0..height` in pattern units (pt before scaling);
- its **items**, bottom first: paths (anchors with handles, contours, open flags, fill rule) with
  a fill and/or a stroke colour — a palette swatch (`PatternColor::Swatch`) or an inline colour
  (`PatternColor::Inline`, `space` + `value` as paint v2's stops carry them) — and a stroke
  weight. Items may reach past the tile: copies then overlap. Text, pictures and gradients inside
  a tile are not modelled (an item paints a colour; a follow-up can widen it);
- the **layout** (Illustrator's Pattern Options): `Grid`, `BrickByRow`, `BrickByColumn`
  (each row or column shifted by `brick_offset` of the pitch, cumulatively — a true lattice),
  `HexByColumn` (columns `¾·width` apart, every other one half a row down), `HexByRow`;
  horizontal and vertical spacing (negative overlaps); and the **overlap order**, which copy is
  in front (`LeftInFront`/`RightInFront`, `TopInFront`/`BottomInFront`; the vertical order is
  the outer one);
- the **placement**: scale, then rotation (clockwise on the page), then offset, about the tile
  origin, which sits at the top-left of the frame's box.

A frame may move its pattern further on its own — Illustrator's "transform patterns" —
through `pattern_transform` (an affine in the frame's box space, applied after the placement).
Every new field is `serde(default)` and skipped when empty, so a document without patterns keeps
its bytes and its state hash (ADR 195).

**One cell for every consumer.** Every lattice repeats with a rectangular **period** (a brick
offset is snapped to the nearest `p/q`, `q ≤ 16`; Illustrator offers 1/2 … 1/5). The model
computes it once, with every copy whose items reach into it, in paint order
(`PatternEntry::cell`, at most 4096 copies). The renderer resolves the item colours through the
document's colour pipeline (a CMYK or spot swatch keeps its ink channels, ADR 106) and pushes a
`PatternPaint`: the shared `PatternTile` (period, items as paths with `Paint::Solid`/`Cmyk`, the
copies, an FNV-1a content hash) and the affine from pattern space to the drawing path's local
space. `Paint::Pattern(PatternId)` names it, so a fill, a stroke and a line's stroke take a pattern
through the same commands they take a colour. The fill and stroke modules rebase the placement
onto the path's space: the unit rectangle for a rectangle, text frame or oval drawn from its box,
the inner coordinates for an interned path (polygon, rounded or aligned rectangle, line). The
digest (ADR 101) includes each use's hash and affine.

**Rendering: the period, rasterised once per scale, repeated as an image brush.**
`paged_gpu::pattern_raster` draws the period — every copy, in order, clipped by the raster's edge
— with `vello_cpu` at the display scale (the largest stretch from pattern space to device pixels)
rounded up to a quarter-octave bucket, on a pixel grid that is an exact multiple of the period,
so a repeat has no seam; capped at 2048 px a side and 4 Mpx (the scale halves until it fits).
Rasters are cached process-wide by `(tile hash, bucket)` (64 MiB). Both lanes paint with it as an
image brush, `Extend::Repeat`, bilinear (`ImageQuality::Medium`): Vello through the brush
transform of `Scene::fill`/`stroke`, `vello_cpu` through its paint transform. The lanes therefore
receive the same pixels, as for a placed picture, and GPU/CPU parity (ADR 146) follows; each lane
keeps its last eight rasters as its own image objects, so a redraw uploads nothing. The `svg`
feature, which the renderer always enables, provides `vello_cpu` to a GPU-only build. A pattern
smaller than a few device pixels per period is minified bilinearly, without mipmaps: it aliases
as any repeated image would.

The rejected alternative — a tiled sub-scene, every copy drawn as vector paths in each lane —
is exact at every zoom but costs one draw per copy per item, unbounded for a small tile in a
large frame, and needs the clip and order logic twice; the raster is bounded by the screen.

**The CPU lane's ink planes (ADR 106).** A pattern's visible pixels are its raster, which carries
no inks. So that overprint and the separation still see a pattern's CMYK items, the planes are
written per item: each CMYK item paint (an item's fill and its stroke apart) is drawn alone, as a
pattern of its own over the same lattice and through the same shape, and its coverage splats its
inks — as the item would if it were drawn on the page. RGB items leave the planes alone, as RGB
paints do. An overprinting pattern fill takes the `Darken` fallback of every non-CMYK paint.

**PDF: a native coloured tiling pattern.** The writer emits `PatternType 1`, `PaintType 1`,
`TilingType 1`, its cell the period (`BBox`, `XStep`, `YStep`), its content every copy of every
item in its native colour space (a CMYK swatch writes its inks, a spot its Separation), with
resources of its own (the colour spaces its items name — sharing the page's dictionary would make
the pattern list itself, and Illustrator then refuses to open the file); its `Matrix` is pattern space to the parent stream's default space (the
page CTM on the page, identity inside a captured group, whose form is invoked under it). A fill
paints `/Pattern cs /P scn`, a stroke `/Pattern CS /P SCN`. Vector, resolution-independent,
editable as a pattern in Illustrator.

**IDML: a reported loss, kept in a label.** IDML has no pattern swatch. The export gives each
frame painted with a pattern a stand-in swatch InDesign can show (the first item's document
colour, else `None`) and moves the pattern into the frame's label (`paged:fillPattern`,
`paged:strokePattern`: the entry and the frame's pattern transform, JSON), and does not write the
palette entry. The IDML import puts the pattern back in the palette (the first label of an id
wins), points the frame at it again, restores its transform, and drops the label entries, so a
paged round trip through IDML is lossless and draws the same page. The loss report names every
such frame, checked against the re-imported twin, and every pattern swatch no frame uses (it has
nothing to ride on).

**SVG.** `paged-svg` (the shared SVG reader and writer, PM-0014) is not on this decision's base;
its `<pattern>` element (`patternUnits="userSpaceOnUse"`, `patternTransform` from the placement)
maps one to one onto the entry and follows when the two meet.

**The wire.** All additive at protocol 76 (governance rule 1): no new mutation kind.

- `SwatchSpec::pattern: Option<PatternSpec>` — `createSwatch` with a pattern keeps it under its
  `selfId` (which must start `Pattern/`) or a minted `Pattern/u<n>`; `editSwatch` on a pattern id
  replaces it (an edit without a pattern is refused); `deleteSwatch` removes it. Each inverse
  carries the whole prior pattern, so undo is exact. `PatternSpec` is camelCase: `width`,
  `height`, `items` (`anchors`, `subpathStarts`, `subpathOpen`, `fillRule`, `fill`/`stroke` as
  `{ swatch }` or `{ space, value }`, `strokeWeight`), `tileType`, `brickOffset`, `hSpacing`,
  `vSpacing`, `hOverlap`, `vOverlap`, `offset`, `scale`, `rotationDeg`. Validated on apply — a
  positive finite tile, a positive pitch, finite points, known names, a colour of a known space
  with its channel count, no pattern inside a pattern, a non-zero scale — and refused as
  `OperationError::InvalidSwatch`.
- `PropertyPath::FramePatternTransform` (`frame.patternTransform`, catalog
  `framePatternTransform`), `Value::Transform`, on the five painted kinds; a singular or
  non-finite affine is `InvalidValue`; the inverse is the transform it replaced.
- Reads: the `swatches` collection lists patterns with kind `"pattern"`;
  `CanvasModel::pattern_detail` returns a pattern's `PatternSpec`.

The contract advertises it as `document.patternPaint@1`.

## Evidence

- `crates/paged-model/src/pattern.rs`: a grid tile's one copy, a brick period two rows tall,
  a third brick needing three, the hex periods, overlap order deciding the last copy, negative
  spacing shrinking the period, the JSON round trip, the placement's order.
- `crates/paged-renderer/tests/it/pattern_paint.rs`: the tile repeated from the box origin, a
  brick row's shift, the placement and the frame's own transform (offset, scale), the clip to an
  oval, a pattern stroke on a line, inline colours, a CMYK item keeping its channels under a
  working profile, a missing or empty pattern falling back, and a document without patterns (or
  with an unused one) keeping its digest.
- `crates/paged-gpu/src/pattern_raster.rs`: the period on an exact pixel grid, one raster per
  bucket, an oversized period drawn softer, not refused. `vello_rs.rs`:
  `patterns_paint_alike_on_both_lanes__feat__…` — a fill and a stroke, upright and turned, at 72
  and 144 dpi, per pixel on Metal and `vello_cpu`. `separations.rs`: a cyan item separates its
  quarter of the area as 100 % cyan (plus the one-pixel bilinear fringe the repeated raster draws
  round each square); an RGB item separates nothing.
- `crates/paged-export-pdf/tests/it/pattern_paint.rs`: a coloured tiling pattern with its steps,
  matrix and resources; a brick cell two rows tall holding the shifted copy; a CMYK item written
  as inks; a stroke through `/Pattern CS`; and the page held by poppler's Cairo backend to the
  engine's raster (grid, turned grid, hex, brick stroke: at most 4 % of a 3-px lattice inside the
  frame differs by more than 40 levels — the tile edges, where the two antialiasers disagree by a
  partial pixel). Poppler's **Splash** backend (`pdftoppm`) misplaces a turned tiling pattern's
  cells by about a third of a cell; Cairo, macOS PDFKit (`sips`) and the engine agree with the
  matrix, so the test uses `pdftocairo`.
- `crates/paged-mutate/tests/it/pattern_swatch.rs`: create, edit and delete with exact inverses;
  the refusals; a pattern on every painted kind with its own transform; the JSON spelling scripts
  write.
- `crates/paged-canvas/tests/it/pattern_paint.rs`: listed, applied and undone a step at a time;
  kept by `.paged`; on IDML export carried in the label with a stand-in, restored by the import to
  the same page, with the loss lines (used and unused).
- `crates/paged-store/tests/it/pattern_paint.rs`: the native round trip; no key without a
  pattern.
- The Illustrator oracle: `modules/draw/tooling/oracle/illustrator/probes/pattern-render.jsx` opens the
  engine's PDFs of four patterns (`paged-export-pdf/tests/fixtures/pattern-oracle/`: a grid turned
  20°, a brick-by-row lattice, an overlapping hex-by-column lattice, a brick-by-column stroke) in
  Illustrator 30.1, exports its rendering at 1 px = 1 pt and saves its own PDF. Recorded
  2026-10-29 and replayed by `the_engine_draws_a_pattern_as_illustrator_does__feat__…`:
  Illustrator reads each as ONE pattern swatch, painted on the frame's path as a pattern fill (the
  stroke case as a pattern stroke), and writes it back as a tiling pattern. Over a 3-px lattice
  inside the frame the upright brick and the overlapping hex lattices agree on every pixel —
  cells, offsets and the overlap order — and the turned grid and the stroke differ by more than 40
  levels on 4.5 % and 3.0 % of the lattice, all on edges (two antialiasers' partial pixels; the
  tolerance is 5 %). Illustrator's scripting cannot build a pattern swatch from artwork (Make
  Pattern enters a mode whose Pattern Options panel has no script door), so the oracle holds the
  engine's PDF semantics and rendering to Illustrator's, not Illustrator's own Pattern Options
  arithmetic.

All tests named `*__feat__color_swatches_pattern_paint` are the evidence of the feature row
`color-swatches.pattern-paint`.

## Consequences

- A pattern swatch fills and strokes any frame, drawn alike on both canvas lanes, written
  natively to PDF, kept by `.paged`, and carried through IDML in a label.
- The first draw of a pattern at a new zoom bucket costs one rasterisation of its period; later
  draws cost an image fill. A very small period under a deep zoom-out aliases (no mipmaps).
- Text in a frame keeps its colour paints: a character's fill naming a pattern falls back as an
  unknown swatch does.
- An anchored (inline) frame has no pattern transform: the anchored-object model carries none.
- paged.draw's Pattern Options produce the swatch (draw ADR 365); its tile field stays as pattern
  artwork.
