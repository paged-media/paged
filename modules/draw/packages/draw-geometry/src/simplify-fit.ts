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

// SIMPLIFY WITH A CORNER THRESHOLD — the anchor reduction the Simplify
// preview draws, and what Simplify writes when a corner angle is set.
//
// WHY A SECOND SIMPLIFIER. The engine's `simplifyPath` (core
// `kurbo_kernel::simplify_path`: RDP decimation, then kurbo's
// `simplify_bezpath`) takes ONE number, the tolerance. Illustrator's
// dialog has a second one — "Corner Point Angle Threshold": an anchor
// whose corner is at least that sharp stays a sharp corner, everything
// between two such corners is re-fitted smooth. The wire op has no field
// for it, and a preview needs the result BEFORE anything is written, which
// no engine door answers. So the fit is here, pure: each contour is cut
// at its kept corners (and an open contour's ends), each run between two
// cuts is flattened and re-fitted with Schneider's algorithm ("An
// Algorithm for Automatically Fitting Digitized Curves", Graphics Gems,
// 1990) at the tolerance, and the runs are put back together.
//
// A run that is ONE original segment is kept verbatim — there is nothing
// to simplify, and a re-fit could only move it. A run that is straight
// to within the tolerance becomes one straight segment.
//
// THE ANGLE is the interior angle at the anchor, in degrees: 180 is a
// straight continuation, 90 a square corner, small is sharp. An anchor is
// kept as a corner when its angle is AT MOST `cornerAngleDeg`; 0 keeps
// none, which is a plain Schneider fit of the whole contour.

import type { AnchorTable, AnchorTriple, Vec2, Vec2Mut } from "./types";
import { evalCubic } from "./bezier";
import { segmentCount, segmentCubic } from "./path-locate";

export interface SimplifyFitOptions {
  /** pt — the largest distance the fitted curve may stray from the
   *  original. */
  tolerance: number;
  /** Degrees, 0–180: anchors whose interior angle is at most this stay
   *  sharp corners. 0 keeps no corners. */
  cornerAngleDeg: number;
  /** Flattening density (default 24). */
  samplesPerSegment?: number;
}

type Cubic = [Vec2Mut, Vec2Mut, Vec2Mut, Vec2Mut];

const sub = (a: Vec2, b: Vec2): Vec2Mut => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec2, b: Vec2): Vec2Mut => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Vec2, k: number): Vec2Mut => [a[0] * k, a[1] * k];
const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
const len = (a: Vec2): number => Math.hypot(a[0], a[1]);
const same = (a: Vec2, b: Vec2): boolean => a[0] === b[0] && a[1] === b[1];
const unit = (a: Vec2): Vec2Mut => {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l] : [0, 0];
};

/** The direction the contour LEAVES anchor `i` in (unit; zero when the
 *  segment is degenerate). */
function outgoing(
  anchors: readonly AnchorTriple[],
  closed: boolean,
  i: number,
): Vec2Mut {
  const n = anchors.length;
  if (!closed && i >= n - 1) return [0, 0];
  const [p0, p1, p2, p3] = segmentCubic(anchors, i);
  for (const q of [p1, p2, p3]) if (!same(q, p0)) return unit(sub(q, p0));
  return [0, 0];
}

/** The direction the contour ARRIVES at anchor `i` in (unit). */
function incoming(
  anchors: readonly AnchorTriple[],
  closed: boolean,
  i: number,
): Vec2Mut {
  const n = anchors.length;
  if (!closed && i === 0) return [0, 0];
  const prev = (i - 1 + n) % n;
  const [p0, p1, p2, p3] = segmentCubic(anchors, prev);
  for (const q of [p2, p1, p0]) if (!same(q, p3)) return unit(sub(p3, q));
  return [0, 0];
}

/** The interior angle at anchor `i`, degrees: 180 = straight on, 0 = the
 *  path doubles back. An open contour's endpoints answer 180. */
export function interiorAngleAt(
  anchors: readonly AnchorTriple[],
  closed: boolean,
  i: number,
): number {
  const tin = incoming(anchors, closed, i);
  const tout = outgoing(anchors, closed, i);
  if (len(tin) === 0 || len(tout) === 0) return 180;
  const c = Math.max(-1, Math.min(1, dot(tin, tout)));
  // The turn between the two directions; the interior angle is its
  // supplement.
  return 180 - (Math.acos(c) * 180) / Math.PI;
}

// ------------------------------------------------------------ Schneider

function bez(c: Cubic, t: number): Vec2Mut {
  return evalCubic(c[0], c[1], c[2], c[3], t);
}

function bezDeriv1(c: Cubic, t: number): Vec2Mut {
  const u = 1 - t;
  const a = mul(sub(c[1], c[0]), 3 * u * u);
  const b = mul(sub(c[2], c[1]), 6 * u * t);
  const d = mul(sub(c[3], c[2]), 3 * t * t);
  return add(add(a, b), d);
}

function bezDeriv2(c: Cubic, t: number): Vec2Mut {
  const u = 1 - t;
  const a = mul(add(sub(c[2], mul(c[1], 2)), c[0]), 6 * u);
  const b = mul(add(sub(c[3], mul(c[2], 2)), c[1]), 6 * t);
  return add(a, b);
}

function chordParams(d: readonly Vec2[], first: number, last: number) {
  const u = [0];
  for (let i = first + 1; i <= last; i++)
    u.push(u[u.length - 1]! + len(sub(d[i]!, d[i - 1]!)));
  const total = u[u.length - 1]!;
  return total > 0 ? u.map((x) => x / total) : u.map((_, i) => i / (u.length - 1));
}

function generate(
  d: readonly Vec2[],
  first: number,
  last: number,
  u: readonly number[],
  tHat1: Vec2,
  tHat2: Vec2,
): Cubic {
  const p0 = d[first]!;
  const p3 = d[last]!;
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 0; i < u.length; i++) {
    const t = u[i]!;
    const b0 = (1 - t) ** 3;
    const b1 = 3 * t * (1 - t) ** 2;
    const b2 = 3 * t * t * (1 - t);
    const b3 = t ** 3;
    const a1 = mul(tHat1, b1);
    const a2 = mul(tHat2, b2);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(
      d[first + i]!,
      add(add(mul(p0, b0), mul(p0, b1)), add(mul(p3, b2), mul(p3, b3))),
    );
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let alpha1 = det !== 0 ? (x0 * c11 - x1 * c01) / det : 0;
  let alpha2 = det !== 0 ? (c00 * x1 - c01 * x0) / det : 0;
  const segLen = len(sub(p3, p0));
  const eps = 1e-6 * segLen;
  if (alpha1 < eps || alpha2 < eps) {
    alpha1 = segLen / 3;
    alpha2 = segLen / 3;
  }
  return [
    [p0[0], p0[1]],
    add(p0, mul(tHat1, alpha1)),
    add(p3, mul(tHat2, alpha2)),
    [p3[0], p3[1]],
  ];
}

function maxError(
  d: readonly Vec2[],
  first: number,
  last: number,
  c: Cubic,
  u: readonly number[],
): { error: number; split: number } {
  let error = 0;
  let split = Math.floor((first + last) / 2);
  for (let i = first + 1; i < last; i++) {
    const p = bez(c, u[i - first]!);
    const e = sub(p, d[i]!);
    const dist = dot(e, e);
    if (dist >= error) {
      error = dist;
      split = i;
    }
  }
  return { error, split };
}

function reparameterize(
  d: readonly Vec2[],
  first: number,
  c: Cubic,
  u: readonly number[],
): number[] {
  return u.map((t, i) => {
    const p = d[first + i]!;
    const q = bez(c, t);
    const q1 = bezDeriv1(c, t);
    const q2 = bezDeriv2(c, t);
    const num = dot(sub(q, p), q1);
    const den = dot(q1, q1) + dot(sub(q, p), q2);
    if (den === 0) return t;
    return Math.max(0, Math.min(1, t - num / den));
  });
}

function fitCubic(
  d: readonly Vec2[],
  first: number,
  last: number,
  tHat1: Vec2,
  tHat2: Vec2,
  errorSq: number,
  out: Cubic[],
  depth: number,
): void {
  if (last - first === 1 || depth > 24) {
    const dist = len(sub(d[last]!, d[first]!)) / 3;
    out.push([
      [d[first]![0], d[first]![1]],
      add(d[first]!, mul(tHat1, dist)),
      add(d[last]!, mul(tHat2, dist)),
      [d[last]![0], d[last]![1]],
    ]);
    return;
  }
  let u = chordParams(d, first, last);
  let c = generate(d, first, last, u, tHat1, tHat2);
  let { error, split } = maxError(d, first, last, c, u);
  if (error < errorSq) {
    out.push(c);
    return;
  }
  if (error < errorSq * 4) {
    for (let k = 0; k < 4; k++) {
      u = reparameterize(d, first, c, u);
      c = generate(d, first, last, u, tHat1, tHat2);
      ({ error, split } = maxError(d, first, last, c, u));
      if (error < errorSq) {
        out.push(c);
        return;
      }
    }
  }
  split = Math.max(first + 1, Math.min(last - 1, split));
  let centre = unit(sub(d[split - 1]!, d[split + 1]!));
  if (len(centre) === 0) centre = unit(sub(d[first]!, d[last]!));
  fitCubic(d, first, split, tHat1, centre, errorSq, out, depth + 1);
  fitCubic(d, split, last, mul(centre, -1), tHat2, errorSq, out, depth + 1);
}

/** Schneider's fit of `points` at `tolerance`, starting in direction
 *  `tHat1` and arriving from direction `-tHat2` (both unit; a zero one
 *  is estimated from the points). */
export function fitCubics(
  points: readonly Vec2[],
  tolerance: number,
  tHat1?: Vec2,
  tHat2?: Vec2,
): Cubic[] {
  const n = points.length;
  if (n < 2) return [];
  const t1 =
    tHat1 && len(tHat1) > 0 ? tHat1 : unit(sub(points[1]!, points[0]!));
  const t2 =
    tHat2 && len(tHat2) > 0
      ? tHat2
      : unit(sub(points[n - 2]!, points[n - 1]!));
  const out: Cubic[] = [];
  fitCubic(points, 0, n - 1, t1, t2, tolerance * tolerance, out, 0);
  return out;
}

// --------------------------------------------------------- the contour

/** Is every point within `tol` of the chord from first to last? */
function straightWithin(points: readonly Vec2[], tol: number): boolean {
  const a = points[0]!;
  const b = points[points.length - 1]!;
  const ab = sub(b, a);
  const l = len(ab);
  for (const p of points) {
    const d =
      l > 0
        ? Math.abs(ab[0] * (p[1] - a[1]) - ab[1] * (p[0] - a[0])) / l
        : len(sub(p, a));
    if (d > tol) return false;
  }
  return true;
}

/** The cubics of one run of the contour — original segments `from`
 *  (anchor index) for `count` segments. */
function fitRun(
  anchors: readonly AnchorTriple[],
  closed: boolean,
  from: number,
  count: number,
  tolerance: number,
  samples: number,
  smoothStart: Vec2 | null,
): Cubic[] {
  const segs = segmentCount(anchors.length, closed);
  if (count === 1) {
    const [p0, p1, p2, p3] = segmentCubic(anchors, from % segs);
    return [
      [
        [p0[0], p0[1]],
        [p1[0], p1[1]],
        [p2[0], p2[1]],
        [p3[0], p3[1]],
      ],
    ];
  }
  const points: Vec2Mut[] = [];
  for (let k = 0; k < count; k++) {
    const [p0, p1, p2, p3] = segmentCubic(anchors, (from + k) % segs);
    if (k === 0) points.push([p0[0], p0[1]]);
    for (let s = 1; s <= samples; s++)
      points.push(evalCubic(p0, p1, p2, p3, s / samples));
  }
  if (straightWithin(points, tolerance)) {
    const a = points[0]!;
    const b = points[points.length - 1]!;
    return [[a, [...a], [...b], b]];
  }
  const n = anchors.length;
  const start = from % n;
  const end = (from + count) % n;
  const t1 = smoothStart ?? outgoing(anchors, closed, start);
  const t2 = smoothStart
    ? mul(smoothStart, -1)
    : mul(incoming(anchors, closed, end), -1);
  return fitCubics(points, tolerance, t1, t2);
}

/** Split a single cubic in half (a closed contour needs two anchors). */
function halve(c: Cubic): Cubic[] {
  const m = bez(c, 0.5);
  const s1 = mul(add(c[0], c[1]), 0.5);
  const s12 = mul(add(c[1], c[2]), 0.5);
  const s2 = mul(add(c[2], c[3]), 0.5);
  const l = mul(add(s1, s12), 0.5);
  const r = mul(add(s12, s2), 0.5);
  return [
    [c[0], s1, l, m],
    [m, r, s2, c[3]],
  ];
}

/** Assemble cubics end to end into anchors (closed: the last cubic ends
 *  where the first starts, and that anchor is not repeated). */
function assemble(cubics: readonly Cubic[], closed: boolean): AnchorTriple[] {
  const out: AnchorTriple[] = [];
  const first = cubics[0]!;
  out.push({ anchor: first[0], left: [...first[0]], right: first[1] });
  for (let i = 1; i < cubics.length; i++) {
    out.push({
      anchor: cubics[i]![0],
      left: cubics[i - 1]![2],
      right: cubics[i]![1],
    });
  }
  const last = cubics[cubics.length - 1]!;
  if (closed) out[0]!.left = last[2];
  else out.push({ anchor: last[3], left: last[2], right: [...last[3]] });
  return out;
}

/** One contour, simplified (see the module header). */
export function simplifyContour(
  anchors: readonly AnchorTriple[],
  closed: boolean,
  options: SimplifyFitOptions,
): AnchorTriple[] {
  const n = anchors.length;
  const segs = segmentCount(n, closed);
  const tol = Math.max(1e-6, options.tolerance);
  const samples = options.samplesPerSegment ?? 24;
  if (segs < 2) return anchors.map(copyTriple);
  const threshold = Math.max(0, Math.min(180, options.cornerAngleDeg));
  const breaks: number[] = [];
  for (let i = 0; i < n; i++) {
    const end = !closed && (i === 0 || i === n - 1);
    if (end || (threshold > 0 && interiorAngleAt(anchors, closed, i) <= threshold))
      breaks.push(i);
  }
  const cubics: Cubic[] = [];
  if (closed && breaks.length === 0) {
    // One smooth run all the way round, cut at anchor 0 with ONE
    // tangent on both sides so the seam stays smooth.
    const tin = incoming(anchors, true, 0);
    const tout = outgoing(anchors, true, 0);
    const smooth = unit(add(tin, tout));
    const run = fitRun(anchors, true, 0, segs, tol, samples, len(smooth) ? smooth : tout);
    cubics.push(...run);
  } else {
    const runs = closed ? breaks.length : breaks.length - 1;
    for (let r = 0; r < runs; r++) {
      const from = breaks[r]!;
      const to = r + 1 < breaks.length ? breaks[r + 1]! : breaks[0]! + n;
      cubics.push(...fitRun(anchors, closed, from, to - from, tol, samples, null));
    }
  }
  if (closed && cubics.length === 1) cubics.splice(0, 1, ...halve(cubics[0]!));
  const out = assemble(cubics, closed);
  // A simplify never ADDS anchors: when the fit needs more than the
  // contour has (a few long straight edges re-fitted smooth round their
  // corners), the contour is already as simple as this tolerance allows.
  return out.length > n ? anchors.map(copyTriple) : out;
}

function copyTriple(a: AnchorTriple): AnchorTriple {
  return {
    anchor: [a.anchor[0], a.anchor[1]],
    left: [a.left[0], a.left[1]],
    right: [a.right[0], a.right[1]],
  };
}

/** Every contour of `table` simplified; open flags and contour order
 *  kept. */
export function simplifyAnchorTable(
  table: AnchorTable,
  options: SimplifyFitOptions,
): AnchorTable {
  const n = table.anchors.length;
  const starts = table.subpathStarts.length > 0 ? table.subpathStarts : [0];
  const anchors: AnchorTriple[] = [];
  const subpathStarts: number[] = [];
  const subpathOpen: boolean[] = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s]!;
    const to = s + 1 < starts.length ? starts[s + 1]! : n;
    if (to <= from) continue;
    const open = table.subpathOpen?.[s] ?? false;
    const run = simplifyContour(table.anchors.slice(from, to), !open, options);
    subpathStarts.push(anchors.length);
    subpathOpen.push(open);
    anchors.push(...run);
  }
  return { anchors, subpathStarts, subpathOpen };
}
