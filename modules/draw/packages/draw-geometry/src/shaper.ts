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

// THE SHAPER'S RECOGNISER — a freehand stroke in, a clean shape (or a
// SCRIBBLE) out. Pure and DETERMINISTIC: the same points are always the
// same answer, which is what lets the spec pin it with recorded strokes.
//
// The decision, in order, every threshold relative to the stroke's own
// size (its bounding-box diagonal) so it means the same at any zoom:
//
//   1. too small (diagonal under `minSize`)            → nothing;
//   2. SCRIBBLE — the stroke doubles back on itself at least three times
//      (a turn sharper than `SCRIBBLE_TURN_DEG` at a vertex of its RDP
//      outline). A circle, a rectangle or a triangle never turns that
//      hard, a back-and-forth scrub always does;
//   3. LINE — every point within 6 % of the chord's length of it. The
//      angle snaps to the nearest 45° within `LINE_SNAP_DEG`;
//   4. not CLOSED (the ends further apart than a quarter of the
//      diagonal)                                       → nothing;
//   5. ELLIPSE — the mean radial error against the bounding box's
//      ellipse is under 6 % AND the ellipse fits the stroke at least as
//      closely (mean distance, pt) as its corner outline does; equal radii
//      within 12 % make it a circle;
//   6. otherwise the corners of its RDP outline (straight-on vertices
//      merged): 3 → TRIANGLE, 4 → RECTANGLE (axis-aligned when every edge
//      is within 12° of an axis, else the rectangle along its longest
//      edge), 5 or more → a REGULAR POLYGON with that many sides.
//
// What it answers is geometry; whether a scribble merges or punches out
// is the tool's call (it knows which shapes are underneath).

import type { AnchorTable, AnchorTriple, Vec2, Vec2Mut } from "./types";
import { simplifyRdp } from "./rdp";
import { ellipseToPath, lineToPath } from "./svg-shapes";
import { regularPolygonPath } from "./star";
import { polylineDistance, polylineLength } from "./path-locate";

export type ShaperKind =
  | "line"
  | "rectangle"
  | "ellipse"
  | "triangle"
  | "polygon"
  | "scribble";

export interface ShaperRecognition {
  kind: ShaperKind;
  /** The clean shape, page space — null for a scribble. */
  table: AnchorTable | null;
  /** A polygon's side count. */
  sides?: number;
}

export interface ShaperOptions {
  /** pt — a stroke whose bounding-box diagonal is smaller is ignored.
   *  Default 4. */
  minSize?: number;
}

export const SCRIBBLE_TURN_DEG = 140;
export const SCRIBBLE_MIN_REVERSALS = 3;
export const LINE_SNAP_DEG = 5;
const LINE_DEVIATION = 0.06;
const CLOSE_GAP = 0.25;
const ELLIPSE_ERROR = 0.06;
const CIRCLE_RATIO = 0.12;
const CORNER_EPS = 0.07;
const STRAIGHT_ON_DEG = 160;
const AXIS_DEG = 12;

const corner = (p: Vec2): AnchorTriple => ({
  anchor: [p[0], p[1]],
  left: [p[0], p[1]],
  right: [p[0], p[1]],
});

const closedTable = (pts: readonly Vec2[]): AnchorTable => ({
  anchors: pts.map(corner),
  subpathStarts: [0],
  subpathOpen: [false],
});

/** The turn at `b` between `a→b` and `b→c`, degrees (0 = straight on). */
function turnDeg(a: Vec2, b: Vec2, c: Vec2): number {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const vx = c[0] - b[0];
  const vy = c[1] - b[1];
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (lu === 0 || lv === 0) return 0;
  const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)));
  return (Math.acos(cos) * 180) / Math.PI;
}

function boundsOf(points: readonly Vec2[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

/** Rotate `p` by `rad` about `c`. */
function rotate(p: Vec2, c: Vec2, rad: number): Vec2Mut {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const x = p[0] - c[0];
  const y = p[1] - c[1];
  return [c[0] + x * cos - y * sin, c[1] + x * sin + y * cos];
}

/** The corners of a closed stroke: its RDP outline as a ring, the
 *  closing duplicate dropped and straight-on vertices merged. */
function ringCorners(points: readonly Vec2[], eps: number): Vec2Mut[] {
  const ring = [...points, points[0]!];
  let pts: Vec2Mut[] = simplifyRdp(ring, eps).map((p) => [p[0], p[1]]);
  if (pts.length > 1) pts.pop(); // the closing point is the first again
  // The stroke started mid-edge most of the time: the start is a vertex
  // of the RDP outline only because it was kept, so it is merged like
  // any other straight-on vertex.
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length]!;
      const b = pts[i]!;
      const c = pts[(i + 1) % pts.length]!;
      if (180 - turnDeg(a, b, c) > STRAIGHT_ON_DEG) {
        pts = pts.filter((_, k) => k !== i);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

function lineFrom(a: Vec2, b: Vec2): AnchorTable {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy);
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const snapped = Math.round(deg / 45) * 45;
  if (Math.abs(deg - snapped) <= LINE_SNAP_DEG) {
    const rad = (snapped * Math.PI) / 180;
    // Snap about the midpoint, so the line stays where it was drawn.
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    const hx = (Math.cos(rad) * l) / 2;
    const hy = (Math.sin(rad) * l) / 2;
    return lineToPath(mx - hx, my - hy, mx + hx, my + hy);
  }
  return lineToPath(a[0], a[1], b[0], b[1]);
}

function rectangleFrom(corners: readonly Vec2[], all: readonly Vec2[]): AnchorTable {
  // Every edge's angle off its nearest axis.
  let axisAligned = true;
  let longest = 0;
  let angle = 0;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    const deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    const off = Math.abs(deg - Math.round(deg / 90) * 90);
    if (off > AXIS_DEG) axisAligned = false;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > longest) {
      longest = l;
      angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    }
  }
  if (axisAligned) {
    const { minX, minY, maxX, maxY } = boundsOf(corners);
    return closedTable([
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ]);
  }
  // The rectangle along the longest edge: un-rotate, box, rotate back.
  const b0 = boundsOf(all);
  const c: Vec2 = [(b0.minX + b0.maxX) / 2, (b0.minY + b0.maxY) / 2];
  const flat = corners.map((p) => rotate(p, c, -angle));
  const { minX, minY, maxX, maxY } = boundsOf(flat);
  return closedTable(
    (
      [
        [minX, minY],
        [maxX, minY],
        [maxX, maxY],
        [minX, maxY],
      ] as Vec2[]
    ).map((p) => rotate(p, c, angle)),
  );
}

/**
 * Recognise a freehand stroke (page space, in drawing order). Null when
 * it is too small, or an open stroke that is not a line.
 */
export function recogniseShape(
  input: readonly Vec2[],
  options: ShaperOptions = {},
): ShaperRecognition | null {
  const points: Vec2[] = [];
  for (const p of input) {
    const last = points[points.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) points.push(p);
  }
  if (points.length < 2) return null;
  const { minX, minY, maxX, maxY } = boundsOf(points);
  const w = maxX - minX;
  const h = maxY - minY;
  const diag = Math.hypot(w, h);
  if (diag < (options.minSize ?? 4)) return null;

  // 2. Scribble: count the hard reversals of the RDP outline.
  const outline = simplifyRdp(points, CORNER_EPS * diag * 0.5);
  let reversals = 0;
  for (let i = 1; i + 1 < outline.length; i++) {
    if (turnDeg(outline[i - 1]!, outline[i]!, outline[i + 1]!) > SCRIBBLE_TURN_DEG)
      reversals++;
  }
  if (reversals >= SCRIBBLE_MIN_REVERSALS) return { kind: "scribble", table: null };

  // 3. Line.
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const chord = Math.hypot(last[0] - first[0], last[1] - first[1]);
  if (chord > 0) {
    let worst = 0;
    for (const p of points) {
      const d =
        Math.abs(
          (last[0] - first[0]) * (p[1] - first[1]) -
            (last[1] - first[1]) * (p[0] - first[0]),
        ) / chord;
      worst = Math.max(worst, d);
    }
    if (worst <= LINE_DEVIATION * chord && chord >= 0.8 * diag)
      return { kind: "line", table: lineFrom(first, last) };
  }

  // 4. Closed?
  const length = polylineLength(points);
  if (chord > CLOSE_GAP * diag || length < 2 * diag) return null;

  // 5./6. Ellipse or corners — whichever fits the stroke better. The
  // ellipse is the bounding box's; the corners are the RDP outline's.
  // Both residuals are mean distances in pt, so a hexagon (whose points
  // sit ON its edges, a few pt off any ellipse) and a circle (whose points
  // sit on the ellipse, several pt off a coarse polygon) each pick their
  // own.
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = w / 2;
  const ry = h / 2;
  const corners = ringCorners(points, CORNER_EPS * diag);
  let ellipseError = Infinity;
  let ellipseResidual = Infinity;
  if (rx > 0 && ry > 0) {
    let err = 0;
    for (const p of points) {
      const nx = (p[0] - cx) / rx;
      const ny = (p[1] - cy) / ry;
      err += Math.abs(Math.hypot(nx, ny) - 1);
    }
    ellipseError = err / points.length;
    ellipseResidual = ellipseError * ((rx + ry) / 2);
  }
  let polygonResidual = Infinity;
  if (corners.length >= 3) {
    const ring = [...corners, corners[0]!];
    polygonResidual =
      points.reduce((s, p) => s + polylineDistance(p, ring), 0) /
      points.length;
  }
  if (ellipseError < ELLIPSE_ERROR && ellipseResidual <= polygonResidual) {
    const circle = Math.abs(rx - ry) / Math.max(rx, ry) <= CIRCLE_RATIO;
    const r = (rx + ry) / 2;
    return {
      kind: "ellipse",
      table: circle
        ? ellipseToPath(cx, cy, r, r)
        : ellipseToPath(cx, cy, rx, ry),
    };
  }
  if (corners.length === 3)
    return { kind: "triangle", table: closedTable(corners) };
  if (corners.length === 4)
    return { kind: "rectangle", table: rectangleFrom(corners, points) };
  if (corners.length >= 5) {
    const centre: Vec2 = [cx, cy];
    const radius =
      corners.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) /
      corners.length;
    const c0 = corners[0]!;
    const rotationDeg =
      (Math.atan2(c0[1] - centre[1], c0[0] - centre[0]) * 180) / Math.PI + 90;
    return {
      kind: "polygon",
      sides: corners.length,
      table: regularPolygonPath(cx, cy, radius, corners.length, rotationDeg),
    };
  }
  // Fewer than three corners on a closed stroke: a squashed loop.
  return rx > 0 && ry > 0
    ? { kind: "ellipse", table: ellipseToPath(cx, cy, rx, ry) }
    : null;
}
