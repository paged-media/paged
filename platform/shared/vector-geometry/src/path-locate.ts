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

// LOCATIONS ON A CONTOUR — the vocabulary the Path Eraser, the Join tool
// and the Shaper's trim share. A location is `{ segment, t }`: segment
// `i` runs from anchor `i` to anchor `i + 1` (the closing segment of a
// closed contour is `n - 1`, back to anchor 0), `t ∈ [0, 1]` along its
// cubic. Everything here is pure and works on ONE contour's anchors.
//
//   · `locatedSamples` flattens a contour into points that each know their
//     location — the eraser marks the samples its brush covers, the join
//     tool intersects two contours' samples;
//   · `subRun` cuts the exact sub-curve between two locations out of a
//     contour (two de Casteljau splits per end segment), so a trimmed
//     piece traces the original curve rather than a re-fit of it;
//   · `polylineDistance` / `polylineIntersections` are the two polyline
//     queries those tools need.

import type { AnchorTriple, Vec2, Vec2Mut } from "./types";
import { evalCubic, splitSegmentDeCasteljau } from "./bezier";

/** A point on a contour: segment index and the parameter along it. */
export interface PathLocation {
  segment: number;
  t: number;
}

/** A flattened sample that knows where on the contour it lies. */
export interface LocatedSample {
  point: Vec2Mut;
  at: PathLocation;
}

/** The four control points of segment `i`. */
export function segmentCubic(
  anchors: readonly AnchorTriple[],
  i: number,
): [Vec2, Vec2, Vec2, Vec2] {
  const a = anchors[i]!;
  const b = anchors[(i + 1) % anchors.length]!;
  return [a.anchor, a.right, b.left, b.anchor];
}

/** How many segments a contour of `n` anchors has. */
export function segmentCount(n: number, closed: boolean): number {
  if (n < 2) return 0;
  return closed ? n : n - 1;
}

/** `samplesPerSegment` samples per segment (each segment's END included,
 *  the contour's first point once), each carrying its location. */
export function locatedSamples(
  anchors: readonly AnchorTriple[],
  closed: boolean,
  samplesPerSegment = 32,
): LocatedSample[] {
  const segs = segmentCount(anchors.length, closed);
  if (segs === 0) return [];
  const out: LocatedSample[] = [
    {
      point: [anchors[0]!.anchor[0], anchors[0]!.anchor[1]],
      at: { segment: 0, t: 0 },
    },
  ];
  for (let i = 0; i < segs; i++) {
    const [p0, p1, p2, p3] = segmentCubic(anchors, i);
    for (let s = 1; s <= samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      out.push({ point: evalCubic(p0, p1, p2, p3, t), at: { segment: i, t } });
    }
  }
  return out;
}

/** A location as one scalar, `segment + t`. */
export const locationScalar = (at: PathLocation): number => at.segment + at.t;

/** The point at a location. */
export function pointAtLocation(
  anchors: readonly AnchorTriple[],
  at: PathLocation,
): Vec2Mut {
  const [p0, p1, p2, p3] = segmentCubic(anchors, at.segment);
  return evalCubic(p0, p1, p2, p3, at.t);
}

/** The sub-cubic of `[p0..p3]` between `t0 < t1`. */
export function subCubic(
  cubic: readonly [Vec2, Vec2, Vec2, Vec2],
  t0: number,
  t1: number,
): [Vec2Mut, Vec2Mut, Vec2Mut, Vec2Mut] {
  const [p0, p1, p2, p3] = cubic;
  // Cut at t1 first, keep the left part; then cut that at t0 / t1.
  let a: Vec2 = p0;
  let b: Vec2 = p1;
  let c: Vec2 = p2;
  let d: Vec2 = p3;
  if (t1 < 1) {
    const s = splitSegmentDeCasteljau(a, b, c, d, t1);
    b = s.startRight;
    c = s.midLeft;
    d = s.midAnchor;
  }
  if (t0 > 0) {
    const u = t1 > 0 ? t0 / t1 : 0;
    const s = splitSegmentDeCasteljau(a, b, c, d, u);
    a = s.midAnchor;
    b = s.midRight;
    c = s.endLeft;
  }
  return [
    [a[0], a[1]],
    [b[0], b[1]],
    [c[0], c[1]],
    [d[0], d[1]],
  ];
}

const LOC_EPS = 1e-9;

/**
 * The OPEN run of the contour from `from` to `to`, following the
 * contour's direction. On a closed contour `to` before `from` wraps
 * through the closing segment; on an open one it must not (null). The
 * run's two ends are corners on their outward side; every original
 * anchor strictly inside keeps both its handles. Null when the run is
 * empty.
 */
export function subRun(
  anchors: readonly AnchorTriple[],
  closed: boolean,
  from: PathLocation,
  to: PathLocation,
): AnchorTriple[] | null {
  const segs = segmentCount(anchors.length, closed);
  if (segs === 0) return null;
  const s0 = locationScalar(from);
  let s1 = locationScalar(to);
  if (s1 < s0 - LOC_EPS) {
    if (!closed) return null;
    s1 += segs;
  }
  if (s1 - s0 <= LOC_EPS) return null;
  const pieces: [Vec2Mut, Vec2Mut, Vec2Mut, Vec2Mut][] = [];
  for (let k = Math.floor(s0); k < s1 - LOC_EPS; k++) {
    const t0 = Math.max(0, s0 - k);
    const t1 = Math.min(1, s1 - k);
    if (t1 - t0 <= LOC_EPS) continue;
    pieces.push(subCubic(segmentCubic(anchors, k % segs), t0, t1));
  }
  if (pieces.length === 0) return null;
  const out: AnchorTriple[] = [];
  const first = pieces[0]!;
  out.push({ anchor: first[0], left: [...first[0]], right: first[1] });
  for (let i = 1; i < pieces.length; i++) {
    const prev = pieces[i - 1]!;
    const next = pieces[i]!;
    out.push({ anchor: prev[3], left: prev[2], right: next[1] });
  }
  const last = pieces[pieces.length - 1]!;
  out.push({ anchor: last[3], left: last[2], right: [...last[3]] });
  return out;
}

/** The distance from `p` to the polyline `line` (≥ 1 point). */
export function polylineDistance(p: Vec2, line: readonly Vec2[]): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1)
    return Math.hypot(p[0] - line[0]![0], p[1] - line[0]![1]);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let u = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
    u = Math.max(0, Math.min(1, u));
    const d = Math.hypot(p[0] - (a[0] + u * dx), p[1] - (a[1] + u * dy));
    if (d < best) best = d;
  }
  return best;
}

/** One crossing of two polylines: the point, and the fraction along
 *  each (segment index + fraction within it). */
export interface PolylineCrossing {
  point: Vec2Mut;
  /** `i + u` along the first polyline. */
  a: number;
  /** `j + v` along the second. */
  b: number;
}

/** Every proper crossing of `a` and `b` (touching end to end counts). */
export function polylineIntersections(
  a: readonly Vec2[],
  b: readonly Vec2[],
): PolylineCrossing[] {
  const out: PolylineCrossing[] = [];
  for (let i = 1; i < a.length; i++) {
    const p = a[i - 1]!;
    const r: Vec2 = [a[i]![0] - p[0], a[i]![1] - p[1]];
    for (let j = 1; j < b.length; j++) {
      const q = b[j - 1]!;
      const s: Vec2 = [b[j]![0] - q[0], b[j]![1] - q[1]];
      const den = r[0] * s[1] - r[1] * s[0];
      if (Math.abs(den) < 1e-12) continue;
      const qp: Vec2 = [q[0] - p[0], q[1] - p[1]];
      const u = (qp[0] * s[1] - qp[1] * s[0]) / den;
      const v = (qp[0] * r[1] - qp[1] * r[0]) / den;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      out.push({
        point: [p[0] + u * r[0], p[1] + u * r[1]],
        a: i - 1 + u,
        b: j - 1 + v,
      });
    }
  }
  return out;
}

/** The location of fraction `f` (`index + u`) along a `locatedSamples`
 *  polyline, interpolated between the two samples it falls between. */
export function locationAlongSamples(
  samples: readonly LocatedSample[],
  f: number,
): PathLocation {
  const i = Math.max(0, Math.min(samples.length - 1, Math.floor(f)));
  const j = Math.min(samples.length - 1, i + 1);
  const u = f - i;
  const a = samples[i]!.at;
  const b = samples[j]!.at;
  if (b.segment !== a.segment) {
    // `a` ends its segment (t = 1), so the stretch to `b` is the start
    // of `b`'s segment: t runs from 0 to `b.t`.
    return { segment: b.segment, t: b.t * u };
  }
  return { segment: a.segment, t: a.t + (b.t - a.t) * u };
}

/** Summed length of a polyline. */
export function polylineLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(
      points[i]![0] - points[i - 1]![0],
      points[i]![1] - points[i - 1]![1],
    );
  }
  return total;
}
