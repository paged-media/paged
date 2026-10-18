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

import { describe, expect, it } from "vitest";

import {
  flattenAnchorPath,
  flattenAnchorRun,
  pointInAnchorPath,
  pointInFlatPath,
  pointInPolygon,
  polylineTouchesPolygon,
  segmentsTouch,
  type AnchorTriple,
  type Vec2,
} from "../src";

const SQUARE: Vec2[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

describe("pointInPolygon", () => {
  it("inside / outside a convex square", () => {
    expect(pointInPolygon([5, 5], SQUARE)).toBe(true);
    expect(pointInPolygon([15, 5], SQUARE)).toBe(false);
    expect(pointInPolygon([-1, 5], SQUARE)).toBe(false);
    expect(pointInPolygon([5, 11], SQUARE)).toBe(false);
  });

  it("handles a concave (L-shaped) ring by even-odd crossings", () => {
    const L: Vec2[] = [
      [0, 0],
      [10, 0],
      [10, 4],
      [4, 4],
      [4, 10],
      [0, 10],
    ];
    expect(pointInPolygon([2, 8], L)).toBe(true); // in the vertical leg
    expect(pointInPolygon([8, 2], L)).toBe(true); // in the horizontal leg
    expect(pointInPolygon([8, 8], L)).toBe(false); // in the notch
  });

  it("winding order does not matter", () => {
    const reversed = [...SQUARE].reverse();
    expect(pointInPolygon([5, 5], reversed)).toBe(true);
    expect(pointInPolygon([15, 5], reversed)).toBe(false);
  });

  it("fewer than 3 vertices answers false", () => {
    expect(pointInPolygon([0, 0], [])).toBe(false);
    expect(
      pointInPolygon(
        [0, 0],
        [
          [0, 0],
          [1, 1],
        ],
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------
// B-22 — `pointInAnchorPath`: the same even-odd rule over a CUBIC
// anchor table with contours, the shape a planar FACE comes back in.
// It is what lets the Shape Builder resolve the face under the cursor
// LOCALLY from a cached arrangement.

const corners = (pts: Vec2[]): AnchorTriple[] =>
  pts.map((p) => ({
    anchor: [p[0], p[1]],
    left: [p[0], p[1]],
    right: [p[0], p[1]],
  }));

const OUTER = corners([
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
]);
const HOLE = corners([
  [40, 40],
  [60, 40],
  [60, 60],
  [40, 60],
]);

describe("pointInAnchorPath", () => {
  it("a straight-edged single contour behaves like the polygon test", () => {
    expect(pointInAnchorPath([50, 50], OUTER)).toBe(true);
    expect(pointInAnchorPath([150, 50], OUTER)).toBe(false);
    expect(pointInAnchorPath([-1, 50], OUTER)).toBe(false);
  });

  it("an empty subpathStarts means the single-contour case (the wire convention)", () => {
    expect(pointInAnchorPath([50, 50], OUTER, [])).toBe(true);
    expect(pointInAnchorPath([50, 50], OUTER, [0])).toBe(true);
  });

  it("a HOLE contour is subtracted — a point inside it answers false", () => {
    const anchors = [...OUTER, ...HOLE];
    const starts = [0, OUTER.length];
    expect(pointInAnchorPath([50, 50], anchors, starts)).toBe(false);
    expect(pointInAnchorPath([10, 10], anchors, starts)).toBe(true);
    expect(pointInAnchorPath([70, 50], anchors, starts)).toBe(true);
  });

  it("curved edges are flattened — a quarter-disc bulge is inside", () => {
    // A square whose top edge bows UP to y = -20 (a cubic).
    const k = 26.6667; // 4/3 * tan(pi/8)-ish; the exact value is not
    // load-bearing — only that the bulge is well outside the chord.
    const bowed: AnchorTriple[] = [
      { anchor: [0, 0], left: [0, 0], right: [0, -k] },
      { anchor: [100, 0], left: [100, -k], right: [100, 0] },
      { anchor: [100, 100], left: [100, 100], right: [100, 100] },
      { anchor: [0, 100], left: [0, 100], right: [0, 100] },
    ];
    // A point ABOVE the chord but under the bow is inside.
    expect(pointInAnchorPath([50, -10], bowed)).toBe(true);
    // Far above the bow it is not.
    expect(pointInAnchorPath([50, -40], bowed)).toBe(false);
  });

  it("fewer than 3 CORNER anchors enclose nothing and answer false", () => {
    expect(pointInAnchorPath([0, 0], [])).toBe(false);
    expect(pointInAnchorPath([0, 0], OUTER.slice(0, 2))).toBe(false);
    // Not on the degenerate ring itself either: nowhere is inside it.
    expect(pointInAnchorPath([50, 0.5], OUTER.slice(0, 2))).toBe(false);
    expect(pointInAnchorPath([0.5, 0.5], OUTER.slice(0, 1))).toBe(false);
  });

  it("two CURVED anchors are a lens, and it contains its middle", () => {
    // The count of anchors does not decide — the flattened ring does.
    const lens: AnchorTriple[] = [
      { anchor: [0, 0], left: [3, -5], right: [3, 5] },
      { anchor: [10, 0], left: [7, 5], right: [7, -5] },
    ];
    expect(pointInAnchorPath([5, 0], lens)).toBe(true);
    expect(pointInAnchorPath([5, 6], lens)).toBe(false);
    expect(pointInAnchorPath([-1, 0], lens)).toBe(false);
    // As a HOLE in a larger contour it is subtracted like any other.
    const plate: AnchorTriple[] = corners([
      [-20, -20],
      [30, -20],
      [30, 20],
      [-20, 20],
    ]);
    expect(pointInAnchorPath([5, 0], [...plate, ...lens], [0, 4])).toBe(false);
    expect(pointInAnchorPath([-10, 0], [...plate, ...lens], [0, 4])).toBe(true);
  });

  it("a degenerate contour in the table is skipped, not counted", () => {
    const anchors = [
      ...OUTER,
      ...corners([
        [200, 200],
        [201, 201],
      ]),
    ];
    expect(pointInAnchorPath([50, 50], anchors, [0, OUTER.length])).toBe(true);
  });
});

// ---------------------------------------------------------------------
// `flattenAnchorPath` + `pointInFlatPath`: the same test, flattened once,
// behind a bounding box. The box is an optimisation and must not be an
// opinion — so it is checked against a crossing count that has NO box,
// written out here, at exactly the places a box could disagree: on its
// edges, a rounding error either side of them, and well clear of them.

/** Even-odd over the flattened contours, edge by edge, nothing skipped. */
function crossingsOnly(
  point: Vec2,
  anchors: readonly AnchorTriple[],
  starts: readonly number[],
): boolean {
  const [px, py] = point;
  const from = starts.length > 0 ? starts : [0];
  let inside = false;
  from.forEach((start, s) => {
    const end = s + 1 < from.length ? from[s + 1] : anchors.length;
    const ring = flattenAnchorRun(anchors.slice(start, end), { close: true });
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  });
  return inside;
}

describe("flattenAnchorPath + pointInFlatPath", () => {
  const circle = (cx: number, cy: number, r: number): AnchorTriple[] => {
    const k = r * 0.5522847498;
    return [
      { anchor: [cx + r, cy], left: [cx + r, cy - k], right: [cx + r, cy + k] },
      { anchor: [cx, cy + r], left: [cx + k, cy + r], right: [cx - k, cy + r] },
      { anchor: [cx - r, cy], left: [cx - r, cy + k], right: [cx - r, cy - k] },
      { anchor: [cx, cy - r], left: [cx - k, cy - r], right: [cx + k, cy - r] },
    ];
  };
  const SHAPES: Array<{
    name: string;
    anchors: AnchorTriple[];
    starts: number[];
  }> = [
    { name: "a square", anchors: OUTER, starts: [] },
    { name: "a square with a hole", anchors: [...OUTER, ...HOLE], starts: [0, OUTER.length] },
    { name: "a circle", anchors: circle(306.25, 395.5, 84.3), starts: [0] },
    {
      name: "a lens",
      anchors: [
        { anchor: [0, 0], left: [3, -5], right: [3, 5] },
        { anchor: [10, 0], left: [7, 5], right: [7, -5] },
      ],
      starts: [],
    },
    {
      name: "a circle and a far square, one table",
      anchors: [...circle(-40.7, 12.3, 9.9), ...OUTER],
      starts: [0, 4],
    },
    // Far from the origin, where an ulp is big.
    { name: "a circle a million points out", anchors: circle(1e6 + 0.3, -1e6 - 0.7, 50.1), starts: [] },
  ];
  /** Offsets from a box edge: on it, a rounding error off it, a hair
   *  off it, clearly off it. */
  const NUDGES = [0, 1e-13, -1e-13, 1e-10, -1e-10, 1e-7, -1e-7, 1e-3, -1e-3, 5, -5];

  it.each(SHAPES)("$name: the flat form answers exactly what the anchor form answers", ({ anchors, starts }) => {
    const flat = flattenAnchorPath(anchors, starts);
    const xs = [flat.minX, flat.maxX, (flat.minX + flat.maxX) / 2];
    const ys = [flat.minY, flat.maxY, (flat.minY + flat.maxY) / 2];
    // Also every vertex height: a ray through a vertex is where a
    // crossing count is most easily miscounted.
    for (const ring of flat.rings) for (const [, y] of ring) ys.push(y);
    let probes = 0;
    let inside = 0;
    for (const x0 of xs) {
      for (const y0 of ys) {
        for (const dx of NUDGES) {
          for (const dy of NUDGES) {
            const scale = Math.max(1, Math.abs(x0), Math.abs(y0));
            const p: Vec2 = [x0 + dx * scale, y0 + dy * scale];
            const expected = crossingsOnly(p, anchors, starts);
            expect(pointInFlatPath(p, flat), `at ${p[0]}, ${p[1]}`).toBe(expected);
            expect(pointInAnchorPath(p, anchors, starts)).toBe(expected);
            probes++;
            if (expected) inside++;
          }
        }
      }
    }
    // The sweep is not all-outside (which a box would get right for
    // free) nor all-inside.
    expect(probes).toBeGreaterThan(1000);
    expect(inside).toBeGreaterThan(0);
    expect(inside).toBeLessThan(probes);
  });

  it("the box is the box of the flattened rings, and an empty path contains nothing", () => {
    const flat = flattenAnchorPath(OUTER);
    expect([flat.minX, flat.minY, flat.maxX, flat.maxY]).toEqual([0, 0, 100, 100]);
    expect(flat.rings).toHaveLength(1);
    const none = flattenAnchorPath([]);
    expect(none.minX).toBeGreaterThan(none.maxX);
    expect(pointInFlatPath([0, 0], none)).toBe(false);
  });

  it("flattening once is flattening the same: the rings are flattenAnchorRun's, per contour", () => {
    const anchors = [...OUTER, ...HOLE];
    const flat = flattenAnchorPath(anchors, [0, OUTER.length], { samplesPerSegment: 5 });
    expect(flat.rings).toEqual([
      flattenAnchorRun(OUTER, { close: true, samplesPerSegment: 5 }),
      flattenAnchorRun(HOLE, { close: true, samplesPerSegment: 5 }),
    ]);
  });
});

describe("polylineTouchesPolygon — the lasso's outline-intersection test", () => {
  const BOX: Vec2[] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];

  it("segmentsTouch is inclusive: crossing, touching an end and collinear overlap all count", () => {
    expect(segmentsTouch([0, 0], [10, 10], [0, 10], [10, 0])).toBe(true);
    expect(segmentsTouch([0, 0], [5, 5], [5, 5], [9, 1])).toBe(true);
    expect(segmentsTouch([0, 0], [6, 0], [4, 0], [9, 0])).toBe(true);
    expect(segmentsTouch([0, 0], [3, 0], [4, 0], [9, 0])).toBe(false);
    expect(segmentsTouch([0, 0], [10, 0], [0, 1], [10, 1])).toBe(false);
    expect(segmentsTouch([0, 0], [4, 4], [5, 0], [9, -4])).toBe(false);
  });

  it("a polyline with a vertex inside touches", () => {
    expect(polylineTouchesPolygon([[5, 5], [50, 50]], BOX)).toBe(true);
  });

  it("a polyline that only CROSSES the region (no vertex inside) touches", () => {
    expect(polylineTouchesPolygon([[-5, 5], [15, 5]], BOX)).toBe(true);
  });

  it("a polyline outside a CONCAVE lasso's region but inside its box does not touch", () => {
    // An L-shaped lasso; (7..9, 7..9) is in its box, not its region.
    const L: Vec2[] = [
      [0, 0],
      [10, 0],
      [10, 4],
      [4, 4],
      [4, 10],
      [0, 10],
    ];
    expect(polylineTouchesPolygon([[7, 7], [9, 9]], L)).toBe(false);
    expect(polylineTouchesPolygon([[20, 20], [30, 30]], L)).toBe(false);
  });

  it("the CLOSING segment counts only for a closed polyline", () => {
    // A U whose closing edge (15,5)→(-5,5) would cut through the box.
    const u: Vec2[] = [
      [15, 5],
      [15, 20],
      [-5, 20],
      [-5, 5],
    ];
    expect(polylineTouchesPolygon(u, BOX)).toBe(false);
    expect(polylineTouchesPolygon(u, BOX, { closed: true })).toBe(true);
  });

  it("a lasso wholly INSIDE a closed outline does not touch the outline (the documented scope)", () => {
    const big: Vec2[] = [
      [-100, -100],
      [100, -100],
      [100, 100],
      [-100, 100],
    ];
    expect(polylineTouchesPolygon(big, BOX, { closed: true })).toBe(false);
    expect(pointInPolygon(BOX[0], big)).toBe(true);
  });

  it("degenerate input answers false, never throws; a single point is a point test", () => {
    expect(polylineTouchesPolygon([], BOX)).toBe(false);
    expect(polylineTouchesPolygon([[5, 5]], [[0, 0], [1, 1]])).toBe(false);
    expect(polylineTouchesPolygon([[5, 5]], BOX)).toBe(true);
    expect(polylineTouchesPolygon([[50, 5]], BOX)).toBe(false);
  });
});
