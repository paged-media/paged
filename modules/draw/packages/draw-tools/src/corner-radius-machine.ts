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
// per-corner builder). Host-free pure geometry: which corner a press
// hits, the radius a drag implies, and the preview polyline the overlay
// draws. The gesture handler in draw-bundle owns the host wiring.
//
// EVERYTHING HERE IS IN THE ELEMENT'S OWN (INNER) SPACE. The box
// functions read the frame's `bounds` exactly as `elementGeometry`
// reports them — its own space, before the item transform — and the
// handler maps the pointer through the INVERSE transform before asking,
// and the preview back through the transform after. That is what makes a
// ROTATED rectangle work: its corners are the box's corners in its own
// frame, wherever they land on the page, and "top left" means the
// element's own top left, as it does in InDesign.
//
// TWO SHAPES OF CORNER:
//   · a BOX (rectangle, text frame): four corners in IDML order, a
//     radius per corner — the drag reads the smaller of the two inward
//     distances, clamped to half the short side;
//   · a POLYGON: a corner at every anchor the renderer actually rounds —
//     one whose BOTH segments are straight, on a CLOSED contour, with a
//     real turn (core `resolve_poly_corner`). The renderer's rounding is
//     the inscribed circle: the arc meets each edge `r / tan(θ/2)` back
//     from the vertex, θ the interior angle, clamped to half of either
//     edge. So the drag reads that TANGENT distance (the smaller of the
//     two projections onto the edges) and answers `r = d · tan(θ/2)` —
//     at 90° exactly the box rule. ONE radius per polygon: the renderer
//     reads only the top-left slot for an N-gon, so every corner's
//     handle drives the same, uniform radius.

import type { AnchorTable, Vec2 } from "@paged-media/draw-geometry";

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

// ------------------------------------------------------------- polygons

/** One corner the renderer rounds: the vertex, the unit directions
 *  BACK along the incoming edge and ON along the outgoing one, both
 *  edges' lengths, and half the interior angle. */
export interface PolygonCorner {
  /** The anchor's flat index in the table. */
  index: number;
  point: Vec2;
  inDir: Vec2;
  outDir: Vec2;
  inLen: number;
  outLen: number;
  halfAngle: number;
}

const near = (a: Vec2, b: Vec2): boolean =>
  Math.abs(a[0] - b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4;

/**
 * Every corner of `table` the renderer rounds (core
 * `corner_polygon_path`): CLOSED contours of three or more anchors, at an
 * anchor whose incoming AND outgoing segments are straight (handles on
 * their anchors) and that turns by a real angle. A smooth or curved
 * junction carries its own curvature and is left alone, so it gets no
 * handle. Pure.
 */
export function polygonCorners(table: AnchorTable): PolygonCorner[] {
  const n = table.anchors.length;
  const starts = table.subpathStarts.length > 0 ? table.subpathStarts : [0];
  const out: PolygonCorner[] = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s]!;
    const to = s + 1 < starts.length ? starts[s + 1]! : n;
    const len = to - from;
    if (len < 3 || (table.subpathOpen?.[s] ?? false)) continue;
    for (let k = 0; k < len; k++) {
      const prev = table.anchors[from + ((k - 1 + len) % len)]!;
      const cur = table.anchors[from + k]!;
      const next = table.anchors[from + ((k + 1) % len)]!;
      const straightIn = near(prev.right, prev.anchor) && near(cur.left, cur.anchor);
      const straightOut = near(cur.right, cur.anchor) && near(next.left, next.anchor);
      if (!straightIn || !straightOut) continue;
      const vi: Vec2 = [prev.anchor[0] - cur.anchor[0], prev.anchor[1] - cur.anchor[1]];
      const vo: Vec2 = [next.anchor[0] - cur.anchor[0], next.anchor[1] - cur.anchor[1]];
      const li = Math.hypot(vi[0], vi[1]);
      const lo = Math.hypot(vo[0], vo[1]);
      if (li < 1e-4 || lo < 1e-4) continue;
      const ui: Vec2 = [vi[0] / li, vi[1] / li];
      const uo: Vec2 = [vo[0] / lo, vo[1] / lo];
      const theta = Math.acos(Math.min(1, Math.max(-1, ui[0] * uo[0] + ui[1] * uo[1])));
      if (theta < 1e-3 || theta > Math.PI - 1e-3) continue;
      out.push({
        index: from + k,
        point: cur.anchor,
        inDir: ui,
        outDir: uo,
        inLen: li,
        outLen: lo,
        halfAngle: theta / 2,
      });
    }
  }
  return out;
}

/** The corner within `tol` of `point`, nearest first, or null. */
export function polygonCornerAt(
  corners: readonly PolygonCorner[],
  point: Vec2,
  tol: number,
): PolygonCorner | null {
  let best: PolygonCorner | null = null;
  let bestD = tol;
  for (const c of corners) {
    const d = Math.hypot(point[0] - c.point[0], point[1] - c.point[1]);
    if (d <= bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/** The TANGENT distance a drag to `point` reads at `corner`: the smaller
 *  of its projections onto the two edges, clamped to [0, half of the
 *  shorter edge] (the renderer's own clamp). */
export function polygonTangentFromDrag(corner: PolygonCorner, point: Vec2): number {
  const dx = point[0] - corner.point[0];
  const dy = point[1] - corner.point[1];
  const alongIn = dx * corner.inDir[0] + dy * corner.inDir[1];
  const alongOut = dx * corner.outDir[0] + dy * corner.outDir[1];
  const d = Math.min(Math.max(alongIn, 0), Math.max(alongOut, 0));
  return Math.min(d, corner.inLen / 2, corner.outLen / 2);
}

/** The radius a drag to `point` implies at `corner`: `d · tan(θ/2)`. */
export function polygonRadiusFromDrag(corner: PolygonCorner, point: Vec2): number {
  return polygonTangentFromDrag(corner, point) * Math.tan(corner.halfAngle);
}

/** The preview for a polygon corner at `radius`: the two tangent points
 *  through the vertex (the box preview's idea, on real edges). */
export function polygonCornerPreview(corner: PolygonCorner, radius: number): Vec2[] {
  const t = Math.tan(corner.halfAngle);
  const d = t > 0 ? radius / t : 0;
  const [cx, cy] = corner.point;
  return [
    [cx + corner.inDir[0] * d, cy + corner.inDir[1] * d],
    [cx, cy],
    [cx + corner.outDir[0] * d, cy + corner.outDir[1] * d],
  ];
}
