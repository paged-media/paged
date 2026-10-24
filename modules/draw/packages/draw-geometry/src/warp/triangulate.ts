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

// THE PUPPET MESH — a constrained Delaunay triangulation of an outline.
//
// Puppet Warp deforms a TRIANGLE MESH that fills the artwork's outline
// (Igarashi, Moscovich, Hughes, "As-Rigid-As-Possible Shape
// Manipulation", SIGGRAPH 2005, §3). This module builds that mesh:
//
//   1. every outline ring (closed polygons — the flattened contours of
//      the selected paths) is RESAMPLED so no edge is longer than
//      `spacing`;
//   2. Steiner points fill the inside on a staggered (hexagonal) lattice
//      of the same spacing, kept at least half a spacing off the outline
//      so no sliver triangles form against it;
//   3. Bowyer–Watson builds the Delaunay triangulation of all the points
//      (inside a super-triangle);
//   4. every outline edge is made an edge of the mesh — Sloan's edge-flip
//      recovery ("A fast algorithm for generating constrained Delaunay
//      triangulations", 1993): the edges crossing a constraint are flipped
//      until none does. Two CROSSING constraints (two selected shapes that
//      overlap) cannot both be recovered; the later one is left as it is
//      and reported in `unrecovered`, which costs a little fidelity at the
//      crossing and nothing else;
//   5. the super-triangle's triangles and every triangle whose centroid is
//      outside (the `inside` test; default even-odd over the rings, so a
//      hole stays a hole) are removed.
//
// Deterministic (no randomness; the lattice is offset by a fixed tiny
// stagger to keep it off the cocircular degeneracies a square grid has),
// pure, and free of host types — a port target for `paged-warp`.

import type { Vec2, Vec2Mut } from "../types";

export type Triangle = [number, number, number];

export interface TriangleMesh {
  vertices: Vec2Mut[];
  /** Counter-clockwise in a y-up frame (positive signed area in page
   *  coordinates' raw formula — the orientation is consistent, which is
   *  all ARAP needs). */
  triangles: Triangle[];
  /** Index ranges of the boundary vertices, per input ring (resampled). */
  boundary: number[][];
  /** Outline edges the flip recovery could not insert (crossing
   *  constraints). */
  unrecovered: number;
}

export interface TriangulateOptions {
  /** pt — target edge length. */
  spacing: number;
  /** Point-in-shape test; default: even-odd over the rings. */
  inside?: (p: Vec2) => boolean;
  /** Cap on vertices: the spacing grows until the mesh fits. */
  maxVertices?: number;
}

const orient = (a: Vec2, b: Vec2, c: Vec2): number =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Even-odd point in rings. */
export function pointInRings(
  p: Vec2,
  rings: readonly (readonly Vec2[])[],
): boolean {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = ring[i]!;
      const b = ring[j]!;
      if (
        a[1] > p[1] !== b[1] > p[1] &&
        p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
      )
        inside = !inside;
    }
  }
  return inside;
}

const segDist = (p: Vec2, a: Vec2, b: Vec2): number => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};

/** Resample a closed ring so no edge exceeds `spacing`; consecutive
 *  duplicates dropped. */
export function resampleRing(
  ring: readonly Vec2[],
  spacing: number,
): Vec2Mut[] {
  const out: Vec2Mut[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.max(1, Math.ceil(l / spacing));
    for (let s = 0; s < k; s++) {
      const t = s / k;
      const p: Vec2Mut = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const last = out[out.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > spacing * 1e-3)
        out.push(p);
    }
  }
  if (
    out.length > 1 &&
    Math.hypot(
      out[0]![0] - out[out.length - 1]![0],
      out[0]![1] - out[out.length - 1]![1],
    ) <=
      spacing * 1e-3
  )
    out.pop();
  return out;
}

// ------------------------------------------------------- Bowyer–Watson

/** An integer hash of `i` → [−0.5, 0.5): platform-stable (no Math.sin). */
function unitHash(i: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000 - 0.5;
}

function circumcircleContains(a: Vec2, b: Vec2, c: Vec2, p: Vec2): boolean {
  // Sign-normalised in-circle determinant.
  const ax = a[0] - p[0];
  const ay = a[1] - p[1];
  const bx = b[0] - p[0];
  const by = b[1] - p[1];
  const cx = c[0] - p[0];
  const cy = c[1] - p[1];
  const det =
    (ax * ax + ay * ay) * (bx * cy - cx * by) -
    (bx * bx + by * by) * (ax * cy - cx * ay) +
    (cx * cx + cy * cy) * (ax * by - bx * ay);
  return orient(a, b, c) > 0 ? det > 0 : det < 0;
}

/** Delaunay triangulation of `pts` (Bowyer–Watson). Triangles index
 *  `pts`; every triangle is counter-clockwise (orient > 0). */
export function delaunay(pts: readonly Vec2[]): Triangle[] {
  const n = pts.length;
  return delaunayWithSuper(pts).tris.filter(
    (t) => t[0] < n && t[1] < n && t[2] < n,
  );
}

/** Bowyer–Watson keeping the super-triangle: `all` is `pts` followed by
 *  its three vertices, which the constraint flips may still need. */
function delaunayWithSuper(pts: readonly Vec2[]): {
  all: Vec2[];
  tris: Triangle[];
} {
  const n = pts.length;
  if (n < 3) return { all: [...pts], tris: [] };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  const size = Math.max(x1 - x0, y1 - y0, 1);
  const d = size * 20;
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const supers: Vec2[] = [
    [mx - d, my - d],
    [mx + d, my - d],
    [mx, my + d],
  ];
  // The PREDICATES run on a deterministically jittered copy (a hash of the
  // index, 1e-6 of the extent): resampled outlines and lattices are full
  // of cocircular quadruples, on which a naive in-circle test makes
  // Bowyer–Watson's cavity non-star-shaped and the result overlaps. The
  // triangles index the ORIGINAL points.
  const jit = size * 1e-6;
  const all: Vec2[] = [
    ...pts.map((p, i): Vec2 => {
      return [p[0] + unitHash(2 * i) * jit, p[1] + unitHash(2 * i + 1) * jit];
    }),
    ...supers,
  ];
  const original: Vec2[] = [...pts, ...supers];
  const s0 = n;
  let tris: Triangle[] = [[s0, s0 + 1, s0 + 2]];
  if (orient(all[s0]!, all[s0 + 1]!, all[s0 + 2]!) < 0)
    tris = [[s0, s0 + 2, s0 + 1]];
  for (let i = 0; i < n; i++) {
    const p = all[i]!;
    const bad: Triangle[] = [];
    const keep: Triangle[] = [];
    for (const t of tris) {
      if (circumcircleContains(all[t[0]]!, all[t[1]]!, all[t[2]]!, p))
        bad.push(t);
      else keep.push(t);
    }
    // The cavity's boundary: edges of bad triangles not shared by two.
    const count = new Map<string, [number, number]>();
    const seen = new Map<string, number>();
    for (const t of bad) {
      for (let e = 0; e < 3; e++) {
        const a = t[e]!;
        const b = t[(e + 1) % 3]!;
        const k = a < b ? `${a},${b}` : `${b},${a}`;
        seen.set(k, (seen.get(k) ?? 0) + 1);
        count.set(k, [a, b]);
      }
    }
    for (const [k, [a, b]] of count) {
      if (seen.get(k) !== 1) continue;
      const t: Triangle = [a, b, i];
      if (orient(all[a]!, all[b]!, p) < 0) t.splice(0, 2, b, a);
      keep.push(t);
    }
    tris = keep;
  }
  return { all: original, tris };
}

// ---------------------------------------------------- constraint flips

const ekey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/** Make the edge (u, v) an edge of `tris` by flipping crossing edges
 *  (Sloan 1993). True when it is (or already was) an edge. Mutates. */
function recoverEdge(
  tris: Triangle[],
  pts: readonly Vec2[],
  u: number,
  v: number,
  fixed: Set<string>,
): boolean {
  const has = () => tris.some((t) => t.includes(u) && t.includes(v));
  if (has()) return true;
  const a = pts[u]!;
  const b = pts[v]!;
  for (let iter = 0; iter < 2000; iter++) {
    // The edges crossing (u, v), with their two triangles.
    const owners = new Map<string, number[]>();
    tris.forEach((t, ti) => {
      for (let e = 0; e < 3; e++) {
        const k = ekey(t[e]!, t[(e + 1) % 3]!);
        const list = owners.get(k);
        if (list) list.push(ti);
        else owners.set(k, [ti]);
      }
    });
    let flipped = false;
    let crossing = 0;
    for (const [k, list] of owners) {
      if (list.length !== 2 || fixed.has(k)) continue;
      const [p, q] = k.split(",").map(Number) as [number, number];
      if (p === u || p === v || q === u || q === v) continue;
      if (!segmentsCross(a, b, pts[p]!, pts[q]!)) continue;
      crossing++;
      const t1 = tris[list[0]!]!;
      const t2 = tris[list[1]!]!;
      const r = t1.find((x) => x !== p && x !== q)!;
      const s = t2.find((x) => x !== p && x !== q)!;
      // Flip only a strictly convex quad (p, r, q, s).
      if (!segmentsCross(pts[p]!, pts[q]!, pts[r]!, pts[s]!)) continue;
      const n1: Triangle = [r, s, p];
      const n2: Triangle = [s, r, q];
      if (orient(pts[n1[0]]!, pts[n1[1]]!, pts[n1[2]]!) < 0)
        n1.splice(0, 2, s, r);
      if (orient(pts[n2[0]]!, pts[n2[1]]!, pts[n2[2]]!) < 0)
        n2.splice(0, 2, r, s);
      tris[list[0]!] = n1;
      tris[list[1]!] = n2;
      flipped = true;
      break;
    }
    if (has()) return true;
    if (!flipped || crossing === 0) return has();
  }
  return has();
}

// ------------------------------------------------------------- the mesh

/**
 * The constrained mesh of `rings` (closed polygons, page pt). See the
 * module header for the steps. A ring with fewer than 3 points is
 * ignored; no ring at all gives an empty mesh.
 */
export function triangulateRings(
  rings: readonly (readonly Vec2[])[],
  options: TriangulateOptions,
): TriangleMesh {
  const cap = options.maxVertices ?? 600;
  let spacing = Math.max(1e-3, options.spacing);
  for (let attempt = 0; attempt < 12; attempt++) {
    const mesh = buildMesh(rings, spacing, options.inside, cap);
    if (mesh) return mesh;
    spacing *= 1.35;
  }
  return buildMesh(rings, spacing, options.inside, Infinity)!;
}

function buildMesh(
  rings: readonly (readonly Vec2[])[],
  spacing: number,
  insideOpt: ((p: Vec2) => boolean) | undefined,
  cap: number,
): TriangleMesh | null {
  const valid = rings.filter((r) => r.length >= 3);
  const resampled = valid.map((r) => resampleRing(r, spacing));
  const inside = insideOpt ?? ((p: Vec2) => pointInRings(p, valid));
  const vertices: Vec2Mut[] = [];
  const boundary: number[][] = [];
  for (const ring of resampled) {
    if (ring.length < 3) continue;
    const ids: number[] = [];
    for (const p of ring) {
      ids.push(vertices.length);
      vertices.push([p[0], p[1]]);
    }
    boundary.push(ids);
  }
  if (vertices.length > cap) return null;
  if (vertices.length < 3)
    return { vertices, triangles: [], boundary, unrecovered: 0 };
  // Steiner lattice.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of vertices) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  const rowH = spacing * 0.8660254;
  const edges: [Vec2, Vec2][] = [];
  for (const ring of resampled)
    for (let i = 0; i < ring.length; i++)
      edges.push([ring[i]!, ring[(i + 1) % ring.length]!]);
  for (
    let row = 0, y = y0 + rowH * 0.5 + spacing * 1e-3;
    y < y1;
    row++, y += rowH
  ) {
    const off = row % 2 ? spacing * 0.5 : 0;
    for (
      let x = x0 + off + spacing * 0.5 + spacing * 7e-4;
      x < x1;
      x += spacing
    ) {
      const p: Vec2 = [x, y];
      if (!inside(p)) continue;
      let near = false;
      for (const [a, b] of edges)
        if (segDist(p, a, b) < spacing * 0.5) {
          near = true;
          break;
        }
      if (near) continue;
      vertices.push([x, y]);
      if (vertices.length > cap) return null;
    }
  }
  const { all, tris } = delaunayWithSuper(vertices);
  // Constraint recovery.
  const fixed = new Set<string>();
  let unrecovered = 0;
  for (const ids of boundary) {
    for (let i = 0; i < ids.length; i++) {
      const u = ids[i]!;
      const v = ids[(i + 1) % ids.length]!;
      if (recoverEdge(tris, all, u, v, fixed)) fixed.add(ekey(u, v));
      else unrecovered++;
    }
  }
  const n = vertices.length;
  const triangles = tris.filter((t) => {
    if (t[0] >= n || t[1] >= n || t[2] >= n) return false;
    const a = vertices[t[0]]!;
    const b = vertices[t[1]]!;
    const c = vertices[t[2]]!;
    if (Math.abs(orient(a, b, c)) < spacing * spacing * 1e-6) return false;
    return inside([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3]);
  });
  // Drop vertices no triangle uses (a Steiner point cut off by a
  // recovered edge, or a ring vertex outside every kept triangle) and
  // re-index.
  const used = new Array<number>(n).fill(-1);
  const kept: Vec2Mut[] = [];
  for (const t of triangles)
    for (const i of t)
      if (used[i] === -1) {
        used[i] = kept.length;
        kept.push(vertices[i]!);
      }
  // Keep the boundary order in the new indexing.
  const remapped = boundary.map((ids) =>
    ids.map((i) => used[i]!).filter((i) => i >= 0),
  );
  return {
    vertices: kept,
    triangles: triangles.map((t) => [used[t[0]]!, used[t[1]]!, used[t[2]]!]),
    boundary: remapped,
    unrecovered,
  };
}

/** Barycentric coordinates of `p` in triangle (a, b, c). */
export function barycentric(
  p: Vec2,
  a: Vec2,
  b: Vec2,
  c: Vec2,
): [number, number, number] {
  const d = orient(a, b, c);
  if (Math.abs(d) < 1e-12) return [1, 0, 0];
  const l1 = orient(p, b, c) / d;
  const l2 = orient(a, p, c) / d;
  return [l1, l2, 1 - l1 - l2];
}

/** Where `p` sits in the mesh: the containing triangle and its
 *  barycentric coordinates, or — outside the mesh (a handle can stick
 *  out of the outline) — the nearest triangle and the EXTRAPOLATED
 *  coordinates, so the point follows that triangle's affine map. */
export function locateInMesh(
  mesh: Pick<TriangleMesh, "vertices" | "triangles">,
  p: Vec2,
): { triangle: number; weights: [number, number, number] } | null {
  let best = -1;
  let bestScore = -Infinity;
  let bestW: [number, number, number] = [1, 0, 0];
  for (let i = 0; i < mesh.triangles.length; i++) {
    const t = mesh.triangles[i]!;
    const w = barycentric(
      p,
      mesh.vertices[t[0]]!,
      mesh.vertices[t[1]]!,
      mesh.vertices[t[2]]!,
    );
    const score = Math.min(w[0], w[1], w[2]);
    if (score >= -1e-9) return { triangle: i, weights: w };
    // Nearest by distance to the triangle's centroid, normalised.
    const a = mesh.vertices[t[0]]!;
    const b = mesh.vertices[t[1]]!;
    const c = mesh.vertices[t[2]]!;
    const cx = (a[0] + b[0] + c[0]) / 3;
    const cy = (a[1] + b[1] + c[1]) / 3;
    const dscore = -Math.hypot(p[0] - cx, p[1] - cy);
    if (dscore > bestScore) {
      bestScore = dscore;
      best = i;
      bestW = w;
    }
  }
  return best < 0 ? null : { triangle: best, weights: bestW };
}
