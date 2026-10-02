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

// Anchor classification — the corner test the editor's path-edit
// overlay uses for its smooth/corner double-click toggle: an anchor
// is a corner iff BOTH handles coincide with it (IDML's zero-handle
// convention for sharp corners).

import { dist } from "./types";
import type { AnchorTriple } from "./types";

export function isCornerAnchor(a: AnchorTriple, eps = 1e-3): boolean {
  return dist(a.left, a.anchor) < eps && dist(a.right, a.anchor) < eps;
}

/**
 * Smooth test — the complement the handle-drag gesture needs. An anchor
 * is SMOOTH iff both handles are extended (neither collapsed onto the
 * anchor) AND they point in opposite directions through it, i.e. the
 * three points are collinear with the anchor in the middle. Lengths may
 * differ (an asymmetric smooth point is still smooth). Everything else
 * — a corner, a one-handled curve end, a cusp — is not.
 *
 * `eps` is the collapsed-handle length (same default as
 * `isCornerAnchor`); `angleTol` bounds |sin θ| of the deviation from a
 * straight line (1e-3 ≈ 0.06°, well above the f32 round-off the engine's
 * anchor table carries and well below anything a user draws on purpose).
 */
export function isSmoothAnchor(
  a: AnchorTriple,
  eps = 1e-3,
  angleTol = 1e-3,
): boolean {
  const lx = a.left[0] - a.anchor[0];
  const ly = a.left[1] - a.anchor[1];
  const rx = a.right[0] - a.anchor[0];
  const ry = a.right[1] - a.anchor[1];
  const ll = Math.hypot(lx, ly);
  const rl = Math.hypot(rx, ry);
  if (ll < eps || rl < eps) return false;
  const dot = lx * rx + ly * ry;
  if (dot >= 0) return false;
  return Math.abs(lx * ry - ly * rx) <= angleTol * ll * rl;
}
