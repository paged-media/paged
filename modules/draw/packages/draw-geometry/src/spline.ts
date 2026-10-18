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

// Smooth-through-points handle fitting (Catmull-Rom → cubic Bézier) —
// the geometry kernel of the CURVATURE tool (place points, the curve
// passes smoothly through all of them) and the Pencil's smoothing pass
// over RDP-simplified samples. Pure math, zero deps (the package rule).
//
// The classic uniform Catmull-Rom ↔ Bézier identity: for an interior
// point P_i with neighbours P_{i-1}, P_{i+1}, the tangent is
// (P_{i+1} − P_{i-1}) / 6 — the outgoing Bézier handle is
// P_i + tangent, the incoming handle P_i − tangent (a mirrored,
// "smooth" pair). Open ends clamp the missing neighbour to the end
// point itself, which shortens the terminal tangent to
// (P_1 − P_0)/6 — a gentle ease-out rather than an overshoot.

import type { Vec2 } from "./types";
import type { AnchorTriple } from "./types";

/**
 * Fit smooth cubic anchors THROUGH `points` (uniform Catmull-Rom
 * tangents). `corners[i]` (optional, parallel) collapses point i's
 * handles to the anchor — a corner the curve still passes through.
 * `closed` wraps the neighbour lookup so the contour is smooth across
 * the seam.
 *
 * Degenerate inputs stay honest: zero points → `[]`; a single point →
 * one collapsed (corner) anchor.
 */
export function smoothAnchorsThrough(
  points: ReadonlyArray<Vec2>,
  corners?: ReadonlyArray<boolean>,
  closed = false,
): AnchorTriple[] {
  const n = points.length;
  if (n === 0) return [];
  const out: AnchorTriple[] = [];
  for (let i = 0; i < n; i++) {
    const p: [number, number] = [points[i][0], points[i][1]];
    if (corners?.[i] || n === 1) {
      out.push({ anchor: p, left: [p[0], p[1]], right: [p[0], p[1]] });
      continue;
    }
    // Neighbours: wrap when closed, clamp to the end point when open
    // (the clamped ghost shortens the terminal tangent — no overshoot).
    const prev = closed ? points[(i - 1 + n) % n] : points[Math.max(i - 1, 0)];
    const next = closed ? points[(i + 1) % n] : points[Math.min(i + 1, n - 1)];
    const tx = (next[0] - prev[0]) / 6;
    const ty = (next[1] - prev[1]) / 6;
    out.push({
      anchor: p,
      left: [p[0] - tx, p[1] - ty],
      right: [p[0] + tx, p[1] + ty],
    });
  }
  return out;
}
