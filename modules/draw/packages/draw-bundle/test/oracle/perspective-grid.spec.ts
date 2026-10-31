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

// ORACLE — Illustrator's PERSPECTIVE GRID against draw-geometry's
// (`src/warp/perspective-grid.ts`, `src/warp/homography.ts`).
//
// The recording (`scripts/illustrator/probes/perspective-grid.jsx`) draws
// four rectangles and an ellipse on each plane of Illustrator's default
// two-point grid: with the grid shown and a plane active,
// `pathItems.rectangle(top, left, width, height)` takes its arguments as
// that PLANE's coordinates and comes back projected. What is asserted:
//
//   1. EACH PLANE IS ONE HOMOGRAPHY: `homographyFromQuads` fitted to ONE
//      rectangle (its four corners, in the order Illustrator emits them)
//      predicts the other three to 0.05 pt. One corner order fits all
//      three planes.
//   2. THE TWO-POINT STRUCTURE: the left and right planes' verticals stay
//      vertical (their v direction maps to a point at infinity straight
//      up), their ground lines run to vanishing points on ONE horizontal
//      horizon, and the floor's two vanishing points ARE those two.
//   3. OUR CONSTRUCTION SPANS ILLUSTRATOR'S: a draw-geometry grid built
//      from those vanishing points and horizon, with its origin where
//      Illustrator's plane origin lands, reproduces every recorded corner
//      once the plane's two axes are rescaled (Illustrator's plane unit
//      is its grid cell, ours is a point at the origin) — 0.1 pt.
//
// CONVENTION (recorded, not a defect): Illustrator maps an ellipse's
// control points and keeps its FOUR anchors (every `*-ellipse` case);
// `mapTableProjective` subdivides a curve until the projective error is
// under its tolerance, so a strongly foreshortened ellipse gets more
// anchors and stays on the true conic. Both are pinned below.
//
// `PageItem.bringInPerspective` answers PARM for every plane and
// position in Illustrator 30.1, so the attach-by-drag verb has no
// scriptable oracle; drawing on the plane exercises the same plane map.

import { describe, expect, it } from "bun:test";

import {
  applyHomography,
  homographyFromQuads,
  invertHomography,
  mapTableProjective,
  planeHomography,
  defaultGrid,
  type Homography,
  type Vec2,
} from "@paged-media/draw-geometry";

import { loadOracle } from "./oracle";

interface Params {
  plane: "left" | "right" | "floor";
  shape: "rectangle" | "ellipse";
  top: number;
  left: number;
  width: number;
  height: number;
}

const FIXTURE = loadOracle<Params>("perspective-grid");
type P = [number, number];

/** The four corners of a case's rectangle in Illustrator's plane
 *  coordinates (its arguments; Y up), clockwise from top-left. */
const cornersOf = (p: Params): P[] => [
  [p.left, p.top],
  [p.left + p.width, p.top],
  [p.left + p.width, p.top - p.height],
  [p.left, p.top - p.height],
];

/** The eight ways four corners can be listed (start × direction). */
const ORDERS: number[][] = [0, 1, 2, 3].flatMap((s) => [
  [0, 1, 2, 3].map((k) => (s + k) % 4),
  [0, 1, 2, 3].map((k) => (s - k + 4) % 4),
]);

const rects = (plane: Params["plane"]) =>
  FIXTURE.cases.filter(
    (c) => c.parameters.plane === plane && c.parameters.shape === "rectangle",
  );

const recorded = (c: (typeof FIXTURE.cases)[number]): P[] =>
  c.measured.paths[0]!.anchors.map((a) => [a.anchor[0], a.anchor[1]] as P);

/** The homography from plane coordinates to the page, fitted to the
 *  plane's first rectangle with corner order `order`. */
const fitted = (plane: Params["plane"], order: number[]): Homography | null => {
  const c0 = rects(plane)[0]!;
  const from = cornersOf(c0.parameters);
  const to = recorded(c0);
  return homographyFromQuads(
    order.map((k) => from[k]!) as [P, P, P, P],
    to as [P, P, P, P],
  );
};

const worstError = (
  plane: Params["plane"],
  h: Homography,
  order: number[],
): number => {
  let worst = 0;
  for (const c of rects(plane)) {
    const from = cornersOf(c.parameters);
    const to = recorded(c);
    order.forEach((k, i) => {
      const q = applyHomography(h, from[k]!)!;
      worst = Math.max(worst, Math.hypot(q[0] - to[i]![0], q[1] - to[i]![1]));
    });
  }
  return worst;
};

const bestOrder = (plane: Params["plane"]) => {
  let best = { order: ORDERS[0]!, error: Infinity };
  for (const order of ORDERS) {
    const h = fitted(plane, order);
    if (!h) continue;
    const error = worstError(plane, h, order);
    if (error < best.error) best = { order, error };
  }
  return best;
};

/** Where the plane's x (u) and y (v) directions vanish. */
const vanishing = (h: Homography) => ({
  u: Math.abs(h[6]) > 1e-12 ? ([h[0] / h[6], h[3] / h[6]] as P) : null,
  v: Math.abs(h[7]) > 1e-12 ? ([h[1] / h[7], h[4] / h[7]] as P) : null,
  vDir: [h[1], h[4]] as P,
});

const near = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe("oracle — the perspective grid (Illustrator 30.1) [plugin-draw.distortion-tools]", () => {
  it("records Illustrator, 15 cases: four rectangles and an ellipse per plane", () => {
    expect(FIXTURE.produced_by.app).toContain("Illustrator");
    expect(FIXTURE.cases).toHaveLength(15);
  });

  const orders = new Map<string, number[]>();
  const homographies = new Map<string, Homography>();
  for (const plane of ["right", "left", "floor"] as const) {
    it(`${plane} plane: one homography, fitted to one rectangle, predicts the other three to 0.05 pt`, () => {
      const { order, error } = bestOrder(plane);
      expect(error).toBeLessThan(0.05);
      orders.set(plane, order);
      homographies.set(plane, fitted(plane, order)!);
    });
  }

  it("one corner order fits all three planes", () => {
    const [r, l, f] = ["right", "left", "floor"].map((p) =>
      JSON.stringify(orders.get(p)),
    );
    expect(l).toBe(r);
    expect(f).toBe(r);
  });

  it("two-point structure: verticals stay vertical, both ground lines vanish on ONE horizontal horizon, the floor vanishes at those two points", () => {
    const right = vanishing(homographies.get("right")!);
    const left = vanishing(homographies.get("left")!);
    const floor = vanishing(homographies.get("floor")!);
    // Verticals: v vanishes at infinity, straight up or down the page.
    for (const s of [right, left]) {
      expect(s.v).toBeNull();
      expect(Math.abs(s.vDir[0])).toBeLessThan(1e-6 * Math.abs(s.vDir[1]));
    }
    expect(right.u).not.toBeNull();
    expect(left.u).not.toBeNull();
    // One horizon, horizontal.
    expect(Math.abs(right.u![1] - left.u![1])).toBeLessThan(0.5);
    // The floor's two vanishing points are the walls'.
    const pair = [floor.u!, floor.v!];
    expect(Math.min(...pair.map((q) => near(q, right.u!)))).toBeLessThan(0.5);
    expect(Math.min(...pair.map((q) => near(q, left.u!)))).toBeLessThan(0.5);
  });

  for (const plane of ["right", "left"] as const) {
    it(`our construction reproduces Illustrator's ${plane} plane once its axes are rescaled (0.1 pt)`, () => {
      const hAi = homographies.get(plane)!;
      const right = vanishing(homographies.get("right")!).u!;
      const left = vanishing(homographies.get("left")!).u!;
      const origin = applyHomography(hAi, [0, 0])!;
      const grid = {
        ...defaultGrid(2, 612, 792),
        horizonY: (right[1] + left[1]) / 2,
        vpLeft: left[0],
        vpRight: right[0],
        origin,
      };
      const ours = planeHomography(grid, plane)!;
      const inv = invertHomography(ours)!;
      // Our object-frame coordinates of Illustrator's unit points give the
      // two axis scales (signed: Illustrator's y is up, ours down; the
      // left plane runs mirrored in ours).
      const ux = applyHomography(inv, applyHomography(hAi, [1, 0])!)!;
      const vy = applyHomography(inv, applyHomography(hAi, [0, 1])!)!;
      expect(Math.abs(ux[1])).toBeLessThan(1e-6);
      expect(Math.abs(vy[0])).toBeLessThan(1e-6);
      const a = ux[0];
      const b = vy[1];
      let worst = 0;
      for (const c of rects(plane)) {
        const from = cornersOf(c.parameters);
        const to = recorded(c);
        orders.get(plane)!.forEach((k, i) => {
          const q = applyHomography(ours, [a * from[k]![0], b * from[k]![1]])!;
          worst = Math.max(worst, near(q, to[i]!));
        });
      }
      expect(worst).toBeLessThan(0.1);
    });
  }

  it("CONVENTION — Illustrator keeps an ellipse's four anchors; mapTableProjective subdivides it onto the true conic", () => {
    for (const plane of ["right", "left", "floor"] as const) {
      const c = FIXTURE.cases.find((x) => x.id === `${plane}-ellipse`)!;
      expect(c.measured.paths[0]!.anchors).toHaveLength(4);
      // The same ellipse through the fitted plane map, ours.
      const p = c.parameters;
      const k = 0.5522847498307936;
      const cx = p.left + p.width / 2;
      const cy = p.top - p.height / 2;
      const rx = p.width / 2;
      const ry = p.height / 2;
      const pt = (x: number, y: number): P => [x, y];
      const flat = {
        anchors: [
          {
            anchor: pt(cx + rx, cy),
            left: pt(cx + rx, cy - k * ry),
            right: pt(cx + rx, cy + k * ry),
          },
          {
            anchor: pt(cx, cy + ry),
            left: pt(cx + k * rx, cy + ry),
            right: pt(cx - k * rx, cy + ry),
          },
          {
            anchor: pt(cx - rx, cy),
            left: pt(cx - rx, cy + k * ry),
            right: pt(cx - rx, cy - k * ry),
          },
          {
            anchor: pt(cx, cy - ry),
            left: pt(cx - k * rx, cy - ry),
            right: pt(cx + k * rx, cy - ry),
          },
        ],
        subpathStarts: [0],
      };
      const ours = mapTableProjective(flat, homographies.get(plane)!, 0.05)!;
      expect(ours.anchors.length).toBeGreaterThanOrEqual(4);
      // Illustrator's four on-curve anchors are the projected quadrant
      // points — ours pass through every one of them.
      for (const a of c.measured.paths[0]!.anchors)
        expect(
          Math.min(...ours.anchors.map((o) => near(o.anchor, a.anchor))),
        ).toBeLessThan(0.05);
    }
  });
});
