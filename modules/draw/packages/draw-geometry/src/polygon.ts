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
 */
export function pointInAnchorPath(
  point: Vec2,
  anchors: readonly AnchorTriple[],
  subpathStarts: readonly number[] = [],
  options?: { samplesPerSegment?: number },
): boolean {
  if (anchors.length < 3) return false;
  const starts = subpathStarts.length > 0 ? [...subpathStarts] : [0];
  const [px, py] = point;
  let inside = false;
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s];
    const to = s + 1 < starts.length ? starts[s + 1] : anchors.length;
    if (to - from < 3) continue;
    const ring = flattenAnchorRun(anchors.slice(from, to), {
      close: true,
      samplesPerSegment: options?.samplesPerSegment,
    });
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const crosses = yi > py !== yj > py;
      if (crosses && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}
