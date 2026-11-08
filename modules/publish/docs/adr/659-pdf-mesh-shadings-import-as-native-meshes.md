# ADR 659 — PDF mesh shadings (types 4–7) import as the engine's native gradient mesh

- **Status:** Accepted 2026-11-01.
- **Scope:** `crates/pdf-import` (`vectors/paint.rs`: `mesh`, `MAX_MESH_PATCHES`;
  `vectors/ir.rs`: `Paint::Mesh`, `MeshPatchIr`; `lower.rs`: the mesh fill; `snippet.rs`:
  `Counts::meshes`); `packages/pdf-bundle` (`src/vectors/ir.ts`, `src/vectors/losses.ts`, the
  German catalogue). Amends [ADR 658](658-a-pdf-page-places-as-native-vectors.md), which sampled
  every shading but the axial and radial ones to an image. Engine side: core ADR 1048 (the
  gradient mesh), whose `GradientMesh::from_patches` this calls; the engine does not change.
  Plan WP10.6.

## Context

ADR 658's page reader turned a PDF's mesh shadings — free-form and lattice triangle meshes
(types 4, 5), Coons-patch meshes (6) and tensor-product-patch meshes (7) — into an image sampled
at 150 ppi and reported `shading.mesh_sampled`. A gradient mesh made in Illustrator, which it
writes as a type-6 or type-7 shading, came back as a picture: not editable, soft when enlarged,
and heavy.

Engine ADR 1048 has since given every fillable frame a native gradient mesh (`fill_mesh`): grids
of Coons patches, or tensor patches when a grid carries its interior points, drawn on both canvas
lanes and written back to PDF as types 6 and 7. It left the PDF import's branch to this decision,
with `GradientMesh::from_patches` as its entry: free patches in, one editable grid out when they
tile one, else one one-patch grid per patch.

## Decision

1. **Types 6 and 7 map patch for patch.** hayro hands a patch mesh over with every patch whole
   (its shared-edge flags already resolved) and its control points in the stream's order. The
   reader places them in the model's layout (`points[i][j]`: the PDF's first edge
   `p00 … p03` is row 0, the twelve edge points `p00 p01 p02 p03 p13 p23 p33 p32 p31 p30 p20
   p10`, then a tensor patch's `p11 p12 p22 p21`) — the order the engine's export writes, so a
   mesh the engine wrote reads back as the patches it had — maps them through the pattern's
   matrix into page space, and reads the corner colours `c00 c03 c33 c30` as `[c00, c03, c30,
   c33]`. A Coons patch's interior comes from its edges; a type-7 patch keeps its own.
2. **Types 4 and 5 map too, exactly.** A triangle `a b c` becomes a Coons patch whose rows run
   from the edge `a → b` to the point `c`, every edge straight: its surface is the bilinear patch
   of the corners `a b c c`, whose weights at any point are that point's barycentric
   coordinates, and its colours blend with the same weights — the triangle's Gouraud shading
   (ISO 32000-1, 8.7.4.5.5), not an approximation. A lattice reaches the reader as its
   triangles. A triangle mesh tiles no grid, so it lands as one one-patch grid per triangle.
3. **The lowering gives the polygon its mesh.** The path the shading fills (an `sh` under a clip
   is tidied into the clip's outline, as ADR 658 does for ramps) becomes a `Polygon` whose
   `fill_mesh` is `GradientMesh::from_patches` of the patches under the placement transform; the
   polygon's transform is the identity, so its inner coordinates are the placement's space, and
   a patch's control points map affinely: exact under any placement. The fill swatch stays
   (engine ADR 1048: it is what IDML shows) as the mean of the corner colours. The paint's
   constant alpha is the fill's transparency, as for a ramp. A paste (`pasteElements`) moves the
   polygon by its item transform, which the mesh follows.
4. **Colours arrive as sRGB**, as every colour of the reader does: hayro converts the shading's
   space (CMYK, Lab, ICC, spot) per corner, and the mesh blends the converted corners where the
   PDF blends in its own space. A shading with a colour function (`/Function`, each corner a
   parameter `t`) maps each corner through it; the PDF blends `t` and maps the blend, so the
   mapping checks each patch's edge midpoints and centre against the blend of its mapped corners
   and reports a curve that departs from it by more than 2.5 of 255 levels.
5. **What is still reported.** `shading.mesh_function` (that curve), `shading.mesh_background`
   (a `/Background`: the mesh paints only its patches), `shading.mesh_patches` (the patches tile
   no single grid in one orientation: painted the same, editable patch by patch — every triangle
   mesh, and a patch mesh whose continuation flags turn the next patch, hayro handing it over in
   the PDF's orientation), `shading.mesh_too_large` (more than `MAX_MESH_PATCHES` = 4096
   patches or triangles: sampled as before; each would be a grid of its own in the document), and
   `shading.mesh_sampled` (a mesh whose colours or points cannot be read). The bundle words each
   code, in English and German.

## Evidence

`crates/pdf-import/tests/mesh_shadings.rs` (`*__feat__plugin_pdf_import_transparency`):

- **The round trip, native mesh → PDF → import → native mesh.** The engine's PDF export of three
  meshes (its Illustrator oracle's inputs, `engine/core/crates/paged-export-pdf/tests/fixtures/
  mesh-oracle/*.pdf`: a bilinear four-corner patch, a 2 × 2 grid with a moved centre node and
  bent edges, a tensor patch) places back as the meshes they were exported from — the same grid
  shape, every node, edge handle and tensor point within 0.001 pt, every colour within 0.05 of
  255 — with no loss line. The test keeps the source meshes as that crate's `oracle_cases`
  defines them.
- **Illustrator's own PDFs.** Illustrator 30.1 opened those PDFs and saved its own (recorded
  2026-10-29 by `modules/draw/tooling/oracle/illustrator/probes/mesh-render.jsx`): its shadings — in
  its own coordinate system, under its own clip — read back as the same meshes within 0.01 pt.
  Illustrator's scripting cannot create a mesh (engine ADR 1048), so these re-saved meshes are
  the real-world Illustrator-written fixtures; no new probe was recorded.
- One construct per test on PDFs the tests write: a Coons patch through `sh` (corners, the bent
  edge, the colour order), placed at twice the size and moved (the frame's mesh and swatch), a
  pattern fill through its matrix, two patches sharing an edge tiling one 1 × 2 grid, a
  flag-1 continuation (its edge and colours carried over, kept as two patches and reported), a
  tensor patch's interior, a type-4 mesh whose every patch point paints the triangle's Gouraud
  colour, a type-5 lattice as its four triangles, a linear colour function (silent) and a
  curved one (reported), fill alpha and a background, and the patch cap.

## Consequences

- A gradient mesh made in Illustrator and saved as PDF or as an `.ai` with PDF content opens
  and places as an editable mesh (the Mesh tool works on a mesh that is one grid), and exports
  back to PDF as the same shading type; a triangle mesh exports as type 6.
- A triangle mesh paints exactly but is edited triangle by triangle; rebuilding a lattice's
  quads into one grid would change its colours (a quad's bilinear blend is not its two
  triangles' Gouraud blend), so it is not done.
- Patches a writer chains with continuation flags in turning directions are kept apart. A pass
  that turns each patch (its net and corner colours rotated or mirrored, the same surface) to
  match its neighbour before tiling would make them one grid; it belongs beside
  `GradientMesh::from_patches` in the engine and is a follow-up.
- Engine ADR 1048's closing line ("PDF import samples shading types 4–7 to images; its reader is
  not on this decision's base") is superseded by this record.
