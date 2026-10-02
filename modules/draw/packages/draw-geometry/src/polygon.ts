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

// Point-in-polygon (wave 2) — the lasso-select region test. Pure,
// zero-dep.
//
// B-22 adds `pointInAnchorPath`: the same even-odd rule over a CUBIC
// anchor path with contours (the engine's planar-face outline shape).
// It is what lets the Shape Builder resolve "which face is under the
// cursor" LOCALLY from a cached arrangement instead of asking the
// engine on every pointermove.
//
// `flattenAnchorPath` + `pointInFlatPath` are that same test split in
// two, for a caller that asks many points of the same path: flatten each
// outline ONCE, then test — and reject a point outside the outline's box
// without walking a single edge.

import { flattenAnchorRun } from "./bezier";
import type { AnchorTriple, Vec2 } from "./types";

/**
 * Even-odd (ray-casting) point-in-polygon over a simple polygon given
 * as its vertex ring (implicitly closed — no need to repeat the first
 * vertex). Fewer than 3 vertices answers `false`. Points EXACTLY on
 * an edge are boundary cases the crossing rule decides one way or the
 * other — the lasso's centers-inside semantics don't need a stable
 * boundary answer, and none is promised.
 */
export function pointInPolygon(point: Vec2, polygon: readonly Vec2[]): boolean {
  const n = polygon.length;
  if (n < 3) return false;
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const crosses = yi > py !== yj > py;
    if (crosses && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * A cubic anchor path FLATTENED ONCE, for testing many points against
 * it — what a region tool holds per cached face. Build it with
 * {@link flattenAnchorPath}, test with {@link pointInFlatPath}.
 *
 * `pointInAnchorPath` flattens on every call. That is right for one
 * question and wrong for a hover: a tool resolving the face under the
 * pointer asks the SAME 256 outlines on every move, and re-sampled every
 * curve of every one of them each time.
 */
export interface FlatAnchorPath {
  /** One closed ring per contour — the exact points
   *  `flattenAnchorRun({ close: true })` produced for it. */
  readonly rings: readonly (readonly Vec2[])[];
  /** The box around every ring vertex. An empty path has
   *  `minX > maxX`, which no point is inside. */
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** The contours of an anchor table, each flattened to its closed ring.
 *  An empty `subpathStarts` means the single-contour case. */
function flattenContours(
  anchors: readonly AnchorTriple[],
  subpathStarts: readonly number[],
  options?: { samplesPerSegment?: number },
): Vec2[][] {
  const starts = subpathStarts.length > 0 ? subpathStarts : [0];
  const rings: Vec2[][] = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s];
    const to = s + 1 < starts.length ? starts[s + 1] : anchors.length;
    rings.push(
      flattenAnchorRun(anchors.slice(from, to), {
        close: true,
        samplesPerSegment: options?.samplesPerSegment,
      }),
    );
  }
  return rings;
}

/** Even-odd over a set of rings: every edge of every ring feeds ONE
 *  crossing count. A ring's own parity is `pointInPolygon` — a ring of
 *  fewer than three points has no edge that can be crossed an odd number
 *  of times, which is exactly what that function's guard answers. */
function insideRings(point: Vec2, rings: readonly (readonly Vec2[])[]): boolean {
  let inside = false;
  for (const ring of rings) {
    if (pointInPolygon(point, ring)) inside = !inside;
  }
  return inside;
}

/** Flatten `anchors` (contours per `subpathStarts`, the
 *  `pointInAnchorPath` conventions) into rings plus their bounding box. */
export function flattenAnchorPath(
  anchors: readonly AnchorTriple[],
  subpathStarts: readonly number[] = [],
  options?: { samplesPerSegment?: number },
): FlatAnchorPath {
  const rings = flattenContours(anchors, subpathStarts, options);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { rings, minX, minY, maxX, maxY };
}

/** How far outside the box, in x, a point must be before the box alone
 *  answers — relative to the box's own magnitude. See below. */
const X_MARGIN = 1e-9;

/**
 * Even-odd point-in-path over a {@link FlatAnchorPath}: the SAME rings
 * and the same crossing count `pointInAnchorPath` runs, behind a
 * bounding-box test.
 *
 * THE BOX CHANGES NO ANSWER, and each half is safe for a different
 * reason:
 *   · in Y it is exact. An edge is counted only when its ends lie on
 *     opposite sides of the point's y; above or below every vertex no
 *     edge qualifies, by comparison alone.
 *   · in X the crossing is COMPUTED (`x` where the edge meets the ray),
 *     and a computed x can land an ulp outside the edge's own ends. So
 *     the box only answers once the point is clear of it by a margin
 *     that dwarfs that rounding; inside the margin the crossings are
 *     counted as before. Left of everything, every qualifying edge is
 *     crossed and a closed ring has an even number of them; right of
 *     everything, none is.
 */
export function pointInFlatPath(point: Vec2, path: FlatAnchorPath): boolean {
  const px = point[0];
  const py = point[1];
  if (py < path.minY || py > path.maxY) return false;
  const margin =
    X_MARGIN * Math.max(1, Math.abs(path.minX), Math.abs(path.maxX));
  if (px < path.minX - margin || px > path.maxX + margin) return false;
  return insideRings(point, path.rings);
}

/**
 * Even-odd point-in-path over a CUBIC anchor table with contours — the
 * shape a planar FACE comes back in (`anchors` + `subpathStarts`, holes
 * carried as extra contours).
 *
 * Each contour is flattened with `flattenAnchorRun({ close: true })`
 * and every edge of every contour contributes to ONE crossing count, so
 * a point inside a hole answers `false` — the even-odd rule the face
 * was built under. An empty `subpathStarts` means the single-contour
 * case (the wire's convention).
 *
 * `samplesPerSegment` trades accuracy for cost; the default matches the
 * preview flattener. Straight segments emit no intermediate samples, so
 * a rectangle face costs four edges regardless.
 *
 * ONE QUESTION, ONE FLATTEN: this flattens the path on every call. To
 * ask many points of the same path, flatten it once
 * ({@link flattenAnchorPath}) and ask {@link pointInFlatPath}.
 *
 * NO GUARD ON THE ANCHOR COUNT, and that is deliberate. This used to
 * return `false` for a contour of fewer than three anchors —
 * `pointInPolygon`'s "fewer than 3 VERTICES" rule carried over to
 * ANCHORS, where it is wrong: two anchors joined by two curves are a
 * lens, one anchor with both handles out is a teardrop, and both enclose
 * real area (the lens between two overlapping circles is the first face
 * anyone hovers). What decides is the FLATTENED ring. A contour with no
 * area — two corner anchors, one corner anchor — flattens to a ring
 * whose edges cancel in pairs, so it still contains nothing.
 */
export function pointInAnchorPath(
  point: Vec2,
  anchors: readonly AnchorTriple[],
  subpathStarts: readonly number[] = [],
  options?: { samplesPerSegment?: number },
): boolean {
  return insideRings(point, flattenContours(anchors, subpathStarts, options));
}
