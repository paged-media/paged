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

// The on-canvas CORNER-RADIUS math (concept §13.2 "drag corner widgets" —
// the future the live-corners command module reserved via its exported
// per-corner builder). Host-free pure geometry over an axis-aligned
// rectangle's page bounds: which corner a press hits, the radius a drag
// implies, and the preview polyline the overlay draws. The gesture
// handler in draw-bundle owns the host wiring.

import type { Vec2 } from "@paged-media/draw-geometry";

/** Page bounds as the engine reports them: [top, left, bottom, right]. */
export type Bounds = readonly [number, number, number, number];

/** IDML corner order — 0 topLeft · 1 topRight · 2 bottomRight · 3 bottomLeft
 *  (the order `cornerRadiiMutationFor` addresses). */
export type CornerIndex = 0 | 1 | 2 | 3;

/** The corner points of `bounds` in IDML order. */
export function cornerPoints(bounds: Bounds): [Vec2, Vec2, Vec2, Vec2] {
  const [top, left, bottom, right] = bounds;
  return [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ];
}

/** The corner within `tol` of `point`, nearest first, or null. */
export function cornerAt(
  bounds: Bounds,
  point: Vec2,
  tol: number,
): CornerIndex | null {
  let best: CornerIndex | null = null;
  let bestD = tol;
  cornerPoints(bounds).forEach((c, i) => {
    const d = Math.hypot(point[0] - c[0], point[1] - c[1]);
    if (d <= bestD) {
      bestD = d;
      best = i as CornerIndex;
    }
  });
  return best;
}

/** The largest radius the rectangle admits (half the short side). */
export function maxRadius(bounds: Bounds): number {
  const [top, left, bottom, right] = bounds;
  return Math.max(0, Math.min(right - left, bottom - top) / 2);
}

/**
 * The radius a drag to `point` implies for `corner`: the smaller of the
 * two INWARD distances from the corner (dragging along either edge or
 * the diagonal all read naturally), clamped to [0, maxRadius]. A drag
 * that leaves the rectangle on both axes reads 0.
 */
export function radiusFromDrag(
  bounds: Bounds,
  corner: CornerIndex,
  point: Vec2,
): number {
  const [cx, cy] = cornerPoints(bounds)[corner];
  const [top, left, bottom, right] = bounds;
  const inX = corner === 0 || corner === 3 ? point[0] - cx : cx - point[0];
  const inY = corner === 0 || corner === 1 ? point[1] - cy : cy - point[1];
  void top;
  void left;
  void bottom;
  void right;
  const r = Math.min(Math.max(inX, 0), Math.max(inY, 0));
  return Math.min(r, maxRadius(bounds));
}

/** The overlay preview polyline for a corner radius: the two edge points
 *  the arc would meet, through the corner — the radius extent made
 *  visible without needing an arc primitive. */
export function cornerPreview(
  bounds: Bounds,
  corner: CornerIndex,
  radius: number,
): Vec2[] {
  const [cx, cy] = cornerPoints(bounds)[corner];
  const dirX = corner === 0 || corner === 3 ? 1 : -1;
  const dirY = corner === 0 || corner === 1 ? 1 : -1;
  return [
    [cx + dirX * radius, cy],
    [cx, cy],
    [cx, cy + dirY * radius],
  ];
}
