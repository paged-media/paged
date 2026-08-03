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

import type { Vec2 } from "./types";

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
