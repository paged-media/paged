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

// Ramer-Douglas-Peucker polyline simplification — lifted verbatim
// from the editor's pencil handler (packages/tools/src/handlers/
// pencil-tool.ts) so the editor can re-import it from here (D1 seam
// proof). Iterative with an explicit stack: freehand strokes can run
// thousands of samples and recursion depth tracks the sample count.

import type { Vec2, Vec2Mut } from "./types";

/** Perpendicular distance from `p` to the segment a→b. */
export function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq),
  );
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Simplify `points` to the subset whose removal would deviate the
 *  polyline by more than `tolerance` (same units as the points). */
export function simplifyRdp(
  points: ReadonlyArray<Vec2>,
  tolerance: number,
): Vec2Mut[] {
  if (points.length <= 2) return points.map((p) => [p[0], p[1]]);
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistance(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index >= 0 && maxDist > tolerance) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }
  const out: Vec2Mut[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) out.push([points[i][0], points[i][1]]);
  }
  return out;
}
