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

// POLYGON CORNERS — which anchors of a path the renderer rounds and the
// radius a drag at one implies. Host-free pure geometry; the host's
// live-shape widgets (editor ADR 310, `live-shape-handles.tsx`) draw a
// widget at each corner and write the result. A rectangle's four corners
// are the widgets' own box rule (`@paged-media/tools` live-shapes).
//
// EVERYTHING HERE IS IN THE ELEMENT'S OWN (INNER) SPACE: the anchors as
// `pathAnchors` reports them, before the item transform.
//
// A corner sits at every anchor the renderer actually rounds — one whose
// BOTH segments are straight, on a CLOSED contour, with a real turn (core
// `resolve_poly_corner`). The renderer's rounding is the inscribed
// circle: the arc meets each edge `r / tan(θ/2)` back from the vertex, θ
// the interior angle, clamped to half of either edge. So the drag reads
// that TANGENT distance (the smaller of the two projections onto the
// edges) and answers `r = d · tan(θ/2)` — at 90° exactly the box rule.
// ONE radius per polygon: the renderer reads only the top-left slot for
// an N-gon, so every corner's widget drives the same, uniform radius.

import type { AnchorTable, Vec2 } from "@paged-media/vector-geometry";

/** Page bounds as the engine reports them: [top, left, bottom, right]. */
export type Bounds = readonly [number, number, number, number];

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
      const straightIn =
        near(prev.right, prev.anchor) && near(cur.left, cur.anchor);
      const straightOut =
        near(cur.right, cur.anchor) && near(next.left, next.anchor);
      if (!straightIn || !straightOut) continue;
      const vi: Vec2 = [
        prev.anchor[0] - cur.anchor[0],
        prev.anchor[1] - cur.anchor[1],
      ];
      const vo: Vec2 = [
        next.anchor[0] - cur.anchor[0],
        next.anchor[1] - cur.anchor[1],
      ];
      const li = Math.hypot(vi[0], vi[1]);
      const lo = Math.hypot(vo[0], vo[1]);
      if (li < 1e-4 || lo < 1e-4) continue;
      const ui: Vec2 = [vi[0] / li, vi[1] / li];
      const uo: Vec2 = [vo[0] / lo, vo[1] / lo];
      const theta = Math.acos(
        Math.min(1, Math.max(-1, ui[0] * uo[0] + ui[1] * uo[1])),
      );
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
export function polygonTangentFromDrag(
  corner: PolygonCorner,
  point: Vec2,
): number {
  const dx = point[0] - corner.point[0];
  const dy = point[1] - corner.point[1];
  const alongIn = dx * corner.inDir[0] + dy * corner.inDir[1];
  const alongOut = dx * corner.outDir[0] + dy * corner.outDir[1];
  const d = Math.min(Math.max(alongIn, 0), Math.max(alongOut, 0));
  return Math.min(d, corner.inLen / 2, corner.outLen / 2);
}

/** The radius a drag to `point` implies at `corner`: `d · tan(θ/2)`. */
export function polygonRadiusFromDrag(
  corner: PolygonCorner,
  point: Vec2,
): number {
  return polygonTangentFromDrag(corner, point) * Math.tan(corner.halfAngle);
}

/** The preview for a polygon corner at `radius`: the two tangent points
 *  through the vertex (the box preview's idea, on real edges). */
export function polygonCornerPreview(
  corner: PolygonCorner,
  radius: number,
): Vec2[] {
  const t = Math.tan(corner.halfAngle);
  const d = t > 0 ? radius / t : 0;
  const [cx, cy] = corner.point;
  return [
    [cx + corner.inDir[0] * d, cy + corner.inDir[1] * d],
    [cx, cy],
    [cx + corner.outDir[0] * d, cy + corner.outDir[1] * d],
  ];
}

/** The largest radius `corner` takes: the tangent point at half the
 *  shorter edge (the renderer's clamp). */
export function polygonCornerMaxRadius(corner: PolygonCorner): number {
  return (
    (Math.min(corner.inLen, corner.outLen) / 2) * Math.tan(corner.halfAngle)
  );
}

/** Where a corner's widget sits: on the corner's bisector at the centre
 *  of the arc a `radius` rounding draws (`r / sin(θ/2)` in from the
 *  vertex), or `minOffset` in when the corner is square or tighter than
 *  that — the rectangle widget's rule on a real angle (at 90° the two
 *  agree). Dragging the widget to this point reads `radius` back through
 *  {@link polygonRadiusFromDrag}. */
export function polygonCornerWidgetPoint(
  corner: PolygonCorner,
  radius: number,
  minOffset: number,
): Vec2 {
  const bx = corner.inDir[0] + corner.outDir[0];
  const by = corner.inDir[1] + corner.outDir[1];
  const bl = Math.hypot(bx, by) || 1;
  const s = Math.sin(corner.halfAngle) || 1;
  const r = Math.min(radius, polygonCornerMaxRadius(corner));
  const d = Math.max(r / s, minOffset);
  return [corner.point[0] + (bx / bl) * d, corner.point[1] + (by / bl) * d];
}
