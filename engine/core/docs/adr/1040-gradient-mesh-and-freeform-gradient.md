# ADR 1040 — Gradient meshes and freeform gradients are native fills, drawn as a cached raster

- **Status:** Accepted 2026-10-29.
- **Scope:** protocol v76 (additive; no bump). `paged-model` (`mesh.rs`: `MeshFill`,
  `GradientMesh`, `MeshGrid`, `MeshNode`, `MeshColor`, `FreeformGradient`, `FreeformPoint`,
  `PatchInput`, `path_is_plain_box`; the `fill_mesh` field of `TextFrame`, `Rectangle`, `Oval` and
  `Polygon`); `paged-compose` (`mesh.rs`: `MeshShading`, the mesh pool, the rasteriser and its
  cache; `DisplayCommand::MeshShade`); `paged-renderer` (`module/mesh_fill.rs`); `paged-gpu`
  (`vello_map::mesh_image`, both lanes); `paged-export-pdf` (`color::write_mesh_shading`,
  `page.rs`); `paged-mutate` (`PropertyPath::FrameFillMesh`, `Value::FillMesh`, `MeshFillSpec` and
  its parts; a box move carries the mesh); `paged-introspect` (the `frameFillMesh` row);
  `paged-canvas` (the property reads, `mesh_fill_export.rs`); `idml-import` (the label restore).
  Gaps D-19, D-20; work package WP7.2.

## Context

Illustrator has two paints a swatch cannot hold. A **gradient mesh** is a grid of patches whose
corners carry colours, the colour flowing across each patch along curved edges; it is what PDF
calls a Coons-patch (type 6) or tensor-product-patch (type 7) shading, and what Illustrator writes
into a PDF. A **freeform gradient** places colour points (and lines through points) anywhere on an
object and blends between them. Both are per object — their points sit on the object — and both are
painted all over vector art, slide decks and imported PDFs. ADR 1007 (paint model v2) left them to
this decision.

Neither rasteriser has such a paint. Vello and `vello_cpu` draw solid colours, three gradient
kinds and images; a patch surface or a scattered-point blend would need a new shader written twice
(WGSL and the CPU pipeline). PDF has the mesh natively and no freeform at all. IDML has neither.

## Decision

**The model: a native fill on the frame.** `fill_mesh: Option<Box<MeshFill>>` on the four fillable
kinds; `MeshFill` is `Mesh(GradientMesh)` or `Freeform(FreeformGradient)`, its points in the
frame's inner coordinates, its colours inline (`MeshColor`: `space` + `value` as a `ColorEntry`
has them, plus `opacity_pct`). While set it paints instead of the frame's fill swatch, which stays
(it is what IDML and InDesign show). A swatch was considered and rejected: mesh points belong to
one object, and Illustrator has no mesh swatch either.

- A `GradientMesh` is one or more `MeshGrid`s. A grid of `rows × cols` patches has
  `(rows + 1) × (cols + 1)` nodes, row-major; a node has a position, a colour and four handles —
  the inner control points of the edges that leave it towards the previous column, the next
  column, the previous row and the next row. A patch is the Coons patch of its four edges, or a
  tensor patch when the grid carries its four interior points (`tensor`, what a type-7 shading
  reads as). Several grids exist only for imported shadings whose patches tile no single grid:
  `GradientMesh::from_patches` rebuilds ONE editable grid when the patches share their edges and
  corner colours (as a writer's row-by-row mesh does), else keeps one one-patch grid per patch.
- A `FreeformGradient` is points (position, colour, `spread_pct`: how far the colour holds, in
  percent of the box diagonal) and lines, each through two or more of the points in order.

`.paged` and the state hash: `fill_mesh` is `serde(default)` and skipped when absent, so a document
without one writes the bytes it did and keeps its hash (ADR 195).

**The display list: one pool, one command.** The renderer resolves the colours through the
document's colour pipeline (an inline colour reads as an unnamed swatch would, as ADR 1007's stops
do; opacity rides on the colour's alpha), and emits

```
PushClip(frame outline) · MeshShade { mesh_id, bounds, transform } · PopClip
```

under the frame's outer transform. `DisplayList::meshes` holds `MeshShading`s: the patches (sixteen
control points and four corner colours each), or the freeform sources (points, and each line's
points). Each carries an FNV-1a hash of its content, which the digest (ADR 101) includes. The
frame's fill transparency, effects and blend groups bracket the three commands as they bracket a
fill; overprint does not apply to a mesh.

**Rendering: rasterised at display resolution, cached, sampled by both lanes.**
`paged_compose::mesh::mesh_raster(mesh, px_per_unit)` rasterises the shading in its local space at
the display scale (the largest stretch of the command's transform times the back end's page-to-pixel
transform), rounded up to a quarter-octave bucket, and caches the straight-alpha RGBA8 raster
process-wide, keyed by `(content hash, bucket)` (96 MiB, least recently used first). Both
rasterisers draw the same raster as an image under the clip — the GPU lane through a Vello image
brush, the CPU lane as a `vello_cpu` pixmap, each keeping the last eight as their own image objects
so a redraw uploads nothing. GPU/CPU parity (ADR 146) follows: the lanes receive the same pixels,
as they receive a placed picture. A raster is capped at 4096 px a side and 8 Mpx (the scale halves
until it fits); a mesh enlarged past that is drawn softer, not refused.

- *Patches* are subdivided into quads about two pixels across and drawn as Gouraud triangles in
  patch order, later over earlier, so where a patch folds the larger parameter shows, as PDF
  paints it. A colour blends bilinearly over the patch's parameters in sRGB-encoded values with the
  alpha apart (the unpremultiplied ramp of ADR 1007, and how a PDF viewer blends a shading's
  DeviceRGB components). Pixels are sampled at their centres; a one-pixel margin around the
  covered area takes its covered neighbours' colour ("bleed"), so the frame's antialiased edge,
  drawn by the clip, does not fade into transparency, and a pinhole between two patches closes.
- *A freeform gradient* is a smooth field: each source holds its colour out to its spread; past
  it, the sources blend by inverse squared distance from the spread's edge (Shepard, `p = 2`) — flat
  at every source, smooth between them, the mean of all far from every one. A line's source at a
  point is the nearest place on the uniform Catmull-Rom curve through its points, its colour and
  spread blended along the curve by arc length. Points on a line colour through the line only.
  The field is evaluated per pixel, or every second or fourth pixel with bilinear in between once
  the raster passes 512² or 1024² pixels.

**PDF: native shadings.** A mesh is a type-6 (Coons) shading, or type 7 (tensor) when any patch
has its own interior points, in DeviceRGB, painted with `sh` in its local space under the frame's
clip: 32-bit coordinates over the patches' box, 16-bit components, an 8-bit flag (every patch
free). **A freeform gradient is a type-6 approximation**, not an embedded raster: a 32 × 32 grid of
straight-edged patches over the frame's box whose corners are the same field sampled at the grid's
nodes, so it stays vector and resolution-independent; between nodes PDF blends bilinearly, which
departs from the field by at most a few levels where a source's plateau meets the blend (measured:
≤ 12 of 255 against poppler on the test's three-point gradient). Translucent colours paint under a
luminosity soft mask of the same patches' alpha in DeviceGray, set in page space as ADR 1007's
ramps are.

**IDML: a reported loss, kept in a label.** IDML says neither paint. The export moves each frame's
fill into the frame's label (`paged:fillMesh`, the model's JSON) and leaves the swatch, so InDesign
shows the swatch and keeps the label through an open and a save; the IDML import restores
`fill_mesh` from the label and drops the entry, so a paged round trip through IDML is lossless. The
loss report names every such frame, and checks against the re-imported twin that the label made the
trip (a different line when it did not).

**SVG.** `paged-svg` (the shared SVG writer and reader, PM-0014) is not on this decision's base;
its raster fallback with a loss line — SVG 2 dropped `meshgradient`, so a mesh exports as an
`<image>` of `mesh_raster` clipped to the outline — follows when the two meet. The rasteriser is
public for it.

**The wire.** `PropertyPath::FrameFillMesh` (`frame.fillMesh`, catalog `frameFillMesh`), whole
value `Value::FillMesh(Option<MeshFillSpec>)`; `MeshFillSpec` is `{ kind: "mesh", grids }` or
`{ kind: "freeform", points, lines }` with camelCase fields, colours as `{ space, value,
opacityPct? }`. Validated on apply: a grid's node count, a tensor list of one entry per patch, a
line through points that exist, a known space with its channel count, finite numbers; an opacity is
clamped to 0..=100 and 100 is stored as absent, a spread likewise and 0 as absent. The inverse is
the fill it replaced, so the Mesh tool's every gesture — add a point, move a point or a handle,
colour points — is one write and one undo step. Additive: a new path and a new value variant, no
new mutation kind, so the protocol stays at 76 (governance rule 1). Scripts write the wire form
(`{ type: "fillMesh", value: { kind: "freeform", … } }`); the introspection layer's JSON reader
also takes the spec object alone.

**A box move carries the mesh.** The translate gesture and the resize handles commit
`FrameBounds` for a frame drawn from its box (`path_is_plain_box`, now the one definition the
renderer and the mutation layer share). Such a write maps the mesh from the old box to the new one,
as Illustrator's mesh follows its object; its inverse is a batch restoring the bounds and then the
mesh as it was, so undo is exact (ADR 197). A frame drawn from its path moves by its item transform,
which the mesh follows by construction.

## Evidence

- `crates/paged-compose/src/mesh.rs`: the bilinear blend in encoded values, opacity apart from
  colour, a curved edge bending the surface, the freeform plateau and blend, a line's colour along
  its curve, the type-6 lowering sampling the same field, the cache handing back one raster per
  bucket, the size cap.
- `crates/paged-model/src/mesh.rs`: a box grid's Coons interior, the JSON round trip, a malformed
  grid painting nothing, patches that tile a grid coming back as that grid (shuffled, and with
  tensor points), patches that do not staying apart.
- `crates/paged-renderer/tests/it/mesh_fill.rs`: corner colours and the centre blend, the clip to an
  oval, a translucent node showing the page, a freeform gradient holding each point's colour, a
  frame without a mesh (or with an empty one) keeping its swatch and digest; with the `gpu` feature,
  a mesh and a freeform gradient on both lanes at two resolutions.
- `crates/paged-gpu/src/vello_rs.rs`: `mesh_shades_alike_on_both_lanes__feat__…` — a curved
  translucent patch and a freeform gradient under a clip, upright and turned, at 72 and 144 dpi,
  per pixel on Metal and `vello_cpu`.
- `crates/paged-export-pdf/tests/it/mesh_fill.rs`: type 6 with its decode array and no mask for an
  opaque mesh; type 7 for tensor patches, held by poppler to the engine's own raster of the same
  patch; the alpha mask for a translucent mesh; the freeform grid against the exact field; no patch
  shading for a frame without a mesh.
- `crates/paged-mutate/tests/it/mesh_fill.rs`: set and inverse on every fillable kind, the clamps,
  the refusals (a line, a malformed spec, a wrong value type), the spec's round trip, and a box
  move carrying the mesh with a bit-exact undo.
- `crates/paged-canvas/tests/it/mesh_fill.rs`: read back and undone in one step through the canvas,
  refused when malformed, kept by `.paged`, and on IDML export carried in the label, restored by
  the import, with the loss line.
- `crates/paged-store/tests/it/mesh_fill.rs`: the native model round trip; no key without a mesh.
- The Illustrator oracle. Illustrator's scripting cannot build a mesh or a freeform gradient
  (`MeshItem` has no constructor; the menu commands open dialogs; the DOM has no freeform type), so
  `modules/draw/scripts/illustrator/probes/mesh-render.jsx` opens the engine's own PDFs of three
  meshes (`paged-export-pdf/tests/fixtures/mesh-oracle/`: a bilinear four-corner patch, a 2 × 2
  grid with a moved node and bent edges, a tensor patch) in Illustrator 30.1, exports its rendering
  at 1 px = 1 pt and saves its own PDF. Recorded 2026-10-29 and replayed by
  `the_engine_draws_a_mesh_as_illustrator_does__feat__…`: over a 13 × 13 lattice the engine's
  raster differs from Illustrator's by at most 4 levels (curved grid), 2 (tensor) and 8 (bilinear
  patch, near a corner: Illustrator Gouraud-shades a coarser tessellation — at (123, 73) the exact
  bilinear value is 202, the engine and poppler draw 202, Illustrator 210; a convention, the
  tolerance is 8). Illustrator writes the meshes back as shading types 6, 6 and 7 — the types the
  engine writes. It opens such a shading as a shading inside its clip, not as a `MeshItem`.
  **The freeform field is not oracled:** with no way to create a freeform gradient by script, its
  Shepard falloff is a stated model, calibrated against nothing but itself; recording it needs a
  hand-made Illustrator sample (a follow-up).

All tests named `*__feat__color_swatches_mesh_freeform_gradients` are the evidence of the feature
row `color-swatches.mesh-freeform-gradients`.

## Consequences

- A frame can hold a gradient mesh or a freeform gradient, drawn alike on both canvas lanes,
  written natively to PDF, kept by `.paged`, and carried through IDML in a label.
- The first raster of a large mesh at a new zoom bucket costs a rasterisation; later frames at the
  same bucket cost an image draw.
- An anchored (inline) frame has no mesh: the anchored-object model carries no fill mesh.
- Editing a grid in the Mesh tool turns its tensor patches into Coons patches.
- PDF import (publish ADR 658) samples shading types 4–7 to images; its reader is not on this
  decision's base. `GradientMesh::from_patches` is the mapping its type-6/7 branch calls when the
  two meet.
