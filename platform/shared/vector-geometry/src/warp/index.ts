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

// THE WARP KERNELS of the vector tools that stay in TypeScript: the
// projective maps and the perspective grid. Every function is PURE over
// points: plain `[x, y]` tuples and anchor tables in, new ones out.
//
// Puppet Warp's mesh and solve and the Liquify brushes are the engine's
// `paged-warp` crate (one implementation for vectors and pixels); the
// vector tools reach them through the injected `WarpKernel` of
// `@paged-media/vector-tools`.
//
//   homography.ts        3 × 3 projective maps
//     homographyFromQuads(from, to); applyHomography(h, p);
//     invertHomography(h); composeHomography(a, b);
//     mapTableProjective(table, h, tolerance) — subdividing curves.
//     Held to `paged_warp::from_quads` by a parity test.
//   perspective-grid.ts  1/2/3-point grids, plane homographies, handles
//     planeHomography(grid, plane); pageToPlane / planeToPage;
//     attachToPlane / moveOnPlane / projectOntoPlane; gridHandles /
//     moveGridHandle; planeGridLines / planeQuad.
//
// Units are page pt (y down) throughout.

export * from "./homography";
export * from "./perspective-grid";
