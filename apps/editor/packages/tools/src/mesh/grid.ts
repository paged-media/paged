/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// The Mesh tool's maths over one grid of a gradient mesh (engine ADR
// 1048). Pure: every edit returns a NEW grid, so a handler can preview a
// drag on a copy and commit the copy as one whole-value write.
//
// A patch (r, c) is the Coons patch of its four edge cubics: the top edge
// runs node(r,c).point → .right handle → node(r,c+1).left handle → point,
// the left edge node(r,c).point → .down → node(r+1,c).up → point, and the
// two others likewise. Its interior control points follow from the edges
// (`coonsInterior`), which is exactly how the engine fills them, so the
// surface `S(u,v) = Σi Σj P[i][j]·B_i(v)·B_j(u)` evaluated here is the one
// the engine draws.
//
// Inserting a mesh point keeps the surface: a Coons patch restricted to a
// sub-rectangle of its parameters is the Coons patch of the restricted
// edges, so cutting every patch of a column at `u` (edges split with de
// Casteljau, the new vertical edges the u-isocurves) and every patch of a
// row at `v` (the v-isocurves) changes the grid and not the picture. The
// colours of the new nodes are the linear blend of their neighbours at
// the cut, which is what the engine's bilinear colour blend shows there.

import {
  cloneColor,
  DOWN,
  LEFT,
  lerpColor,
  RIGHT,
  UP,
  type HandleSlot,
  type InnerBox,
  type MeshColorSpec,
  type MeshGridSpec,
  type MeshNodeSpec,
  type Vec2,
} from "./types";

/** A cubic Bézier: start, two control points, end. */
export type Cubic = [Vec2, Vec2, Vec2, Vec2];
/** A patch's 4×4 control net, `net[i][j]`: i down the rows (v), j across
 *  the columns (u). */
export type Net = Vec2[][];

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function bernstein(t: number): [number, number, number, number] {
  const s = 1 - t;
  return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
}

export function nodeIndex(grid: MeshGridSpec, r: number, c: number): number {
  return r * (grid.cols + 1) + c;
}

export function nodeRowCol(
  grid: MeshGridSpec,
  index: number,
): { r: number; c: number } {
  return { r: Math.floor(index / (grid.cols + 1)), c: index % (grid.cols + 1) };
}

function node(grid: MeshGridSpec, r: number, c: number): MeshNodeSpec {
  return grid.nodes[nodeIndex(grid, r, c)]!;
}

export function cloneNode(n: MeshNodeSpec): MeshNodeSpec {
  return {
    point: [n.point[0], n.point[1]],
    handles: n.handles.map((h) => [h[0], h[1]]) as MeshNodeSpec["handles"],
    color: cloneColor(n.color),
  };
}

export function cloneGrid(grid: MeshGridSpec): MeshGridSpec {
  return {
    rows: grid.rows,
    cols: grid.cols,
    nodes: grid.nodes.map(cloneNode),
    tensor: [],
  };
}

/** True when `grid` is well formed: at least one patch and one node per
 *  grid point (what the engine validates before it accepts a write). */
export function isValidGrid(grid: MeshGridSpec): boolean {
  return (
    Number.isInteger(grid.rows) &&
    Number.isInteger(grid.cols) &&
    grid.rows >= 1 &&
    grid.cols >= 1 &&
    grid.nodes.length === (grid.rows + 1) * (grid.cols + 1)
  );
}

/** A 1×1 grid over the inner box, straight edges (handles at the thirds),
 *  every corner `color` — what the Mesh tool's first click starts from. */
export function boxGrid(box: InnerBox, color: MeshColorSpec): MeshGridSpec {
  const [top, left, bottom, right] = box;
  const tl: Vec2 = [left, top];
  const tr: Vec2 = [right, top];
  const bl: Vec2 = [left, bottom];
  const br: Vec2 = [right, bottom];
  const third = 1 / 3;
  const mk = (p: Vec2, l: Vec2, r: Vec2, u: Vec2, d: Vec2): MeshNodeSpec => ({
    point: p,
    handles: [l, r, u, d],
    color: cloneColor(color),
  });
  return {
    rows: 1,
    cols: 1,
    nodes: [
      mk(tl, tl, lerp(tl, tr, third), tl, lerp(tl, bl, third)),
      mk(tr, lerp(tr, tl, third), tr, tr, lerp(tr, br, third)),
      mk(bl, bl, lerp(bl, br, third), lerp(bl, tl, third), bl),
      mk(br, lerp(br, bl, third), br, lerp(br, tr, third), br),
    ],
    tensor: [],
  };
}

/** The four interior points of a Coons patch from its twelve edge points
 *  (the engine's formula, ADR 1048). */
export function coonsInterior(P: Net): void {
  const comb = (terms: Array<[number, Vec2]>): Vec2 => {
    let x = 0;
    let y = 0;
    for (const [k, p] of terms) {
      x += k * p[0];
      y += k * p[1];
    }
    return [x / 9, y / 9];
  };
  const p = (i: number, j: number) => P[i]![j]!;
  P[1]![1] = comb([
    [-4, p(0, 0)],
    [6, p(0, 1)],
    [6, p(1, 0)],
    [-2, p(0, 3)],
    [-2, p(3, 0)],
    [3, p(3, 1)],
    [3, p(1, 3)],
    [-1, p(3, 3)],
  ]);
  P[1]![2] = comb([
    [-4, p(0, 3)],
    [6, p(0, 2)],
    [6, p(1, 3)],
    [-2, p(0, 0)],
    [-2, p(3, 3)],
    [3, p(3, 2)],
    [3, p(1, 0)],
    [-1, p(3, 0)],
  ]);
  P[2]![1] = comb([
    [-4, p(3, 0)],
    [6, p(3, 1)],
    [6, p(2, 0)],
    [-2, p(3, 3)],
    [-2, p(0, 0)],
    [3, p(0, 1)],
    [3, p(2, 3)],
    [-1, p(0, 3)],
  ]);
  P[2]![2] = comb([
    [-4, p(3, 3)],
    [6, p(3, 2)],
    [6, p(2, 3)],
    [-2, p(3, 0)],
    [-2, p(0, 3)],
    [3, p(0, 2)],
    [3, p(2, 0)],
    [-1, p(0, 0)],
  ]);
}

/** Patch (r, c)'s control net. */
export function patchNet(grid: MeshGridSpec, r: number, c: number): Net {
  const n00 = node(grid, r, c);
  const n01 = node(grid, r, c + 1);
  const n10 = node(grid, r + 1, c);
  const n11 = node(grid, r + 1, c + 1);
  const z: Vec2 = [0, 0];
  const P: Net = [
    [n00.point, n00.handles[RIGHT], n01.handles[LEFT], n01.point],
    [n00.handles[DOWN], z, z, n01.handles[DOWN]],
    [n10.handles[UP], z, z, n11.handles[UP]],
    [n10.point, n10.handles[RIGHT], n11.handles[LEFT], n11.point],
  ];
  // An imported tensor patch carries its own interior; else Coons.
  const tensor = grid.tensor[r * grid.cols + c];
  if (tensor && tensor.length === 4) {
    P[1]![1] = tensor[0];
    P[1]![2] = tensor[1];
    P[2]![1] = tensor[2];
    P[2]![2] = tensor[3];
  } else coonsInterior(P);
  return P;
}

/** `S(u, v)` of a control net. */
export function evalNet(P: Net, u: number, v: number): Vec2 {
  const bu = bernstein(u);
  const bv = bernstein(v);
  let x = 0;
  let y = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const w = bv[i]! * bu[j]!;
      x += P[i]![j]![0] * w;
      y += P[i]![j]![1] * w;
    }
  }
  return [x, y];
}

/** `S(u, v)` of patch (r, c). */
export function evalPatch(
  grid: MeshGridSpec,
  r: number,
  c: number,
  u: number,
  v: number,
): Vec2 {
  return evalNet(patchNet(grid, r, c), u, v);
}

/** A point of the grid's surface: patch and parameters. */
export interface MeshLocation {
  r: number;
  c: number;
  u: number;
  v: number;
}

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** Newton on `S(u,v) = p` from a start, clamped to the unit square. */
function refine(P: Net, p: Vec2, u0: number, v0: number): [number, number] {
  let u = u0;
  let v = v0;
  const h = 1e-6;
  for (let k = 0; k < 24; k++) {
    const s = evalNet(P, u, v);
    const fx = s[0] - p[0];
    const fy = s[1] - p[1];
    if (Math.hypot(fx, fy) < 1e-9) break;
    const su = sub(evalNet(P, u + h, v), s);
    const sv = sub(evalNet(P, u, v + h), s);
    const a = su[0] / h;
    const b = sv[0] / h;
    const c = su[1] / h;
    const d = sv[1] / h;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-12) break;
    const du = (d * fx - b * fy) / det;
    const dv = (-c * fx + a * fy) / det;
    u = clamp01(u - du);
    v = clamp01(v - dv);
  }
  return [u, v];
}

/**
 * Where `p` (inner coordinates) lies on the grid's surface, or null when
 * it is outside every patch. Each patch is sampled on a coarse lattice,
 * the nearest sample refined with Newton; a patch whose refined point
 * misses `p` by more than `tolerance` does not contain it. Patches paint
 * in order, later over earlier, so where the surface folds the LAST
 * patch that holds `p` answers, as the drawing shows.
 */
export function locate(
  grid: MeshGridSpec,
  p: Vec2,
  tolerance = 1e-3,
): MeshLocation | null {
  const N = 10;
  let found: MeshLocation | null = null;
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const P = patchNet(grid, r, c);
      let best = Infinity;
      let bu = 0.5;
      let bv = 0.5;
      for (let i = 0; i <= N; i++) {
        for (let j = 0; j <= N; j++) {
          const d = dist(evalNet(P, j / N, i / N), p);
          if (d < best) {
            best = d;
            bu = j / N;
            bv = i / N;
          }
        }
      }
      const [u, v] = refine(P, p, bu, bv);
      if (dist(evalNet(P, u, v), p) <= tolerance) found = { r, c, u, v };
    }
  }
  return found;
}

/** de Casteljau: `curve` cut at `t` into its two halves. */
export function splitCubic(curve: Cubic, t: number): [Cubic, Cubic] {
  const [p0, p1, p2, p3] = curve;
  const a = lerp(p0, p1, t);
  const b = lerp(p1, p2, t);
  const c = lerp(p2, p3, t);
  const d = lerp(a, b, t);
  const e = lerp(b, c, t);
  const m = lerp(d, e, t);
  return [
    [p0, a, d, m],
    [m, e, c, p3],
  ];
}

/** The curve of the net at fixed `u`, running down the patch (in v). */
export function isoU(P: Net, u: number): Cubic {
  const bu = bernstein(u);
  return [0, 1, 2, 3].map((i) => {
    let x = 0;
    let y = 0;
    for (let j = 0; j < 4; j++) {
      x += P[i]![j]![0] * bu[j]!;
      y += P[i]![j]![1] * bu[j]!;
    }
    return [x, y] as Vec2;
  }) as Cubic;
}

/** The curve of the net at fixed `v`, running across the patch (in u). */
export function isoV(P: Net, v: number): Cubic {
  const bv = bernstein(v);
  return [0, 1, 2, 3].map((j) => {
    let x = 0;
    let y = 0;
    for (let i = 0; i < 4; i++) {
      x += P[i]![j]![0] * bv[i]!;
      y += P[i]![j]![1] * bv[i]!;
    }
    return [x, y] as Vec2;
  }) as Cubic;
}

/** A new column of nodes through patch column `c` at parameter `u`. */
export function insertColumn(
  grid: MeshGridSpec,
  c: number,
  u: number,
): MeshGridSpec {
  const nets = Array.from({ length: grid.rows }, (_, r) =>
    patchNet(grid, r, c),
  );
  const nodes: MeshNodeSpec[] = [];
  for (let i = 0; i <= grid.rows; i++) {
    const a = cloneNode(node(grid, i, c));
    const b = cloneNode(node(grid, i, c + 1));
    const [L, R] = splitCubic(
      [a.point, a.handles[RIGHT], b.handles[LEFT], b.point],
      u,
    );
    a.handles[RIGHT] = L[1];
    b.handles[LEFT] = R[2];
    const m = L[3];
    const up = i > 0 ? isoU(nets[i - 1]!, u)[2] : m;
    const down = i < grid.rows ? isoU(nets[i]!, u)[1] : m;
    const fresh: MeshNodeSpec = {
      point: [m[0], m[1]],
      handles: [L[2], R[1], [up[0], up[1]], [down[0], down[1]]],
      color: lerpColor(a.color, b.color, u),
    };
    for (let j = 0; j <= grid.cols; j++) {
      if (j === c) nodes.push(a, fresh);
      else if (j === c + 1) nodes.push(b);
      else nodes.push(cloneNode(node(grid, i, j)));
    }
  }
  return { rows: grid.rows, cols: grid.cols + 1, nodes, tensor: [] };
}

/** A new row of nodes through patch row `r` at parameter `v`. */
export function insertRow(
  grid: MeshGridSpec,
  r: number,
  v: number,
): MeshGridSpec {
  const nets = Array.from({ length: grid.cols }, (_, c) =>
    patchNet(grid, r, c),
  );
  const top: MeshNodeSpec[] = [];
  const mid: MeshNodeSpec[] = [];
  const bottom: MeshNodeSpec[] = [];
  for (let j = 0; j <= grid.cols; j++) {
    const a = cloneNode(node(grid, r, j));
    const b = cloneNode(node(grid, r + 1, j));
    const [T, B] = splitCubic(
      [a.point, a.handles[DOWN], b.handles[UP], b.point],
      v,
    );
    a.handles[DOWN] = T[1];
    b.handles[UP] = B[2];
    const m = T[3];
    const left = j > 0 ? isoV(nets[j - 1]!, v)[2] : m;
    const right = j < grid.cols ? isoV(nets[j]!, v)[1] : m;
    top.push(a);
    bottom.push(b);
    mid.push({
      point: [m[0], m[1]],
      handles: [[left[0], left[1]], [right[0], right[1]], T[2], B[1]],
      color: lerpColor(a.color, b.color, v),
    });
  }
  const nodes: MeshNodeSpec[] = [];
  for (let i = 0; i <= grid.rows; i++) {
    if (i === r) nodes.push(...top, ...mid);
    else if (i === r + 1) nodes.push(...bottom);
    else
      for (let j = 0; j <= grid.cols; j++)
        nodes.push(cloneNode(node(grid, i, j)));
  }
  return { rows: grid.rows + 1, cols: grid.cols, nodes, tensor: [] };
}

/** How near a cut may come to an existing line before it is skipped: a
 *  click on a line adds a point on that line rather than a sliver. */
export const EDGE_EPSILON = 0.02;

/**
 * Add a mesh point at `at`: a column through `at.u` and a row through
 * `at.v`, each skipped when the click sits on an existing line. Returns
 * the new grid and the node at the click, or null when the click is an
 * existing node (both cuts skipped).
 */
export function insertMeshPoint(
  grid: MeshGridSpec,
  at: MeshLocation,
): { grid: MeshGridSpec; node: number } | null {
  let g = grid;
  let col: number;
  if (at.u <= EDGE_EPSILON) col = at.c;
  else if (at.u >= 1 - EDGE_EPSILON) col = at.c + 1;
  else {
    g = insertColumn(g, at.c, at.u);
    col = at.c + 1;
  }
  let row: number;
  if (at.v <= EDGE_EPSILON) row = at.r;
  else if (at.v >= 1 - EDGE_EPSILON) row = at.r + 1;
  else {
    g = insertRow(g, at.r, at.v);
    row = at.r + 1;
  }
  if (g === grid) return null;
  return { grid: g, node: nodeIndex(g, row, col) };
}

/** Move a node, its handles with it. */
export function moveNode(
  grid: MeshGridSpec,
  index: number,
  delta: Vec2,
): MeshGridSpec {
  const g = cloneGrid(grid);
  const n = g.nodes[index];
  if (!n) return g;
  n.point = add(n.point, delta);
  n.handles = n.handles.map((h) => add(h, delta)) as MeshNodeSpec["handles"];
  return g;
}

/** True when a node's handle in `slot` steers an edge (on the outside of
 *  the grid there is no edge in that direction, and the handle stays on
 *  the point). */
export function handleIsLive(
  grid: MeshGridSpec,
  index: number,
  slot: HandleSlot,
): boolean {
  const { r, c } = nodeRowCol(grid, index);
  if (slot === LEFT) return c > 0;
  if (slot === RIGHT) return c < grid.cols;
  if (slot === UP) return r > 0;
  return r < grid.rows;
}

/** Put one handle of a node at `to` (a dead handle is left alone). */
export function setHandle(
  grid: MeshGridSpec,
  index: number,
  slot: HandleSlot,
  to: Vec2,
): MeshGridSpec {
  const g = cloneGrid(grid);
  if (!g.nodes[index] || !handleIsLive(g, index, slot)) return g;
  g.nodes[index]!.handles[slot] = [to[0], to[1]];
  return g;
}

/** Colour the nodes `indices`. */
export function recolorNodes(
  grid: MeshGridSpec,
  indices: readonly number[],
  color: MeshColorSpec,
): MeshGridSpec {
  const g = cloneGrid(grid);
  for (const i of indices) {
    const n = g.nodes[i];
    if (n) n.color = cloneColor(color);
  }
  return g;
}

/** The single cubic two halves came from: the inverse of `splitCubic`.
 *  The cut's parameter is where the middle point divides its two handles
 *  (de Casteljau puts it at `t` between them), so a line this module
 *  inserted comes back out exactly; handles the user turned since give a
 *  close curve with the same ends. */
function joinHalves(
  p0: Vec2,
  a: Vec2,
  mIn: Vec2,
  m: Vec2,
  mOut: Vec2,
  f: Vec2,
  p3: Vec2,
): [Vec2, Vec2] {
  const span = dist(mIn, mOut);
  let t = span > 1e-9 ? dist(mIn, m) / span : 0.5;
  if (!(t > 1e-6 && t < 1 - 1e-6)) {
    const c0 = dist(p0, m);
    const c1 = dist(m, p3);
    t = c0 + c1 > 0 ? c0 / (c0 + c1) : 0.5;
  }
  const p1: Vec2 = t > 1e-9 ? lerp(p0, a, 1 / t) : a;
  const p2: Vec2 = t < 1 - 1e-9 ? lerp(p3, f, 1 / (1 - t)) : f;
  return [p1, p2];
}

/**
 * Remove a node's row and column lines: its column when it is not on the
 * left or right side, its row when it is not on the top or bottom. The
 * merged edges keep their ends; their handles are re-derived so a line
 * the tool just inserted comes back out with the curve it split. Null
 * when no line can go (a corner node).
 */
export function removeNodeLines(
  grid: MeshGridSpec,
  index: number,
): MeshGridSpec | null {
  const { r, c } = nodeRowCol(grid, index);
  let g = grid;
  let changed = false;
  if (c > 0 && c < g.cols) {
    g = removeColumn(g, c);
    changed = true;
  }
  if (r > 0 && r < g.rows) {
    g = removeRow(g, r);
    changed = true;
  }
  return changed ? g : null;
}

function removeColumn(grid: MeshGridSpec, c: number): MeshGridSpec {
  const nodes: MeshNodeSpec[] = [];
  for (let i = 0; i <= grid.rows; i++) {
    const a = cloneNode(node(grid, i, c - 1));
    const m = node(grid, i, c);
    const b = cloneNode(node(grid, i, c + 1));
    const [p1, p2] = joinHalves(
      a.point,
      a.handles[RIGHT],
      m.handles[LEFT],
      m.point,
      m.handles[RIGHT],
      b.handles[LEFT],
      b.point,
    );
    a.handles[RIGHT] = p1;
    b.handles[LEFT] = p2;
    for (let j = 0; j <= grid.cols; j++) {
      if (j === c - 1) nodes.push(a);
      else if (j === c) continue;
      else if (j === c + 1) nodes.push(b);
      else nodes.push(cloneNode(node(grid, i, j)));
    }
  }
  return { rows: grid.rows, cols: grid.cols - 1, nodes, tensor: [] };
}

function removeRow(grid: MeshGridSpec, r: number): MeshGridSpec {
  const nodes: MeshNodeSpec[] = [];
  for (let i = 0; i <= grid.rows; i++) {
    if (i === r) continue;
    for (let j = 0; j <= grid.cols; j++) {
      const n = cloneNode(node(grid, i, j));
      if (i === r - 1 || i === r + 1) {
        const a = node(grid, r - 1, j);
        const m = node(grid, r, j);
        const b = node(grid, r + 1, j);
        const [p1, p2] = joinHalves(
          a.point,
          a.handles[DOWN],
          m.handles[UP],
          m.point,
          m.handles[DOWN],
          b.handles[UP],
          b.point,
        );
        if (i === r - 1) n.handles[DOWN] = p1;
        else n.handles[UP] = p2;
      }
      nodes.push(n);
    }
  }
  return { rows: grid.rows - 1, cols: grid.cols, nodes, tensor: [] };
}

/** Every edge of the grid as a cubic: the row lines, then the columns. */
export function gridEdges(grid: MeshGridSpec): Cubic[] {
  const out: Cubic[] = [];
  for (let i = 0; i <= grid.rows; i++) {
    for (let j = 0; j < grid.cols; j++) {
      const a = node(grid, i, j);
      const b = node(grid, i, j + 1);
      out.push([a.point, a.handles[RIGHT], b.handles[LEFT], b.point]);
    }
  }
  for (let j = 0; j <= grid.cols; j++) {
    for (let i = 0; i < grid.rows; i++) {
      const a = node(grid, i, j);
      const b = node(grid, i + 1, j);
      out.push([a.point, a.handles[DOWN], b.handles[UP], b.point]);
    }
  }
  return out;
}

/** A cubic as `segments + 1` points along it. */
export function sampleCubic(curve: Cubic, segments = 16): Vec2[] {
  const out: Vec2[] = [];
  for (let k = 0; k <= segments; k++) {
    const t = k / segments;
    const b = bernstein(t);
    out.push([
      curve[0][0] * b[0] +
        curve[1][0] * b[1] +
        curve[2][0] * b[2] +
        curve[3][0] * b[3],
      curve[0][1] * b[0] +
        curve[1][1] * b[1] +
        curve[2][1] * b[2] +
        curve[3][1] * b[3],
    ]);
  }
  return out;
}
