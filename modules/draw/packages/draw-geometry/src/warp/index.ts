/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// THE WARP KERNELS — the vector half of the master plan's `paged-warp`
// crate, written here first (zero-dependency TypeScript) so the draw
// tools can ship before the crate exists. Every function is PURE over
// points: plain `[x, y]` tuples and anchor tables in, new ones out, no
// host types, no randomness (the "random" kernels hash a stable id and a
// seed), no globals. That is the porting contract: each module below maps
// one-for-one to a Rust module, with the same names in snake_case, and
// the specs in `test/warp/` are the cross-implementation fixtures.
//
//   liquify.ts           brush field + densify / step / refit
//     liquifyStart(table) → state; liquifyStep(state, brush, params,
//     detail) → state; liquifyRefit(state, tolerance) → table.
//     liquifyDisplace(brush, params, p) is the point map of the four
//     smooth kernels (the pixel half samples its inverse).
//   triangulate.ts       constrained Delaunay mesh of outline rings
//     triangulateRings(rings, { spacing, inside?, maxVertices? }) → mesh;
//     locateInMesh(mesh, p) → { triangle, weights }.
//   arap.ts              Igarashi 2005 two-step as-rigid-as-possible
//     new ArapSolver(mesh, pins).solve(targets, angles?) → vertices;
//     mapLocated(triangles, deformed, located) → point; autoPins(mesh).
//   homography.ts        3 × 3 projective maps
//     homographyFromQuads(from, to); applyHomography(h, p);
//     invertHomography(h); composeHomography(a, b);
//     mapTableProjective(table, h, tolerance) — subdividing curves.
//   perspective-grid.ts  1/2/3-point grids, plane homographies, handles
//     planeHomography(grid, plane); pageToPlane / planeToPage;
//     attachToPlane / moveOnPlane / projectOntoPlane; gridHandles /
//     moveGridHandle; planeGridLines / planeQuad.
//
// Units are page pt (y down) throughout; angles are radians in arap.ts
// and degrees where they mirror an Illustrator option (the liquify
// brush's angle, the twirl rate).

export * from "./liquify";
export * from "./triangulate";
export * from "./arap";
export * from "./homography";
export * from "./perspective-grid";
