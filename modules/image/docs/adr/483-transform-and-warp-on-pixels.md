# ADR 483 — Warps on pixels are backward maps from `paged-warp`, sampled by three kernels

- **Status:** Accepted, 2026-10-30 (WP5.6; closes I-36's image half with WP4.1, I-37's distort,
  I-38 and I-39's non-ML parts, I-41's Perspective Crop). Amends ADR 467 (the CPU resample gains
  any backward map and seam carving) and extends ADR 474 (`geom.warp_mesh` now also bends pixel
  layers).
- **Scope:** `paged-warp`'s `field` (displacement fields and the Liquify brushes) and `puppet`
  (the as-rigid-as-possible mesh) modules; `paged-resample`'s `warp_map_rgba8` and
  `seam_carve_rgba8`; the `geom.warp_field` kernel (`image-kernels` `families/warp.rs`, its
  registry row and its parity); `image-js`'s `warps.rs`, `wasm/warps.rs` and the
  `CanvasOp::Perspective` canvas op; the bundle's `warp-engine.ts`, `filters-warp.ts`,
  `warp-canvas.ts`, `perspective-crop-tool.ts`, Edit ▸ Transform ▸ Free distort / Perspective /
  Warp…, Edit ▸ Puppet warp…, Edit ▸ Content-aware scale…, Image ▸ Filter ▸ Liquify…, the
  Perspective Crop tool and Image ▸ Apply perspective crop; the Photoshop probe
  `transform-warps.jsx`.

## Context

Free Transform of a layer or a selection shipped with WP4.1 (`host.transformBox`, the
`geom.warp_projective` kernel; editor ADR 295, extensions ADR 339), with the box's Free Distort
and Perspective modes reachable only by modifier keys. `geom.warp_mesh` bent type layers
(ADR 474). Nothing bent a pixel layer through a mesh, there was no Liquify, Puppet Warp,
Content-Aware Scale or Perspective Crop, and draw's Liquify and Puppet Warp (draw ADR 363)
move path anchors in TypeScript, which the pixel lane cannot use.

## Decision

**Every warp is a BACKWARD map, defined once in `paged-warp`.** An output pixel asks where in the
source it reads; the three kinds of map are a homography (`from_quads`, `invert`), a bicubic
Bézier patch (`envelope`, inverted per pixel by Newton) and a DISPLACEMENT FIELD (`field::Field`:
a displacement per grid node, bilinear between nodes, NaN for "no source"). Each has one GPU
kernel — `geom.warp_projective`, `geom.warp_mesh`, and the new `geom.warp_field` — and one CPU
twin in `paged-resample`: `warp_projective_rgba8`, and `warp_map_rgba8`, which samples any
closure the same way (the projective warp is now that sampler through the homography, bit for
bit). The CPU twins are the supported headless lane (ADR 467) and what the Photoshop replay runs.

**`geom.warp_field` carries its field in `in0`.** The frozen ABI v1.1 gives a Resample kernel one
input, so the nodes travel in the same rgba16float window as the source — below it, or beside it
when the GPU's texture limit says so (`WarpFieldParams::layout`) — each as an exact f16 integer
part and an f16 fraction (one half would round a 1000 px displacement to half a pixel). With a
selection the result lands through it, as a filter does. Parity: Liquify and Puppet Warp fields
within `ChannelEpsF16(4)` on Metal; the CPU twin within 2 levels of the scalar reference.

**Liquify is a replayed list of strokes.** A stroke is a tool (Forward Warp, Reconstruct, Smooth,
Twirl clockwise and counter-clockwise, Pucker, Bloat, Push Left, Freeze and Thaw mask), a brush
(size, pressure, density, rate) and a polyline. `field::Liquify` places dabs along it and each dab
rewrites the field by one rule derived from the backward map (`D'(q) = D(m(q)) + m(q) − q` for
the map the tool wants); the freeze mask scales every other tool. The dialog stores the strokes
normalised to the image, so the proxy preview, the full pass and Cancel need no state beyond the
values: every pass replays them on a fresh mesh of at most 512 nodes a side.

**Puppet Warp is ARAP on a grid mesh.** `PuppetMesh::from_alpha` keeps the cells of a grid
within the expansion of what the layer covers; `puppet::solve` is Sorkine and Alexa's
local/global iteration in the plane (cotangent weights, Jacobi-preconditioned CG), the local step
fitting a rotation (Rigid), a rotation and scale (Normal) or any linear map (Distort); pins hold
their nearest vertices, a part without a pin stays. `backward_field` rasterises the bent
triangles into a dense field. draw's TypeScript solver (Igarashi's two-step) stays draw's: the
pixel lane needs the solve beside its raster, in Rust, and the two meet in `paged-warp` when draw
moves its geometry there (C8).

**Content-Aware Scale is seam carving on the CPU**, forward energy over the premultiplied
luminance, a protect mask (the selection) priced out of the seams; Amount takes its share of the
change by an ordinary Lanczos resize first. A seam depends on the last one, so it is CPU work of
the PatchMatch search's class (ADR 469).

**The warps are Filter-dialog entries** (`FilterDef.transform`): each gets the dialog's live
preview, OK as one undo step and Cancel, and never becomes a smart filter. Their geometry is
drawn on the canvas and edited there through the canvas capture every image tool already has
(`warp-canvas.ts`, the Blur Gallery's pattern): Warp's sixteen control points (a drag makes the
warp Custom), Puppet Warp's pins (a new pin holds its rest point, read back through the bent
field), Liquify's strokes. Warp bends the selection's bounds or what the layer covers, and with
a selection only its pixels float.

**The Perspective Crop is a canvas op** (`CanvasOp::Perspective`): every layer, mask and channel
drawn upright through the quad's homography with `geom.warp_projective` (bicubic), paths, guides
and smart placements mapped by the same homography, one undo step; the size is the mean of the
quad's opposite sides. **Free Distort and Perspective** open the existing box in that mode.

## Photoshop

`transform-warps.jsx` records the fifteen Warp styles at +50 % on a full-layer square and
Content-Aware Scale at 75 % width (with a plain scale beside it). Findings: the Transform event
takes the warp only under the STRING id `warp` (the char id is accepted and ignored); it ignores
every corner form tried for Distort and Perspective, so those are not recorded and the homography
is held to the maths. Content-Aware Scale agrees on what it keeps (both cover the same 96 columns
from x = 16) and both differ from a plain scale; the seams are each app's own. The styles are a
recorded CONVENTION with large distances: Photoshop bends a square by amounts that follow its
width, where `paged-warp`'s closed forms (fitted to Warp Text's wide boxes) bend less or fan out.
Directions agree for every style.

## Open

- Refit `paged-warp`'s fifteen styles to the square recordings (and the Warp Text ones) — the
  pixel and the type lane move together.
- Lens Correction, Adaptive Wide Angle, Vanishing Point and Perspective Warp (the quad-plane
  warp) are not done. Liquify's face-aware tools need ML landmarks (WP8.2).
- Puppet Warp's pin depth, pin rotation and the outline-following mesh; Liquify's mask from the
  selection and its stored mesh (.msh); Content-Aware Scale's Protect Skin Tones and its
  interactive box.
- Warp, Puppet Warp and Content-Aware Scale on a smart object (Photoshop keeps them live) are
  refused by the layer edit as every pixel edit of a smart object is.
