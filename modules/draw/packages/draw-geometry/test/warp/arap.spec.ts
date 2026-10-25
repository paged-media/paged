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

// THE PUPPET MESH AND ITS ARAP SOLVE — the constrained triangulation
// (coverage, constraints, holes, concavities, the vertex cap), the
// Delaunay property, mesh location, and Igarashi's two-step solve
// (identity, rigid moves, one-pin moves, rotated pins, near-rigidity of
// a bend, unpinned components). [plugin-draw.distortion-tools]

import { describe, expect, it } from "bun:test";

import {
  ArapSolver,
  autoPins,
  delaunay,
  locateInMesh,
  mapLocated,
  meshNeighbours,
  nearestVertex,
  pointInRings,
  resampleRing,
  triangulateRings,
  type TriangleMesh,
  type Vec2,
} from "../../src";

type P = [number, number];
const rect = (x0: number, y0: number, x1: number, y1: number): P[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

const triArea = (m: TriangleMesh, t: [number, number, number]) => {
  const [a, b, c] = t.map((i) => m.vertices[i]!);
  return (
    Math.abs(
      (b![0] - a![0]) * (c![1] - a![1]) - (b![1] - a![1]) * (c![0] - a![0]),
    ) / 2
  );
};
const meshArea = (m: TriangleMesh) =>
  m.triangles.reduce((s, t) => s + triArea(m, t), 0);

const hasEdge = (m: TriangleMesh, a: Vec2, b: Vec2): boolean => {
  const ia = m.vertices.findIndex((v) => v[0] === a[0] && v[1] === a[1]);
  const ib = m.vertices.findIndex((v) => v[0] === b[0] && v[1] === b[1]);
  return m.triangles.some((t) => t.includes(ia) && t.includes(ib));
};

/** A deterministic pseudo-random sequence. */
const lcg = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

describe("puppet mesh — constrained triangulation [plugin-draw.distortion-tools]", () => {
  it("fills a square exactly, every outline edge is a mesh edge", () => {
    const ring = rect(0, 0, 100, 100);
    const m = triangulateRings([ring], { spacing: 10 });
    expect(meshArea(m)).toBeCloseTo(10000, 6);
    expect(m.unrecovered).toBe(0);
    const res = resampleRing(ring, 10);
    for (let i = 0; i < res.length; i++)
      expect(hasEdge(m, res[i]!, res[(i + 1) % res.length]!)).toBe(true);
    // Steiner points inside.
    expect(m.vertices.length).toBeGreaterThan(res.length + 20);
  });

  it("keeps a hole a hole (even-odd over the rings)", () => {
    const m = triangulateRings([rect(0, 0, 100, 100), rect(30, 30, 70, 70)], {
      spacing: 8,
    });
    expect(meshArea(m)).toBeCloseTo(10000 - 1600, 4);
    for (const t of m.triangles) {
      const c = t
        .map((i) => m.vertices[i]!)
        .reduce((s, v) => [s[0] + v[0] / 3, s[1] + v[1] / 3], [0, 0]);
      expect(c[0] > 30 && c[0] < 70 && c[1] > 30 && c[1] < 70).toBe(false);
    }
  });

  it("does not bridge a concave notch (a U shape)", () => {
    const u: P[] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [70, 100],
      [70, 20],
      [30, 20],
      [30, 100],
      [0, 100],
    ];
    const m = triangulateRings([u], { spacing: 7 });
    expect(meshArea(m)).toBeCloseTo(10000 - 40 * 80, 3);
    expect(m.unrecovered).toBe(0);
  });

  it("respects the vertex cap by coarsening", () => {
    const m = triangulateRings([rect(0, 0, 1000, 1000)], {
      spacing: 5,
      maxVertices: 200,
    });
    expect(m.vertices.length).toBeLessThanOrEqual(200);
    expect(meshArea(m)).toBeCloseTo(1e6, 3);
  });

  it("an empty or degenerate input is an empty mesh", () => {
    expect(triangulateRings([], { spacing: 5 }).triangles).toEqual([]);
    expect(
      triangulateRings(
        [
          [
            [0, 0],
            [1, 1],
          ],
        ],
        { spacing: 5 },
      ).triangles,
    ).toEqual([]);
  });

  it("Delaunay: no point lies inside any triangle's circumcircle", () => {
    const rnd = lcg(7);
    const pts: P[] = Array.from({ length: 60 }, () => [
      rnd() * 100,
      rnd() * 100,
    ]);
    const tris = delaunay(pts);
    expect(tris.length).toBeGreaterThan(80);
    for (const [a, b, c] of tris) {
      const A = pts[a]!;
      const B = pts[b]!;
      const C = pts[c]!;
      const d =
        2 *
        (A[0] * (B[1] - C[1]) + B[0] * (C[1] - A[1]) + C[0] * (A[1] - B[1]));
      const ux =
        ((A[0] ** 2 + A[1] ** 2) * (B[1] - C[1]) +
          (B[0] ** 2 + B[1] ** 2) * (C[1] - A[1]) +
          (C[0] ** 2 + C[1] ** 2) * (A[1] - B[1])) /
        d;
      const uy =
        ((A[0] ** 2 + A[1] ** 2) * (C[0] - B[0]) +
          (B[0] ** 2 + B[1] ** 2) * (A[0] - C[0]) +
          (C[0] ** 2 + C[1] ** 2) * (B[0] - A[0])) /
        d;
      const r = Math.hypot(A[0] - ux, A[1] - uy);
      pts.forEach((p, i) => {
        if (i === a || i === b || i === c) return;
        expect(Math.hypot(p[0] - ux, p[1] - uy)).toBeGreaterThan(r - 1e-7);
      });
    }
  });

  it("locates a point in its triangle, and extrapolates one outside", () => {
    const m = triangulateRings([rect(0, 0, 100, 100)], { spacing: 20 });
    const inside = locateInMesh(m, [37, 61])!;
    const back = mapLocated(m.triangles, m.vertices, inside);
    expect(back[0]).toBeCloseTo(37, 9);
    expect(back[1]).toBeCloseTo(61, 9);
    const outside = locateInMesh(m, [130, 50])!;
    const out = mapLocated(m.triangles, m.vertices, outside);
    expect(out[0]).toBeCloseTo(130, 6);
    expect(out[1]).toBeCloseTo(50, 6);
  });

  it("pointInRings is even-odd", () => {
    const rings = [rect(0, 0, 10, 10), rect(2, 2, 8, 8)];
    expect(pointInRings([1, 1], rings)).toBe(true);
    expect(pointInRings([5, 5], rings)).toBe(false);
    expect(pointInRings([11, 5], rings)).toBe(false);
  });
});

describe("ARAP — Igarashi's two-step solve [plugin-draw.distortion-tools]", () => {
  const bar = triangulateRings([rect(0, 0, 200, 40)], { spacing: 10 });
  const at = (p: Vec2) => nearestVertex(bar.vertices, p).index;

  it("pins at rest give the rest shape", () => {
    const pins = [at([0, 0]), at([200, 40]), at([100, 20])].map((v) => ({
      vertex: v,
      target: bar.vertices[v]!,
    }));
    const out = new ArapSolver(bar, pins).solve(pins.map((p) => p.target));
    out.forEach((v, i) => {
      expect(v[0]).toBeCloseTo(bar.vertices[i]![0], 4);
      expect(v[1]).toBeCloseTo(bar.vertices[i]![1], 4);
    });
  });

  it("moving every pin by one offset translates the whole mesh", () => {
    const vs = [at([0, 0]), at([200, 0]), at([100, 40])];
    const solver = new ArapSolver(
      bar,
      vs.map((v) => ({ vertex: v, target: bar.vertices[v]! })),
    );
    const out = solver.solve(
      vs.map((v) => [bar.vertices[v]![0] + 15, bar.vertices[v]![1] - 7]),
    );
    out.forEach((v, i) => {
      expect(v[0]).toBeCloseTo(bar.vertices[i]![0] + 15, 3);
      expect(v[1]).toBeCloseTo(bar.vertices[i]![1] - 7, 3);
    });
  });

  it("rotating the pins rotates the mesh rigidly", () => {
    const vs = [at([0, 0]), at([200, 40]), at([0, 40])];
    const solver = new ArapSolver(
      bar,
      vs.map((v) => ({ vertex: v, target: bar.vertices[v]! })),
    );
    const a = 0.4;
    const rot = (p: Vec2): P => [
      100 + Math.cos(a) * (p[0] - 100) - Math.sin(a) * (p[1] - 20),
      20 + Math.sin(a) * (p[0] - 100) + Math.cos(a) * (p[1] - 20),
    ];
    const out = solver.solve(vs.map((v) => rot(bar.vertices[v]!)));
    out.forEach((v, i) => {
      const want = rot(bar.vertices[i]!);
      expect(Math.hypot(v[0] - want[0], v[1] - want[1])).toBeLessThan(0.05);
    });
  });

  it("one pin translates; with an angle it turns about the pin", () => {
    const v = at([100, 20]);
    const p0 = bar.vertices[v]!;
    const moved = new ArapSolver(bar, [{ vertex: v, target: p0 }]).solve([
      [p0[0] + 10, p0[1]],
    ]);
    expect(moved[0]![0]).toBeCloseTo(bar.vertices[0]![0] + 10, 9);
    const turned = new ArapSolver(bar, [
      { vertex: v, target: p0, angle: Math.PI / 2 },
    ]).solve([p0]);
    const far = at([200, 20]);
    expect(turned[far]![0]).toBeCloseTo(
      p0[0] - (bar.vertices[far]![1] - p0[1]),
      6,
    );
    expect(turned[far]![1]).toBeCloseTo(
      p0[1] + (bar.vertices[far]![0] - p0[0]),
      6,
    );
  });

  it("bending a bar keeps it close to rigid: edge lengths barely change and the pins hit their targets", () => {
    const left1 = at([0, 0]);
    const left2 = at([0, 40]);
    const tip = at([200, 20]);
    const pins = [left1, left2, tip].map((v) => ({
      vertex: v,
      target: bar.vertices[v]!,
    }));
    const solver = new ArapSolver(bar, pins);
    const out = solver.solve([
      bar.vertices[left1]!,
      bar.vertices[left2]!,
      [180, 90],
    ]);
    expect(Math.hypot(out[tip]![0] - 180, out[tip]![1] - 90)).toBeLessThan(0.1);
    const nb = meshNeighbours(bar);
    let worst = 0;
    let total = 0;
    let count = 0;
    nb.forEach((list, i) =>
      list.forEach((j) => {
        if (j < i) return;
        const r = Math.hypot(
          bar.vertices[j]![0] - bar.vertices[i]![0],
          bar.vertices[j]![1] - bar.vertices[i]![1],
        );
        const d = Math.hypot(out[j]![0] - out[i]![0], out[j]![1] - out[i]![1]);
        const rel = Math.abs(d - r) / r;
        worst = Math.max(worst, rel);
        total += rel;
        count++;
      }),
    );
    expect(total / count).toBeLessThan(0.05);
    expect(worst).toBeLessThan(0.35);
    // The bar bent: the tip end went up (y down: negative), the root stayed.
    expect(out[left1]![0]).toBeCloseTo(0, 1);
  });

  it("a component without a pin stays where it was", () => {
    const two = triangulateRings([rect(0, 0, 40, 40), rect(100, 0, 140, 40)], {
      spacing: 10,
    });
    const a = nearestVertex(two.vertices, [0, 0]).index;
    const b = nearestVertex(two.vertices, [40, 40]).index;
    const solver = new ArapSolver(two, [
      { vertex: a, target: two.vertices[a]! },
      { vertex: b, target: two.vertices[b]! },
    ]);
    const out = solver.solve([
      [two.vertices[a]![0] + 5, two.vertices[a]![1]],
      [two.vertices[b]![0] + 5, two.vertices[b]![1]],
    ]);
    const far = nearestVertex(two.vertices, [140, 40]).index;
    expect(out[far]![0]).toBeCloseTo(140, 3);
    expect(out[far]![1]).toBeCloseTo(40, 3);
  });

  it("auto pins spread over the shape: centre first, then the far ends", () => {
    const pins = autoPins(bar, 3);
    expect(pins).toHaveLength(3);
    const xs = pins.map((i) => bar.vertices[i]![0]).sort((a, b) => a - b);
    expect(xs[0]).toBeLessThan(20);
    expect(xs[2]).toBeGreaterThan(180);
    expect(Math.abs(xs[1]! - 100)).toBeLessThan(15);
    expect(autoPins(bar, 3)).toEqual(pins);
  });
});
