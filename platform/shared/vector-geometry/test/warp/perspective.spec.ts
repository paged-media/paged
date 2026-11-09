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

// HOMOGRAPHIES AND THE PERSPECTIVE GRID — the four-point solve, inverse
// and composition; curve mapping that subdivides only where it must; the
// plane maps of 1-, 2- and 3-point grids against their geometric
// construction (vanishing points, verticals, unit scale at the origin);
// attach / move along a plane; the grid's handles. The Illustrator replay
// is `draw-bundle/test/oracle/perspective-grid.spec.ts`.
// [plugin-draw.distortion-tools]

import { describe, expect, it } from "bun:test";

import {
  applyHomography,
  attachToPlane,
  composeHomography,
  defaultGrid,
  evalCubic,
  flatEllipse,
  flatRect,
  gridHandleAt,
  gridHandles,
  homographyFromQuads,
  invertHomography,
  mapTableProjective,
  moveGridHandle,
  moveOnPlane,
  onPlane,
  pageToPlane,
  parseGrid,
  planeGridLines,
  planeHomography,
  planePointByConstruction,
  planeQuad,
  planeToPage,
  projectOntoPlane,
  PLANE_IDS,
  type AnchorTable,
  type GridKind,
  type Homography,
  type Vec2,
} from "../../src";

type P = [number, number];
const close = (a: Vec2 | null, b: Vec2, eps = 1e-6) => {
  expect(a).not.toBeNull();
  expect(Math.hypot(a![0] - b[0], a![1] - b[1])).toBeLessThan(eps);
};

const SQ: [P, P, P, P] = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
];
const TRAP: [P, P, P, P] = [
  [10, 20],
  [200, 0],
  [180, 150],
  [30, 120],
];

describe("homography [plugin-draw.distortion-tools]", () => {
  it("maps the four points exactly, and its inverse maps them back", () => {
    const h = homographyFromQuads(SQ, TRAP)!;
    SQ.forEach((p, i) => close(applyHomography(h, p), TRAP[i]!, 1e-9));
    const inv = invertHomography(h)!;
    TRAP.forEach((p, i) => close(applyHomography(inv, p), SQ[i]!, 1e-9));
    const id = composeHomography(inv, h);
    close(applyHomography(id, [37, 81]), [37, 81], 1e-9);
  });

  it("refuses collinear quads", () => {
    expect(
      homographyFromQuads(SQ, [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ]),
    ).toBeNull();
  });

  it("keeps lines straight: the image of a line's midpoint is on the image line", () => {
    const h = homographyFromQuads(SQ, TRAP)!;
    const a = applyHomography(h, [10, 30])!;
    const b = applyHomography(h, [90, 70])!;
    const m = applyHomography(h, [50, 50])!;
    const cross = (b[0] - a[0]) * (m[1] - a[1]) - (b[1] - a[1]) * (m[0] - a[0]);
    expect(Math.abs(cross)).toBeLessThan(1e-9);
  });

  it("a point on the vanishing line maps to nowhere", () => {
    const h: Homography = [1, 0, 0, 0, 1, 0, 0.01, 0, 1];
    expect(applyHomography(h, [-100, 5])).toBeNull();
  });

  it("a straight-edged table keeps its anchor count; an affine map keeps curves exact", () => {
    const sq = flatRect([0, 0], [100, 100]);
    const h = homographyFromQuads(SQ, TRAP)!;
    const m = mapTableProjective(sq, h)!;
    expect(m.anchors).toHaveLength(4);
    m.anchors.forEach((a, i) => close(a.anchor, TRAP[i]!, 1e-9));
    const affine: Homography = [2, 0.5, 10, -0.3, 1.5, 4, 0, 0, 1];
    const e = flatEllipse([0, 0], [100, 60]);
    expect(mapTableProjective(e, affine)!.anchors).toHaveLength(4);
  });

  it("subdivides curves under strong perspective until within the tolerance", () => {
    const e = flatEllipse([0, 0], [100, 100]);
    const h = homographyFromQuads(SQ, [
      [0, 0],
      [300, 80],
      [300, 120],
      [0, 200],
    ])!;
    const m = mapTableProjective(e, h, 0.05)!;
    expect(m.anchors.length).toBeGreaterThan(4);
    // Sample the true image of the ellipse and compare with the mapped
    // cubics' polyline.
    const pts: P[] = [];
    for (let i = 0; i < m.anchors.length; i++) {
      const a = m.anchors[i]!;
      const b = m.anchors[(i + 1) % m.anchors.length]!;
      for (let k = 0; k <= 16; k++)
        pts.push(evalCubic(a.anchor, a.right, b.left, b.anchor, k / 16));
    }
    for (let k = 0; k < 64; k++) {
      const t = (k / 64) * Math.PI * 2;
      const q = applyHomography(h, [
        50 + 50 * Math.cos(t),
        50 + 50 * Math.sin(t),
      ])!;
      const d = Math.min(
        ...pts.map((p) => Math.hypot(p[0] - q[0], p[1] - q[1])),
      );
      expect(d).toBeLessThan(0.6);
    }
  });
});

describe("the perspective grid's planes [plugin-draw.distortion-tools]", () => {
  const kinds: GridKind[] = [1, 2, 3];

  it("every plane's homography agrees with its geometric construction", () => {
    for (const kind of kinds) {
      const g = defaultGrid(kind, 612, 792);
      for (const plane of PLANE_IDS) {
        const h = planeHomography(g, plane)!;
        expect(h).not.toBeNull();
        for (const [x, y] of [
          [0, 0],
          [37, -12],
          [96, -150],
          [5, -200],
        ] as P[]) {
          const mirrored = plane === "left" && kind !== 1;
          const u = mirrored ? -x : x;
          const v = -y;
          close(
            applyHomography(h, [x, y]),
            planePointByConstruction(g, plane, u, v)!,
            1e-6,
          );
        }
      }
    }
  });

  it("2-point: ground lines run to their vanishing points, verticals stay vertical, one pt is one pt at the origin", () => {
    const g = defaultGrid(2, 612, 792);
    const left = planeHomography(g, "left")!;
    // The direction at infinity along the left plane's run (x → −∞).
    const w = -left[6];
    close([-left[0] / w, -left[3] / w], [g.vpLeft, g.horizonY], 1e-6);
    const right = planeHomography(g, "right")!;
    const wr = right[6];
    close([right[0] / wr, right[3] / wr], [g.vpRight, g.horizonY], 1e-6);
    // Verticals: (x, 0) and (x, −100) share their page x.
    const a = applyHomography(right, [80, 0])!;
    const b = applyHomography(right, [80, -100])!;
    expect(a[0]).toBeCloseTo(b[0], 9);
    // Unit scale at the origin, along both axes.
    const o = applyHomography(right, [0, 0])!;
    const dx = applyHomography(right, [0.01, 0])!;
    const dy = applyHomography(right, [0, -0.01])!;
    expect(Math.hypot(dx[0] - o[0], dx[1] - o[1]) / 0.01).toBeCloseTo(1, 3);
    expect(Math.hypot(dy[0] - o[0], dy[1] - o[1]) / 0.01).toBeCloseTo(1, 3);
    close(o, g.origin, 1e-9);
  });

  it("3-point: verticals converge on the vertical vanishing point", () => {
    const g = defaultGrid(3, 612, 792);
    const h = planeHomography(g, "right")!;
    // The v direction at infinity (y → −∞).
    const w = -h[7];
    close([-h[1] / w, -h[4] / w], [g.origin[0], g.vpVertical], 1e-6);
  });

  it("1-point: the frontal plane is undistorted, the side wall runs to the vanishing point", () => {
    const g = defaultGrid(1, 612, 792);
    const front = planeHomography(g, "left")!;
    close(
      applyHomography(front, [100, -50]),
      [g.origin[0] + 100, g.origin[1] - 50],
      1e-9,
    );
    const side = planeHomography(g, "right")!;
    const w = side[6];
    close([side[0] / w, side[3] / w], [g.vpCenter, g.horizonY], 1e-6);
  });

  it("page ↔ plane round-trips, and onPlane is the extent", () => {
    const g = defaultGrid(2, 612, 792);
    for (const plane of PLANE_IDS) {
      const p = planeToPage(
        g,
        plane,
        plane === "left" ? [-50, -30] : [50, -30],
      )!;
      const q = pageToPlane(g, plane, p)!;
      close(q, plane === "left" ? [-50, -30] : [50, -30], 1e-6);
      expect(onPlane(g, plane, p)).toBe(true);
    }
    expect(onPlane(g, "right", [g.origin[0] - 50, g.origin[1] + 50])).toBe(
      false,
    );
  });

  it("the plane's quad and grid lines are on the plane", () => {
    const g = defaultGrid(2, 612, 792);
    const quad = planeQuad(g, "right")!;
    expect(quad).toHaveLength(4);
    close(quad[0], g.origin, 1e-9);
    const lines = planeGridLines(g, "right");
    expect(lines).toHaveLength(g.extentRight + 1 + g.extentHeight + 1);
    for (const [a, b] of lines) {
      expect(onPlane(g, "right", a!)).toBe(true);
      expect(onPlane(g, "right", b!)).toBe(true);
    }
  });
});

describe("attaching artwork and moving it along a plane [plugin-draw.distortion-tools]", () => {
  const g = defaultGrid(2, 612, 792);
  const art: AnchorTable = flatRect([100, 100], [160, 140]);

  it("attach lands the grab point on the drop point and keeps a rectangle four anchors", () => {
    const drop: P = [g.origin[0] + 40, g.origin[1] - 30];
    const r = attachToPlane(g, "right", art, [100, 140], drop)!;
    expect(r.page.anchors).toHaveLength(4);
    // The grab corner (100, 140) is anchor 3 of the rectangle.
    close(r.page.anchors[3]!.anchor, drop, 1e-6);
    // The flat geometry keeps the artwork's size.
    const xs = r.flat.anchors.map((a) => a.anchor[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(60, 9);
    // Foreshortened: the far edge is shorter on the page than the near.
    const near = Math.abs(
      r.page.anchors[3]!.anchor[1] - r.page.anchors[0]!.anchor[1],
    );
    const far = Math.abs(
      r.page.anchors[2]!.anchor[1] - r.page.anchors[1]!.anchor[1],
    );
    expect(far).toBeLessThan(near);
  });

  it("move along the plane translates the flat geometry by the plane-space drag", () => {
    const r = attachToPlane(
      g,
      "left",
      art,
      [100, 100],
      [g.origin[0] - 30, g.origin[1] - 60],
    )!;
    const from = r.page.anchors[0]!.anchor;
    const to = planeToPage(g, "left", [
      pageToPlane(g, "left", from)![0] - 25,
      pageToPlane(g, "left", from)![1] + 10,
    ])!;
    const m = moveOnPlane(g, "left", r.flat, from, to)!;
    expect(m.flat.anchors[0]!.anchor[0]).toBeCloseTo(
      r.flat.anchors[0]!.anchor[0] - 25,
      6,
    );
    expect(m.flat.anchors[0]!.anchor[1]).toBeCloseTo(
      r.flat.anchors[0]!.anchor[1] + 10,
      6,
    );
    close(m.page.anchors[0]!.anchor, to, 1e-6);
  });

  it("an ellipse on a plane is subdivided and stays on its conic", () => {
    const flat = flatEllipse([10, -120], [150, -20]);
    const page = projectOntoPlane(g, "right", flat, 0.05)!;
    expect(page.anchors.length).toBeGreaterThanOrEqual(4);
    const h = planeHomography(g, "right")!;
    for (let k = 0; k < 16; k++) {
      const t = (k / 16) * Math.PI * 2;
      const q = applyHomography(h, [
        80 + 70 * Math.cos(t),
        -70 + 50 * Math.sin(t),
      ])!;
      let best = Infinity;
      for (let i = 0; i < page.anchors.length; i++) {
        const a = page.anchors[i]!;
        const b = page.anchors[(i + 1) % page.anchors.length]!;
        for (let s = 0; s <= 20; s++) {
          const p = evalCubic(a.anchor, a.right, b.left, b.anchor, s / 20);
          best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
        }
      }
      expect(best).toBeLessThan(0.5);
    }
  });
});

describe("the grid's handles [plugin-draw.distortion-tools]", () => {
  it("lists the handles of each kind", () => {
    const ids = (k: GridKind) =>
      gridHandles(defaultGrid(k, 612, 792)).map((h) => h.id);
    expect(ids(1)).toContain("vpCenter");
    expect(ids(1)).not.toContain("vpLeft");
    expect(ids(2)).toEqual(
      expect.arrayContaining(["vpLeft", "vpRight", "horizon", "origin"]),
    );
    expect(ids(2)).not.toContain("vpVertical");
    expect(ids(3)).toContain("vpVertical");
  });

  it("the origin moves the whole grid", () => {
    const g = defaultGrid(2, 612, 792);
    const n = moveGridHandle(g, "origin", [g.origin[0] + 20, g.origin[1] - 10]);
    expect(n.vpLeft).toBe(g.vpLeft + 20);
    expect(n.vpRight).toBe(g.vpRight + 20);
    expect(n.horizonY).toBe(g.horizonY - 10);
    const before = planeToPage(g, "right", [30, -30])!;
    close(
      planeToPage(n, "right", [30, -30]),
      [before[0] + 20, before[1] - 10],
      1e-6,
    );
  });

  it("vanishing points slide along the horizon and never onto the origin", () => {
    const g = defaultGrid(2, 612, 792);
    expect(moveGridHandle(g, "vpLeft", [0, 999]).vpLeft).toBe(0);
    expect(moveGridHandle(g, "vpLeft", [g.origin[0] + 50, 0]).vpLeft).toBe(
      g.origin[0] - 4,
    );
    expect(moveGridHandle(g, "vpRight", [g.origin[0] - 50, 0]).vpRight).toBe(
      g.origin[0] + 4,
    );
    expect(moveGridHandle(g, "horizon", [0, 100]).horizonY).toBe(100);
  });

  it("the extent handles set whole cells; the cell handle sets the cell", () => {
    const g = defaultGrid(2, 612, 792);
    const r = planeToPage(g, "right", [g.cell * 4.4, 0])!;
    expect(moveGridHandle(g, "extentRight", r).extentRight).toBe(4);
    const t = planeToPage(g, "right", [0, -g.cell * 2.6])!;
    expect(moveGridHandle(g, "extentHeight", t).extentHeight).toBe(3);
    const c = planeToPage(g, "right", [30, -30])!;
    expect(moveGridHandle(g, "cell", c).cell).toBeCloseTo(30, 6);
  });

  it("gridHandleAt picks the nearest handle within the tolerance", () => {
    const g = defaultGrid(2, 612, 792);
    expect(gridHandleAt(g, [g.origin[0] + 2, g.origin[1] - 1], 6)).toBe(
      "origin",
    );
    expect(gridHandleAt(g, [g.origin[0] + 50, g.origin[1] + 80], 6)).toBeNull();
  });

  it("parseGrid round-trips a grid and refuses what is not one", () => {
    const g = {
      ...defaultGrid(3, 612, 792),
      activePlane: "floor" as const,
      locked: true,
    };
    expect(parseGrid(JSON.parse(JSON.stringify(g)))).toEqual(g);
    expect(parseGrid({ kind: 4 })).toBeNull();
    expect(parseGrid(null)).toBeNull();
    expect(parseGrid({ kind: 2, origin: [1, 2], cell: -5 })!.cell).toBe(2);
  });
});
