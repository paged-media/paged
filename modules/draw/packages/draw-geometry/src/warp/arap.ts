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

// AS-RIGID-AS-POSSIBLE — Igarashi, Moscovich and Hughes' two-step solve
// ("As-Rigid-As-Possible Shape Manipulation", SIGGRAPH 2005), the
// deformation behind Puppet Warp.
//
// The mesh (`triangulate.ts`) is the rest shape; some of its vertices are
// PINNED to targets. The deformed vertex positions minimise how far each
// triangle is from a rigid copy of itself, in two linear least-squares
// steps:
//
//   STEP 1 — SCALE-FREE CONSTRUCTION (§4.1). Each triangle edge (i, j)
//   expresses the third vertex k in the edge's own frame:
//   v_k = v_i + x·(v_j − v_i) + y·R90(v_j − v_i). Keeping (x, y) while the
//   vertices move allows each triangle to rotate AND scale freely; the
//   quadratic error over every triangle and edge, plus the pins as soft
//   constraints of weight W, is one 2n × 2n system G v = b.
//
//   STEP 2 — SCALE ADJUSTMENT (§4.2). (a) Every triangle of step 1's
//   result is fitted by a RIGID copy of its rest triangle (the optimal 2-D
//   rotation of the centred rest triangle onto the centred intermediate
//   one, the closed-form Procrustes angle), which takes the scale back
//   out. (b) The final positions minimise the difference between every
//   mesh edge and that edge in its fitted triangle, plus the pins: an
//   n × n system H x = b_x, H y = b_y (x and y separate).
//
// Both matrices depend only on the rest mesh and on WHICH vertices are
// pinned, so they are factored once (dense Cholesky) when the pin set
// changes and every drag sample is two back-substitutions plus the
// per-triangle fit — the paper's "interactive" property.
//
// THE CONSTRAINTS are soft (weight W = 1e4 against coefficients of order
// 1) rather than eliminated, which keeps one code path for any pin set.
// A connected component of the mesh with fewer than two constrained
// vertices would make the system singular, so ITS vertices (and only
// its) are pulled toward their REST position by a weak spring — a
// component with no pin stays where it was. Fewer than two pins in all
// cannot constrain a similarity: zero pins is the identity, one pin
// translates (and turns, when the pin carries an angle).
//
// PIN ROTATION. A pin may carry an angle: the vertex one edge away from
// it (its `anchorNeighbour`) is then pinned too, at the pin's target plus
// the rest offset turned by that angle — Illustrator's "rotate around a
// pin".

import type { Vec2, Vec2Mut } from "../types";
import type { TriangleMesh } from "./triangulate";

export interface ArapPin {
  /** Mesh vertex index. */
  vertex: number;
  /** Where it goes (pt). */
  target: Vec2;
  /** Radians; null/undefined = the region round the pin turns freely. */
  angle?: number | null;
}

const W = 1e4;
const SPRING = 1e-3;

/** Dense SPD factorisation, lower triangle, row-major. */
class Cholesky {
  private readonly l: Float64Array;
  constructor(
    private readonly n: number,
    a: Float64Array,
  ) {
    const l = new Float64Array(n * n);
    for (let j = 0; j < n; j++) {
      let d = a[j * n + j]!;
      const rj = j * n;
      for (let k = 0; k < j; k++) d -= l[rj + k]! * l[rj + k]!;
      if (d <= 0) d = 1e-12;
      const djj = Math.sqrt(d);
      l[rj + j] = djj;
      for (let i = j + 1; i < n; i++) {
        const ri = i * n;
        let s = a[ri + j]!;
        for (let k = 0; k < j; k++) s -= l[ri + k]! * l[rj + k]!;
        l[ri + j] = s / djj;
      }
    }
    this.l = l;
  }
  solve(b: Float64Array): Float64Array {
    const n = this.n;
    const l = this.l;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = b[i]!;
      const ri = i * n;
      for (let k = 0; k < i; k++) s -= l[ri + k]! * y[k]!;
      y[i] = s / l[ri + i]!;
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = y[i]!;
      for (let k = i + 1; k < n; k++) s -= l[k * n + i]! * x[k]!;
      x[i] = s / l[i * n + i]!;
    }
    return x;
  }
}

/** Every vertex's neighbours along mesh edges. */
export function meshNeighbours(
  mesh: Pick<TriangleMesh, "vertices" | "triangles">,
): number[][] {
  const nb = mesh.vertices.map(() => new Set<number>());
  for (const t of mesh.triangles)
    for (let e = 0; e < 3; e++) {
      nb[t[e]!]!.add(t[(e + 1) % 3]!);
      nb[t[(e + 1) % 3]!]!.add(t[e]!);
    }
  return nb.map((s) => [...s].sort((a, b) => a - b));
}

/** The neighbour a rotated pin also pins: its farthest one-ring vertex
 *  (the longest lever, the best-conditioned angle). */
export function anchorNeighbour(
  mesh: Pick<TriangleMesh, "vertices" | "triangles">,
  vertex: number,
  neighbours = meshNeighbours(mesh),
): number | null {
  const p = mesh.vertices[vertex]!;
  let best: number | null = null;
  let bestD = -1;
  for (const q of neighbours[vertex] ?? []) {
    const d = Math.hypot(
      mesh.vertices[q]![0] - p[0],
      mesh.vertices[q]![1] - p[1],
    );
    if (d > bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

interface Constraint {
  vertex: number;
  /** Which pin sets the target, and how (offset rotated by its angle). */
  pin: number;
  offset: Vec2 | null;
}

/**
 * The precomputed solver for one rest mesh and one PIN SET. `solve` maps
 * the pins' current targets (in pin order) to the deformed vertices.
 */
export class ArapSolver {
  private readonly n: number;
  private readonly rest: Vec2Mut[];
  private readonly tris: readonly [number, number, number][];
  private readonly edgeCoords: [number, number][][];
  private readonly constraints: Constraint[];
  private readonly g: Cholesky | null;
  private readonly h: Cholesky | null;
  /** Per vertex: the rest-spring weight (0 in a well-pinned component). */
  private readonly spring: Float64Array;

  constructor(
    mesh: Pick<TriangleMesh, "vertices" | "triangles">,
    private readonly pins: readonly ArapPin[],
  ) {
    const n = mesh.vertices.length;
    this.n = n;
    this.rest = mesh.vertices.map((v) => [v[0], v[1]] as Vec2Mut);
    this.tris = mesh.triangles;
    const neighbours = meshNeighbours(mesh);
    // Constraints: each pin's vertex, and a rotated pin's neighbour.
    const seen = new Set<number>();
    const cons: Constraint[] = [];
    pins.forEach((p, i) => {
      if (p.vertex < 0 || p.vertex >= n || seen.has(p.vertex)) return;
      seen.add(p.vertex);
      cons.push({ vertex: p.vertex, pin: i, offset: null });
    });
    pins.forEach((p, i) => {
      if (p.angle === null || p.angle === undefined) return;
      const q = anchorNeighbour(mesh, p.vertex, neighbours);
      if (q === null || seen.has(q)) return;
      seen.add(q);
      const r = this.rest[p.vertex]!;
      cons.push({
        vertex: q,
        pin: i,
        offset: [this.rest[q]![0] - r[0], this.rest[q]![1] - r[1]],
      });
    });
    this.constraints = cons;
    // Components with fewer than two constrained vertices get a spring.
    const comp = new Int32Array(n).fill(-1);
    let nc = 0;
    for (let s0 = 0; s0 < n; s0++) {
      if (comp[s0] !== -1) continue;
      const stack = [s0];
      comp[s0] = nc;
      while (stack.length) {
        const v = stack.pop()!;
        for (const w of neighbours[v]!)
          if (comp[w] === -1) {
            comp[w] = nc;
            stack.push(w);
          }
      }
      nc++;
    }
    const pinned = new Array<number>(nc).fill(0);
    for (const c of cons) pinned[comp[c.vertex]!]!++;
    this.spring = new Float64Array(n);
    for (let v = 0; v < n; v++)
      this.spring[v] = pinned[comp[v]!]! >= 2 ? 0 : SPRING;
    // Rest-frame coordinates of each triangle's third vertex per edge.
    this.edgeCoords = this.tris.map((t) =>
      [0, 1, 2].map((e) => {
        const i = t[e]!;
        const j = t[(e + 1) % 3]!;
        const k = t[(e + 2) % 3]!;
        const vi = this.rest[i]!;
        const d: Vec2 = [this.rest[j]![0] - vi[0], this.rest[j]![1] - vi[1]];
        const ev: Vec2 = [this.rest[k]![0] - vi[0], this.rest[k]![1] - vi[1]];
        const l2 = d[0] * d[0] + d[1] * d[1] || 1e-12;
        const x = (ev[0] * d[0] + ev[1] * d[1]) / l2;
        const y = (ev[0] * d[1] - ev[1] * d[0]) / l2;
        return [x, y] as [number, number];
      }),
    );
    if (cons.length < 2 || n === 0) {
      this.g = null;
      this.h = null;
      return;
    }
    // STEP 1 — G (2n × 2n), variable 2v = x_v, 2v+1 = y_v.
    const N = 2 * n;
    const G = new Float64Array(N * N);
    const addRow = (coef: Map<number, number>) => {
      const entries = [...coef];
      for (const [a, ca] of entries)
        for (const [b, cb] of entries) G[a * N + b] += ca * cb;
    };
    this.tris.forEach((t, ti) => {
      for (let e = 0; e < 3; e++) {
        const i = t[e]!;
        const j = t[(e + 1) % 3]!;
        const k = t[(e + 2) % 3]!;
        const [x, y] = this.edgeCoords[ti]![e]!;
        // e_x = xk − (1−x) xi − x xj − y (yj − yi)
        const rx = new Map<number, number>();
        const acc = (m: Map<number, number>, v: number, c: number) =>
          m.set(v, (m.get(v) ?? 0) + c);
        acc(rx, 2 * k, 1);
        acc(rx, 2 * i, -(1 - x));
        acc(rx, 2 * j, -x);
        acc(rx, 2 * j + 1, -y);
        acc(rx, 2 * i + 1, y);
        addRow(rx);
        // e_y = yk − (1−x) yi − x yj + y (xj − xi)
        const ry = new Map<number, number>();
        acc(ry, 2 * k + 1, 1);
        acc(ry, 2 * i + 1, -(1 - x));
        acc(ry, 2 * j + 1, -x);
        acc(ry, 2 * j, y);
        acc(ry, 2 * i, -y);
        addRow(ry);
      }
    });
    for (let v = 0; v < n; v++) {
      G[2 * v * N + 2 * v] += this.spring[v]!;
      G[(2 * v + 1) * N + 2 * v + 1] += this.spring[v]!;
    }
    for (const c of cons) {
      G[2 * c.vertex * N + 2 * c.vertex] += W;
      G[(2 * c.vertex + 1) * N + 2 * c.vertex + 1] += W;
    }
    this.g = new Cholesky(N, G);
    // STEP 2 — H (n × n): the edge Laplacian of every triangle's edges.
    const H = new Float64Array(n * n);
    for (const t of this.tris)
      for (let e = 0; e < 3; e++) {
        const i = t[e]!;
        const j = t[(e + 1) % 3]!;
        H[i * n + i] += 1;
        H[j * n + j] += 1;
        H[i * n + j] -= 1;
        H[j * n + i] -= 1;
      }
    for (let v = 0; v < n; v++) H[v * n + v] += this.spring[v]!;
    for (const c of cons) H[c.vertex * n + c.vertex] += W;
    this.h = new Cholesky(n, H);
  }

  /** The constrained vertices (pin vertices first, then rotated pins'
   *  neighbours). */
  constrainedVertices(): number[] {
    return this.constraints.map((c) => c.vertex);
  }

  private targetOf(
    c: Constraint,
    targets: readonly Vec2[],
    angles: readonly (number | null)[],
  ): Vec2 {
    const t = targets[c.pin]!;
    if (!c.offset) return t;
    const a = angles[c.pin] ?? 0;
    const co = Math.cos(a);
    const si = Math.sin(a);
    return [
      t[0] + co * c.offset[0] - si * c.offset[1],
      t[1] + si * c.offset[0] + co * c.offset[1],
    ];
  }

  /**
   * The deformed vertices for the pins' `targets` (in the order the pins
   * were given) and, for rotated pins, their current `angles` (radians;
   * defaults to each pin's own). Pure with respect to the solver.
   */
  solve(
    targets: readonly Vec2[],
    angles: readonly (number | null)[] = this.pins.map((p) => p.angle ?? null),
  ): Vec2Mut[] {
    const n = this.n;
    const rest = this.rest;
    if (n === 0) return [];
    if (this.constraints.length === 0) return rest.map((v) => [v[0], v[1]]);
    if (!this.g || !this.h) {
      // One constraint: a rigid move — translate by the pin, turn by its
      // angle about it.
      const c = this.constraints[0]!;
      const p = rest[c.vertex]!;
      const t = targets[c.pin]!;
      const a = angles[c.pin] ?? 0;
      const co = Math.cos(a);
      const si = Math.sin(a);
      return rest.map((v) => {
        const dx = v[0] - p[0];
        const dy = v[1] - p[1];
        return [t[0] + co * dx - si * dy, t[1] + si * dx + co * dy];
      });
    }
    // Step 1.
    const N = 2 * n;
    const b1 = new Float64Array(N);
    for (let v = 0; v < n; v++) {
      b1[2 * v] = this.spring[v]! * rest[v]![0];
      b1[2 * v + 1] = this.spring[v]! * rest[v]![1];
    }
    for (const c of this.constraints) {
      const q = this.targetOf(c, targets, angles);
      b1[2 * c.vertex] += W * q[0];
      b1[2 * c.vertex + 1] += W * q[1];
    }
    const v1 = this.g.solve(b1);
    // Step 2a: the rigid fit of each rest triangle.
    const fitted = this.tris.map((t) => {
      const r = t.map((i) => rest[i]!);
      const m = t.map((i) => [v1[2 * i]!, v1[2 * i + 1]!] as Vec2);
      const rc = [
        (r[0]![0] + r[1]![0] + r[2]![0]) / 3,
        (r[0]![1] + r[1]![1] + r[2]![1]) / 3,
      ];
      const mc = [
        (m[0]![0] + m[1]![0] + m[2]![0]) / 3,
        (m[0]![1] + m[1]![1] + m[2]![1]) / 3,
      ];
      let dot = 0;
      let crs = 0;
      for (let k = 0; k < 3; k++) {
        const ax = r[k]![0] - rc[0]!;
        const ay = r[k]![1] - rc[1]!;
        const bx = m[k]![0] - mc[0]!;
        const by = m[k]![1] - mc[1]!;
        dot += ax * bx + ay * by;
        crs += ax * by - ay * bx;
      }
      const a = Math.atan2(crs, dot);
      const co = Math.cos(a);
      const si = Math.sin(a);
      return r.map(
        (p) =>
          [
            mc[0]! + co * (p[0] - rc[0]!) - si * (p[1] - rc[1]!),
            mc[1]! + si * (p[0] - rc[0]!) + co * (p[1] - rc[1]!),
          ] as Vec2,
      );
    });
    // Step 2b.
    const bx = new Float64Array(n);
    const by = new Float64Array(n);
    for (let v = 0; v < n; v++) {
      bx[v] = this.spring[v]! * rest[v]![0];
      by[v] = this.spring[v]! * rest[v]![1];
    }
    this.tris.forEach((t, ti) => {
      const f = fitted[ti]!;
      for (let e = 0; e < 3; e++) {
        const i = t[e]!;
        const j = t[(e + 1) % 3]!;
        const ex = f[(e + 1) % 3]![0] - f[e]![0];
        const ey = f[(e + 1) % 3]![1] - f[e]![1];
        // (vj − vi) ≈ e  ⇒  vj gets +e, vi gets −e.
        bx[j] += ex;
        by[j] += ey;
        bx[i] -= ex;
        by[i] -= ey;
      }
    });
    for (const c of this.constraints) {
      const q = this.targetOf(c, targets, angles);
      bx[c.vertex] += W * q[0];
      by[c.vertex] += W * q[1];
    }
    const xs = this.h.solve(bx);
    const ys = this.h.solve(by);
    const out: Vec2Mut[] = [];
    for (let v = 0; v < n; v++) out.push([xs[v]!, ys[v]!]);
    return out;
  }
}

/** Map `p` (located in the REST mesh) into the deformed mesh. */
export function mapLocated(
  triangles: readonly [number, number, number][],
  deformed: readonly Vec2[],
  located: { triangle: number; weights: readonly [number, number, number] },
): Vec2Mut {
  const t = triangles[located.triangle]!;
  const [a, b, c] = located.weights;
  const p0 = deformed[t[0]]!;
  const p1 = deformed[t[1]]!;
  const p2 = deformed[t[2]]!;
  return [a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]];
}

/** The nearest mesh vertex to `p` (and its distance). */
export function nearestVertex(
  vertices: readonly Vec2[],
  p: Vec2,
): { index: number; distance: number } {
  let index = -1;
  let distance = Infinity;
  vertices.forEach((v, i) => {
    const d = Math.hypot(v[0] - p[0], v[1] - p[1]);
    if (d < distance) {
      distance = d;
      index = i;
    }
  });
  return { index, distance };
}

/**
 * Illustrator's AUTOMATIC pins: `count` (default 3) mesh vertices spread
 * over the shape — the vertex nearest the centroid of the mesh first,
 * then repeatedly the vertex FARTHEST from every pin chosen so far
 * (farthest-point sampling). Deterministic.
 */
export function autoPins(
  mesh: Pick<TriangleMesh, "vertices" | "triangles">,
  count = 3,
): number[] {
  const v = mesh.vertices;
  if (v.length === 0) return [];
  let cx = 0;
  let cy = 0;
  for (const p of v) {
    cx += p[0];
    cy += p[1];
  }
  cx /= v.length;
  cy /= v.length;
  const pins = [nearestVertex(v, [cx, cy]).index];
  const dmin = v.map((p) =>
    Math.hypot(p[0] - v[pins[0]!]![0], p[1] - v[pins[0]!]![1]),
  );
  while (pins.length < Math.min(count, v.length)) {
    let best = -1;
    let bestD = -1;
    dmin.forEach((d, i) => {
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best < 0 || bestD <= 0) break;
    pins.push(best);
    v.forEach((p, i) => {
      dmin[i] = Math.min(
        dmin[i]!,
        Math.hypot(p[0] - v[best]![0], p[1] - v[best]![1]),
      );
    });
  }
  return pins;
}
