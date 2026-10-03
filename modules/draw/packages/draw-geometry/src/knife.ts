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

// THE KNIFE — the pure half. The cut itself is the ENGINE's planar
// arrangement (draw-bundle `commands/knife.ts` says why and how); what
// lives here is the geometry the bundle hands it and takes back:
//
//   · `sliverAround` — the CLOSED polygon a cut polyline becomes. The
//     arrangement only knows closed regions (every input subpath is
//     implicitly closed), so an open cut line cannot divide anything by
//     itself; a strip `width` wide around it can. Corners are mitred,
//     with the mitre CLAMPED to `MITRE_LIMIT` half-widths so a sharp turn
//     never throws a spike across a neighbouring face.
//   · `snapOntoPolyline` — the gap closer. A face of "the target minus
//     the strip" has its cut edges half a strip-width off the line the
//     user drew; moving every anchor that lies within `tolerance` of that
//     line ONTO it makes two neighbouring pieces meet along the cut
//     again — a corner where the cut meets the outline SLIDES along the
//     outline to get there, so the outline keeps its line. The handles
//     travel with their anchor; an anchor further away is untouched.
//   · `tableBounds` — `[top, left, bottom, right]` over anchors AND
//     handles, the order and the hull the engine's own Divide writes as a
//     carrier's `frameBounds`.
//
// Pure, zero-dep, page- or path-local pt in and out: nothing here knows
// which space it is in, so the caller maps the cut into the target's
// inner space first.

import type { AnchorTable, AnchorTriple, Vec2 } from "./types";

/** The longest a corner's mitre may reach, in half-widths. Past it the
 *  corner point is pulled back along the bisector — the strip still
 *  covers the cut line, it just does not spike. */
export const MITRE_LIMIT = 4;

const sub = (a: Vec2, b: Vec2): [number, number] => [a[0] - b[0], a[1] - b[1]];

/** `points` with consecutive duplicates (closer than 1e-9) dropped. */
function deduped(points: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) out.push(p);
  }
  return out;
}

/**
 * The closed strip `width` wide around the OPEN polyline `points`: the
 * left offset walked forward, then the right offset walked back. Corner
 * anchors only (handles on their anchors) — a strip is straight edges.
 *
 * Null when the polyline has fewer than two distinct points or `width`
 * is not a positive finite number.
 */
export function sliverAround(
  points: readonly Vec2[],
  width: number,
): AnchorTriple[] | null {
  if (!(Number.isFinite(width) && width > 0)) return null;
  const pts = deduped(points);
  if (pts.length < 2) return null;
  const h = width / 2;
  // One unit LEFT normal per segment (y-down page space: left of the
  // travel direction is (dy, -dx) rotated — the side only has to be
  // consistent, not "left" in any absolute sense).
  const normals: [number, number][] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = sub(pts[i + 1], pts[i]);
    const len = Math.hypot(d[0], d[1]);
    normals.push([-d[1] / len, d[0] / len]);
  }
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    let off: [number, number];
    if (i === 0) off = [normals[0][0] * h, normals[0][1] * h];
    else if (i === pts.length - 1) {
      const n = normals[i - 1];
      off = [n[0] * h, n[1] * h];
    } else {
      const a = normals[i - 1];
      const b = normals[i];
      const m: [number, number] = [a[0] + b[0], a[1] + b[1]];
      const len = Math.hypot(m[0], m[1]);
      if (len < 1e-9) {
        // An exact reversal: no bisector. Keep the incoming side's
        // offset — the strip pinches to its own width there.
        off = [a[0] * h, a[1] * h];
      } else {
        const bis: [number, number] = [m[0] / len, m[1] / len];
        // cos of half the turn = the normal's projection on the bisector.
        const cosHalf = a[0] * bis[0] + a[1] * bis[1];
        const reach = Math.min(h / Math.max(cosHalf, 1e-9), MITRE_LIMIT * h);
        off = [bis[0] * reach, bis[1] * reach];
      }
    }
    const p = pts[i];
    left.push([p[0] + off[0], p[1] + off[1]]);
    right.push([p[0] - off[0], p[1] - off[1]]);
  }
  return [...left, ...right.reverse()].map((p) => ({
    anchor: p,
    left: [p[0], p[1]] as [number, number],
    right: [p[0], p[1]] as [number, number],
  }));
}

/** The nearest point to `p` on the polyline, and how far it is. */
export function nearestOnPolyline(
  p: Vec2,
  points: readonly Vec2[],
): { point: [number, number]; distance: number } | null {
  if (points.length === 0) return null;
  if (points.length === 1) {
    const q = points[0];
    return { point: [q[0], q[1]], distance: Math.hypot(p[0] - q[0], p[1] - q[1]) };
  }
  let best: { point: [number, number]; distance: number } | null = null;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const d = sub(b, a);
    const len2 = d[0] * d[0] + d[1] * d[1];
    const t =
      len2 === 0
        ? 0
        : Math.min(1, Math.max(0, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / len2));
    const q: [number, number] = [a[0] + d[0] * t, a[1] + d[1] * t];
    const distance = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (!best || distance < best.distance) best = { point: q, distance };
  }
  return best;
}

/** Where the LINE through `origin` along `dir` meets the polyline: the
 *  meeting point nearest `origin` (in either direction), or null when
 *  the line misses every segment or `dir` is degenerate. */
function lineMeetsPolyline(
  origin: Vec2,
  dir: Vec2,
  points: readonly Vec2[],
): [number, number] | null {
  const len = Math.hypot(dir[0], dir[1]);
  if (len < 1e-12) return null;
  const d: [number, number] = [dir[0] / len, dir[1] / len];
  let best: { at: [number, number]; s: number } | null = null;
  for (let i = 0; i + 1 < points.length; i++) {
    const q0 = points[i];
    const e = sub(points[i + 1], q0);
    const denom = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(denom) < 1e-12) continue; // parallel
    const w = sub(q0, origin);
    const s = (w[0] * e[1] - w[1] * e[0]) / denom;
    const u = (w[0] * d[1] - w[1] * d[0]) / denom;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    if (!best || Math.abs(s) < Math.abs(best.s)) {
      best = { at: [origin[0] + d[0] * s, origin[1] + d[1] * s], s };
    }
  }
  return best ? best.at : null;
}

/** The direction an anchor's edge toward a neighbour LEAVES it: its own
 *  handle on that side when it has one, else the neighbour's facing
 *  handle, else the neighbour itself (a straight edge). */
function edgeDirection(a: AnchorTriple, n: AnchorTriple, toward: "next" | "prev"): [number, number] {
  const own = toward === "next" ? a.right : a.left;
  if (Math.hypot(own[0] - a.anchor[0], own[1] - a.anchor[1]) > 1e-9) return sub(own, a.anchor);
  const facing = toward === "next" ? n.left : n.right;
  if (Math.hypot(facing[0] - a.anchor[0], facing[1] - a.anchor[1]) > 1e-9) {
    return sub(facing, a.anchor);
  }
  return sub(n.anchor, a.anchor);
}

/** How far an anchor may SLIDE along its boundary edge to reach the cut,
 *  in multiples of the snap tolerance. A crossing so oblique that it
 *  needs more is projected straight onto the cut instead. */
export const SNAP_SLIDE_LIMIT = 16;

/**
 * `table` with every anchor that lies within `tolerance` of the polyline
 * moved ONTO it, its handles moved by the same delta. Everything else —
 * the contour structure, the open flags, every other anchor — is
 * returned as it was. Pure.
 *
 * HOW an anchor moves decides whether the shape around it survives:
 *   · an anchor where the cut meets the ORIGINAL outline (one neighbour
 *     lies along the cut, the other is far from it) SLIDES ALONG that
 *     outline edge until it reaches the cut, so the outline keeps its
 *     line: projected straight across, the corner would pivot a whole
 *     long edge off the shape (measured: ~0.6 pt² per piece on a 100 pt
 *     square cut at 30°);
 *   · an anchor whose neighbours BOTH lie along the cut (a bend of the
 *     cut itself) is projected straight onto the cut;
 *   · a slide longer than `SNAP_SLIDE_LIMIT` tolerances (a grazing
 *     crossing) falls back to the straight projection.
 */
export function snapOntoPolyline(
  table: AnchorTable,
  points: readonly Vec2[],
  tolerance: number,
): AnchorTable {
  const line = deduped(points);
  const n = table.anchors.length;
  const starts = table.subpathStarts.length > 0 ? table.subpathStarts : [0];
  const near = (p: Vec2) => {
    const q = nearestOnPolyline(p, line);
    return q !== null && q.distance <= tolerance;
  };
  const anchors = table.anchors.map((a, i): AnchorTriple => {
    const nearest = nearestOnPolyline(a.anchor, line);
    if (!nearest || nearest.distance > tolerance || nearest.distance === 0) return a;
    // This anchor's contour, for its cyclic neighbours.
    let from = 0;
    let to = n;
    for (let k = 0; k < starts.length; k++) {
      const s = starts[k]!;
      const e = k + 1 < starts.length ? starts[k + 1]! : n;
      if (i >= s && i < e) {
        from = s;
        to = e;
        break;
      }
    }
    const len = to - from;
    const prev = table.anchors[from + ((i - from - 1 + len) % len)]!;
    const next = table.anchors[from + ((i - from + 1) % len)]!;
    let target: [number, number] = nearest.point;
    const prevNear = near(prev.anchor);
    const nextNear = near(next.anchor);
    if (len >= 3 && prevNear !== nextNear) {
      const far = nextNear ? prev : next;
      const dir = edgeDirection(a, far, nextNear ? "prev" : "next");
      const hit = lineMeetsPolyline(a.anchor, dir, line);
      if (
        hit &&
        Math.hypot(hit[0] - a.anchor[0], hit[1] - a.anchor[1]) <= SNAP_SLIDE_LIMIT * tolerance
      ) {
        target = hit;
      }
    }
    const dx = target[0] - a.anchor[0];
    const dy = target[1] - a.anchor[1];
    return {
      anchor: target,
      left: [a.left[0] + dx, a.left[1] + dy],
      right: [a.right[0] + dx, a.right[1] + dy],
    };
  });
  return {
    anchors,
    subpathStarts: [...table.subpathStarts],
    ...(table.subpathOpen ? { subpathOpen: [...table.subpathOpen] } : {}),
  };
}

/** `[top, left, bottom, right]` over every anchor AND handle — the hull
 *  the engine writes as a rewritten carrier's `frameBounds`. Null for an
 *  empty table. */
export function tableBounds(
  table: Pick<AnchorTable, "anchors">,
): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const a of table.anchors) {
    for (const p of [a.anchor, a.left, a.right]) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  return Number.isFinite(minX) ? [minY, minX, maxY, maxX] : null;
}

/** Do two `[top, left, bottom, right]` boxes overlap (touching counts)? */
export function boundsOverlap(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): boolean {
  return a[1] <= b[3] && b[1] <= a[3] && a[0] <= b[2] && b[0] <= a[2];
}
