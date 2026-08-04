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
  pointInAnchorPath,
  pointInPolygon,
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

  it("fewer than 3 anchors answers false", () => {
    expect(pointInAnchorPath([0, 0], [])).toBe(false);
    expect(pointInAnchorPath([0, 0], OUTER.slice(0, 2))).toBe(false);
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
