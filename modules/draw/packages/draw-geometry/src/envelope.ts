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

// ENVELOPE DISTORT (draw ADR 367) — the geometry of the engine's
// `envelope` effect entry, for the commands that make one and the tool
// that edits one. The engine (`paged-vector-fx::envelope`) draws it: the
// item's tight source box bent through `rows` × `columns` bicubic Bézier
// patches whose control NET is `(3·rows+1) × (3·columns+1)` points,
// row-major, each in the box's unit square. `envelopePoint` is the
// engine's map, written again here for the tool's overlay and hit tests
// (the engine is the one that draws; this only shows where).
//
// A NODE is a patch corner (net row and column both multiples of 3); its
// HANDLES are the net points one step away along the mesh lines, and a
// node drag carries them along, as Illustrator's envelope mesh does.

import { closestTOnCubic, evalCubic } from "./bezier";
import type { AnchorTriple, Vec2, Vec2Mut } from "./types";

/** A control net, row-major, in the box's unit square. */
export type EnvelopeNet = Vec2Mut[];

/** An axis-aligned box: `x`, `y` its top left. */
export interface EnvelopeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Illustrator's limit on either side of an envelope mesh. */
export const ENVELOPE_MAX_CELLS = 50;

/** The control points a `rows` × `columns` net holds. */
export const netLength = (rows: number, columns: number) =>
  (3 * rows + 1) * (3 * columns + 1);

/** The net index of row `i`, column `j` (control-point coordinates). */
export const netIndex = (columns: number, i: number, j: number) =>
  i * (3 * columns + 1) + j;

/** The flat net: the item as drawn. */
export function flatNet(rows: number, columns: number): EnvelopeNet {
  const nr = 3 * rows;
  const nc = 3 * columns;
  const out: EnvelopeNet = [];
  for (let i = 0; i <= nr; i++)
    for (let j = 0; j <= nc; j++) out.push([j / nc, i / nr]);
  return out;
}

/** Whether `net` is a whole `rows` × `columns` net of finite points. */
export function isNet(
  net: readonly Vec2[] | null | undefined,
  rows: number,
  columns: number,
): net is EnvelopeNet {
  return (
    Array.isArray(net) &&
    net.length === netLength(rows, columns) &&
    net.every(
      (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]),
    )
  );
}

function bernstein(t: number): [number, number, number, number] {
  const s = 1 - t;
  return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
}

/** The engine's map: `(u, v)` of the box's unit square to where the
 *  envelope sends it, in the unit square. */
export function envelopePoint(
  net: readonly Vec2[],
  rows: number,
  columns: number,
  u: number,
  v: number,
): Vec2Mut {
  const cell = (t: number, n: number): [number, number] => {
    const x = t * n;
    const i = Math.min(n - 1, Math.max(0, Math.floor(x)));
    return [i, x - i];
  };
  const [c, s] = cell(u, columns);
  const [r, t] = cell(v, rows);
  const bu = bernstein(s);
  const bv = bernstein(t);
  let x = 0;
  let y = 0;
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      const p = net[netIndex(columns, 3 * r + i, 3 * c + j)]!;
      const w = bv[i]! * bu[j]!;
      x += w * p[0];
      y += w * p[1];
    }
  return [x, y];
}

/** From the unit square to the box, and back. */
export const fromUnit = (b: EnvelopeBox, p: Vec2): Vec2Mut => [
  b.x + p[0] * b.w,
  b.y + p[1] * b.h,
];
export const toUnit = (b: EnvelopeBox, p: Vec2): Vec2Mut => [
  (p[0] - b.x) / b.w,
  (p[1] - b.y) / b.h,
];

/** The handles of node `(r, c)` (patch-corner coordinates): the net
 *  points one step along the mesh lines that meet there. */
export function nodeHandles(
  rows: number,
  columns: number,
  r: number,
  c: number,
): number[] {
  const i = 3 * r;
  const j = 3 * c;
  const out: number[] = [];
  if (i > 0) out.push(netIndex(columns, i - 1, j));
  if (i < 3 * rows) out.push(netIndex(columns, i + 1, j));
  if (j > 0) out.push(netIndex(columns, i, j - 1));
  if (j < 3 * columns) out.push(netIndex(columns, i, j + 1));
  return out;
}

/** Move control point `index` to `to`; a node carries its handles. */
export function moveNetPoint(
  net: readonly Vec2[],
  rows: number,
  columns: number,
  index: number,
  to: Vec2,
): EnvelopeNet {
  const out: EnvelopeNet = net.map((p) => [p[0], p[1]]);
  const from = net[index];
  if (!from) return out;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  out[index] = [to[0], to[1]];
  const stride = 3 * columns + 1;
  const i = Math.floor(index / stride);
  const j = index % stride;
  if (i % 3 === 0 && j % 3 === 0)
    for (const h of nodeHandles(rows, columns, i / 3, j / 3)) {
      const p = out[h]!;
      out[h] = [p[0] + dx, p[1] + dy];
    }
  return out;
}

/** The cubic `p` restricted to `[a, b]` (de Casteljau, twice). */
export function restrictCubic(
  p: readonly [Vec2, Vec2, Vec2, Vec2],
  a: number,
  b: number,
): [Vec2Mut, Vec2Mut, Vec2Mut, Vec2Mut] {
  const lerp = (x: Vec2, y: Vec2, t: number): Vec2Mut => [
    x[0] + (y[0] - x[0]) * t,
    x[1] + (y[1] - x[1]) * t,
  ];
  const split = (
    q: readonly [Vec2, Vec2, Vec2, Vec2],
    t: number,
  ): [
    [Vec2Mut, Vec2Mut, Vec2Mut, Vec2Mut],
    [Vec2Mut, Vec2Mut, Vec2Mut, Vec2Mut],
  ] => {
    const p01 = lerp(q[0], q[1], t);
    const p12 = lerp(q[1], q[2], t);
    const p23 = lerp(q[2], q[3], t);
    const p012 = lerp(p01, p12, t);
    const p123 = lerp(p12, p23, t);
    const m = lerp(p012, p123, t);
    return [
      [[q[0][0], q[0][1]], p01, p012, m],
      [m, p123, p23, [q[3][0], q[3][1]]],
    ];
  };
  // [0, b] first, then the part of it from a.
  const left =
    b >= 1
      ? (p.map((q) => [q[0], q[1]]) as [Vec2Mut, Vec2Mut, Vec2Mut, Vec2Mut])
      : split(p, b)[0];
  if (a <= 0) return left;
  return split(left, b <= 0 ? 0 : a / b)[1];
}

/** A one-cell (16-point) net restricted to `[u0, u1] × [v0, v1]` of its
 *  own square: the patch over a part of the box. */
export function restrictPatch(
  net16: readonly Vec2[],
  u0: number,
  u1: number,
  v0: number,
  v1: number,
): EnvelopeNet {
  const rows: Vec2Mut[][] = [];
  for (let i = 0; i < 4; i++) {
    const row: [Vec2, Vec2, Vec2, Vec2] = [
      net16[i * 4]!,
      net16[i * 4 + 1]!,
      net16[i * 4 + 2]!,
      net16[i * 4 + 3]!,
    ];
    rows.push(restrictCubic(row, u0, u1));
  }
  const out: EnvelopeNet = new Array(16);
  for (let j = 0; j < 4; j++) {
    const col: [Vec2, Vec2, Vec2, Vec2] = [
      rows[0]![j]!,
      rows[1]![j]!,
      rows[2]![j]!,
      rows[3]![j]!,
    ];
    const r = restrictCubic(col, v0, v1);
    for (let i = 0; i < 4; i++) out[i * 4 + j] = r[i]!;
  }
  return out;
}

/** The bicubic patch whose boundary is the four cubics (each given from
 *  its first corner: `top` top-left → top-right, `bottom` bottom-left →
 *  bottom-right, `left` top-left → bottom-left, `right` top-right →
 *  bottom-right) and whose inside is their bilinearly blended Coons
 *  patch — exact, because a Coons patch over cubic edges is bicubic. */
export function coonsPatch(
  top: readonly [Vec2, Vec2, Vec2, Vec2],
  right: readonly [Vec2, Vec2, Vec2, Vec2],
  bottom: readonly [Vec2, Vec2, Vec2, Vec2],
  left: readonly [Vec2, Vec2, Vec2, Vec2],
): EnvelopeNet {
  const out: EnvelopeNet = new Array(16);
  const P = (i: number, j: number): Vec2 => {
    if (i === 0) return top[j]!;
    if (i === 3) return bottom[j]!;
    if (j === 0) return left[i]!;
    return right[i]!;
  };
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      if (i === 0 || i === 3 || j === 0 || j === 3) {
        const p = P(i, j);
        out[i * 4 + j] = [p[0], p[1]];
        continue;
      }
      const u = j / 3;
      const v = i / 3;
      const c00 = top[0]!;
      const c03 = top[3]!;
      const c30 = bottom[0]!;
      const c33 = bottom[3]!;
      const x =
        (1 - v) * top[j]![0] +
        v * bottom[j]![0] +
        (1 - u) * left[i]![0] +
        u * right[i]![0] -
        ((1 - u) * (1 - v) * c00[0] +
          u * (1 - v) * c03[0] +
          (1 - u) * v * c30[0] +
          u * v * c33[0]);
      const y =
        (1 - v) * top[j]![1] +
        v * bottom[j]![1] +
        (1 - u) * left[i]![1] +
        u * right[i]![1] -
        ((1 - u) * (1 - v) * c00[1] +
          u * (1 - v) * c03[1] +
          (1 - u) * v * c30[1] +
          u * v * c33[1]);
      out[i * 4 + j] = [x, y];
    }
  return out;
}

/** The cubic through `points` (first and last kept), least squares over
 *  chord-length parameters. Two points make a straight line. */
export function fitCubicEnds(
  points: readonly Vec2[],
): [Vec2Mut, Vec2Mut, Vec2Mut, Vec2Mut] {
  const n = points.length;
  const p0 = points[0]!;
  const p3 = points[n - 1]!;
  const line = (): [Vec2Mut, Vec2Mut, Vec2Mut, Vec2Mut] => [
    [p0[0], p0[1]],
    [p0[0] + (p3[0] - p0[0]) / 3, p0[1] + (p3[1] - p0[1]) / 3],
    [p0[0] + (2 * (p3[0] - p0[0])) / 3, p0[1] + (2 * (p3[1] - p0[1])) / 3],
    [p3[0], p3[1]],
  ];
  if (n < 3) return line();
  const d: number[] = [0];
  for (let k = 1; k < n; k++)
    d.push(
      d[k - 1]! +
        Math.hypot(
          points[k]![0] - points[k - 1]![0],
          points[k]![1] - points[k - 1]![1],
        ),
    );
  const total = d[n - 1]!;
  if (total <= 0) return line();
  // Chord-length parameters first, then each point re-projected onto the
  // fitted curve and the fit solved again (Schneider's reparametrisation).
  let ts = d.map((x) => x / total);
  let fit = solveInner(points, ts);
  if (!fit) return line();
  for (let round = 0; round < 40; round++) {
    const [a, b] = fit;
    ts = points.map((p, k) =>
      k === 0 || k === n - 1 ? k / (n - 1) : closestTOnCubic(p0, a, b, p3, p),
    );
    const next = solveInner(points, ts);
    if (!next) break;
    fit = next;
  }
  return [[p0[0], p0[1]], fit[0], fit[1], [p3[0], p3[1]]];
}

/** The least-squares inner control points of the cubic from the first to
 *  the last of `points`, at parameters `ts`. */
function solveInner(
  points: readonly Vec2[],
  ts: readonly number[],
): [Vec2Mut, Vec2Mut] | null {
  const n = points.length;
  const p0 = points[0]!;
  const p3 = points[n - 1]!;
  let a11 = 0;
  let a12 = 0;
  let a22 = 0;
  const r1: Vec2Mut = [0, 0];
  const r2: Vec2Mut = [0, 0];
  for (let k = 0; k < n; k++) {
    const [b0, b1, b2, b3] = bernstein(ts[k]!);
    a11 += b1 * b1;
    a12 += b1 * b2;
    a22 += b2 * b2;
    for (const c of [0, 1] as const) {
      const rest = points[k]![c] - b0 * p0[c] - b3 * p3[c];
      r1[c] += b1 * rest;
      r2[c] += b2 * rest;
    }
  }
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-12) return null;
  return [
    [(a22 * r1[0] - a12 * r2[0]) / det, (a22 * r1[1] - a12 * r2[1]) / det],
    [(a11 * r2[0] - a12 * r1[0]) / det, (a11 * r2[1] - a12 * r1[1]) / det],
  ];
}

/** A closed outline (its anchor run) flattened densely. */
export function flattenClosed(
  anchors: readonly AnchorTriple[],
  perSegment = 24,
): Vec2Mut[] {
  const out: Vec2Mut[] = [];
  const n = anchors.length;
  for (let k = 0; k < n; k++) {
    const a = anchors[k]!;
    const b = anchors[(k + 1) % n]!;
    for (let s = 0; s < perSegment; s++)
      out.push(evalCubic(a.anchor, a.right, b.left, b.anchor, s / perSegment));
  }
  return out;
}

/** The tight box of an anchor run (closed when `closed`). */
export function runBox(
  anchors: readonly AnchorTriple[],
  closed: boolean,
): EnvelopeBox | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const n = anchors.length;
  const segs = closed ? n : n - 1;
  const take = (p: Vec2) => {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  };
  for (const a of anchors) take(a.anchor);
  for (let k = 0; k < segs; k++) {
    const a = anchors[k]!;
    const b = anchors[(k + 1) % n]!;
    // Sampled finely: the extrema between anchors, to well under a
    // hundredth of a point on any outline a page holds.
    for (let s = 1; s < 64; s++)
      take(evalCubic(a.anchor, a.right, b.left, b.anchor, s / 64));
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** The patch a closed outline describes (Make with Top Object): the
 *  outline is cut at four corners into four sides, each side fitted by
 *  one cubic (kept exactly when it is one segment), and the inside
 *  blended (`coonsPatch`). The corners are the outline's own anchors
 *  nearest its box's corners when those are four different anchors in
 *  turn (a rectangle, a trapezoid, any quadrilateral-like shape); else the
 *  points of the outline nearest the box's corners (an ellipse, a blob).
 *  In the outline's own coordinates; null when it has no area. */
export function outlinePatch(
  anchors: readonly AnchorTriple[],
): EnvelopeNet | null {
  const box = runBox(anchors, true);
  if (!box || box.w <= 1e-6 || box.h <= 1e-6) return null;
  const PER = 24;
  // Turn the outline clockwise on the page (y down): positive shoelace.
  let run = anchors.map((a) => ({
    anchor: a.anchor,
    left: a.left,
    right: a.right,
  }));
  {
    const pts = flattenClosed(run, PER);
    let area = 0;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k]!;
      const q = pts[(k + 1) % pts.length]!;
      area += p[0] * q[1] - q[0] * p[1];
    }
    if (area < 0)
      run = run
        .slice()
        .reverse()
        .map((a) => ({ anchor: a.anchor, left: a.right, right: a.left }));
  }
  const pts = flattenClosed(run, PER);
  const n = pts.length;
  const targets: Vec2[] = [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x + box.w, box.y + box.h],
    [box.x, box.y + box.h],
  ];
  const nearestOf = (cands: readonly Vec2[], c: Vec2) => {
    let best = 0;
    let bd = Infinity;
    cands.forEach((p, k) => {
      const d = Math.hypot(p[0] - c[0], p[1] - c[1]);
      if (d < bd - 1e-9) {
        bd = d;
        best = k;
      }
    });
    return best;
  };
  // The anchors first: four different ones, in turn round the outline.
  const byAnchor = targets.map((c) =>
    nearestOf(
      run.map((a) => a.anchor),
      c,
    ),
  );
  const m = run.length;
  const inTurn = (ix: readonly number[]) => {
    if (new Set(ix).size !== 4) return false;
    // Each next corner is reached going forward, and the four steps
    // together go round once.
    let total = 0;
    for (let k = 0; k < 4; k++) total += (ix[(k + 1) % 4]! - ix[k]! + m) % m;
    return total === m;
  };
  let corners: number[];
  const exact: (readonly [Vec2, Vec2, Vec2, Vec2] | null)[] = [
    null,
    null,
    null,
    null,
  ];
  if (inTurn(byAnchor)) {
    corners = byAnchor.map((k) => k * PER);
    for (let k = 0; k < 4; k++) {
      const from = byAnchor[k]!;
      const to = byAnchor[(k + 1) % 4]!;
      if ((to - from + m) % m === 1) {
        const a = run[from]!;
        const b = run[to]!;
        exact[k] = [a.anchor, a.right, b.left, b.anchor];
      }
    }
  } else {
    corners = targets.map((c) => nearestOf(pts, c));
  }
  const side = (k: number): [Vec2Mut, Vec2Mut, Vec2Mut, Vec2Mut] => {
    const e = exact[k];
    if (e)
      return e.map((p): Vec2Mut => [p[0], p[1]]) as [
        Vec2Mut,
        Vec2Mut,
        Vec2Mut,
        Vec2Mut,
      ];
    const from = corners[k]!;
    const to = corners[(k + 1) % 4]!;
    const out: Vec2Mut[] = [];
    for (let i = from; ; i = (i + 1) % n) {
      out.push(pts[i]!);
      if (i === to) break;
    }
    return fitCubicEnds(out);
  };
  const rev = (
    c: [Vec2Mut, Vec2Mut, Vec2Mut, Vec2Mut],
  ): [Vec2Mut, Vec2Mut, Vec2Mut, Vec2Mut] => [c[3], c[2], c[1], c[0]];
  // Clockwise on the page: top left → top right → bottom right → bottom left.
  const top = side(0);
  const right = side(1);
  const bottom = rev(side(2));
  const left = rev(side(3));
  return coonsPatch(top, right, bottom, left);
}

/** The mesh lines of a net (every patch edge), each as a polyline of
 *  `samples + 1` points in the unit square — what the tool draws. */
export function meshLines(
  net: readonly Vec2[],
  rows: number,
  columns: number,
  samples = 16,
): Vec2Mut[][] {
  const out: Vec2Mut[][] = [];
  for (let r = 0; r <= rows; r++) {
    const line: Vec2Mut[] = [];
    for (let s = 0; s <= samples * columns; s++)
      line.push(
        envelopePoint(net, rows, columns, s / (samples * columns), r / rows),
      );
    out.push(line);
  }
  for (let c = 0; c <= columns; c++) {
    const line: Vec2Mut[] = [];
    for (let s = 0; s <= samples * rows; s++)
      line.push(
        envelopePoint(net, rows, columns, c / columns, s / (samples * rows)),
      );
    out.push(line);
  }
  return out;
}

/** Split column `c` of the net at `s` (0..1 within it): one column more,
 *  the same surface (Illustrator's mesh tool adding a mesh line). */
export function splitColumn(
  net: readonly Vec2[],
  rows: number,
  columns: number,
  c: number,
  s: number,
): EnvelopeNet {
  const nr = 3 * rows;
  const out: EnvelopeNet = [];
  for (let i = 0; i <= nr; i++) {
    const row = net.slice(
      netIndex(columns, i, 0),
      netIndex(columns, i, 3 * columns) + 1,
    );
    const seg = row.slice(3 * c, 3 * c + 4) as unknown as [
      Vec2,
      Vec2,
      Vec2,
      Vec2,
    ];
    const a = restrictCubic(seg, 0, s);
    const b = restrictCubic(seg, s, 1);
    out.push(
      ...row.slice(0, 3 * c).map((p): Vec2Mut => [p[0], p[1]]),
      ...a,
      ...b.slice(1),
      ...row.slice(3 * c + 4).map((p): Vec2Mut => [p[0], p[1]]),
    );
  }
  return out;
}

/** Split row `r` of the net at `t`: one row more, the same surface. */
export function splitRow(
  net: readonly Vec2[],
  rows: number,
  columns: number,
  r: number,
  t: number,
): EnvelopeNet {
  // The transposed net's column split.
  const nc = 3 * columns;
  const nr = 3 * rows;
  const tr: Vec2Mut[] = [];
  for (let j = 0; j <= nc; j++)
    for (let i = 0; i <= nr; i++) {
      const p = net[netIndex(columns, i, j)]!;
      tr.push([p[0], p[1]]);
    }
  const split = splitColumn(tr, columns, rows, r, t);
  const out: EnvelopeNet = [];
  const nr2 = nr + 3;
  for (let i = 0; i <= nr2; i++)
    for (let j = 0; j <= nc; j++) out.push(split[j * (nr2 + 1) + i]!);
  return out;
}

/** Which cell `(r, c)` and where in it `(s, t)` a unit-square point of
 *  the FLAT parameter domain is. */
export function cellOf(
  rows: number,
  columns: number,
  u: number,
  v: number,
): { r: number; c: number; s: number; t: number } {
  const cu = Math.min(columns - 1, Math.max(0, Math.floor(u * columns)));
  const rv = Math.min(rows - 1, Math.max(0, Math.floor(v * rows)));
  return { r: rv, c: cu, s: u * columns - cu, t: v * rows - rv };
}

/** The parameter `(u, v)` whose image is nearest `p` (unit square), by a
 *  coarse search refined by Newton-free bisection — the tool's way from
 *  a click on the bent mesh back to where in the mesh it is. */
export function invertEnvelope(
  net: readonly Vec2[],
  rows: number,
  columns: number,
  p: Vec2,
): { u: number; v: number; distance: number } {
  let best = { u: 0, v: 0, distance: Infinity };
  const n = 8 * Math.max(rows, columns);
  for (let a = 0; a <= n; a++)
    for (let b = 0; b <= n; b++) {
      const q = envelopePoint(net, rows, columns, a / n, b / n);
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < best.distance) best = { u: a / n, v: b / n, distance: d };
    }
  let step = 1 / n;
  for (let k = 0; k < 200 && step > 1e-9; k++) {
    let moved = false;
    for (const [du, dv] of [
      [step, 0],
      [-step, 0],
      [0, step],
      [0, -step],
    ] as const) {
      const u = Math.min(1, Math.max(0, best.u + du));
      const v = Math.min(1, Math.max(0, best.v + dv));
      const q = envelopePoint(net, rows, columns, u, v);
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < best.distance) {
        best = { u, v, distance: d };
        moved = true;
      }
    }
    if (!moved) step /= 2;
  }
  return best;
}
