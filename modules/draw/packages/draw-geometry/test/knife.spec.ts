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
  boundsOverlap,
  contourSignedArea,
  nearestOnPolyline,
  pointInPolygon,
  sliverAround,
  snapOntoPolyline,
  tableBounds,
  MITRE_LIMIT,
  type AnchorTable,
  type Vec2,
} from "../src/index";

const corner = (x: number, y: number) => ({
  anchor: [x, y] as [number, number],
  left: [x, y] as [number, number],
  right: [x, y] as [number, number],
});

describe("knife — the strip around a cut", () => {
  it("a straight cut becomes a closed rectangle exactly `width` wide, corners on their anchors", () => {
    const s = sliverAround([[0, 10], [100, 10]], 2)!;
    expect(s.map((a) => a.anchor)).toEqual([
      [0, 11],
      [100, 11],
      [100, 9],
      [0, 9],
    ]);
    for (const a of s) {
      expect(a.left).toEqual(a.anchor);
      expect(a.right).toEqual(a.anchor);
    }
    expect(Math.abs(contourSignedArea(s))).toBeCloseTo(200, 9);
  });

  it("a corner is MITRED: both offsets stay exactly half a width from both segments", () => {
    const s = sliverAround(
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      2,
    )!;
    // 3 points per side; the corner point sits on the bisector at h/cos(45°).
    expect(s).toHaveLength(6);
    const mitre = s[1].anchor;
    expect(Math.hypot(mitre[0] - 10, mitre[1])).toBeCloseTo(Math.SQRT2, 9);
    // The strip covers the line it was built around.
    const ring = s.map((a) => a.anchor);
    for (const p of [
      [5, 0],
      [10, 0],
      [10, 5],
    ] as Vec2[]) {
      expect(pointInPolygon(p, ring)).toBe(true);
    }
  });

  it("a hairpin turn is CLAMPED to the mitre limit instead of spiking", () => {
    const s = sliverAround(
      [
        [0, 0],
        [100, 0],
        [0, 1],
      ],
      2,
    )!;
    const reach = Math.hypot(s[1].anchor[0] - 100, s[1].anchor[1]);
    expect(reach).toBeLessThanOrEqual(MITRE_LIMIT * 1 + 1e-9);
  });

  it("refuses what is not a cut: one point, duplicates only, a non-positive width", () => {
    expect(sliverAround([[1, 1]], 1)).toBeNull();
    expect(sliverAround([[1, 1], [1, 1]], 1)).toBeNull();
    expect(sliverAround([[0, 0], [1, 0]], 0)).toBeNull();
    expect(sliverAround([[0, 0], [1, 0]], Number.NaN)).toBeNull();
  });
});

describe("knife — closing the strip's gap", () => {
  it("anchors within tolerance move ONTO the cut, handles riding along; the rest stay", () => {
    const table: AnchorTable = {
      anchors: [
        corner(0, 0),
        { anchor: [50, 0], left: [40, -5], right: [50, 0] },
        { anchor: [50, 49.97], left: [50, 49.97], right: [55, 49.97] },
        corner(0, 49.97),
      ],
      subpathStarts: [0],
      subpathOpen: [false],
    };
    const out = snapOntoPolyline(table, [[-10, 50], [110, 50]], 0.05);
    expect(out.anchors[0]).toEqual(table.anchors[0]);
    expect(out.anchors[1]).toEqual(table.anchors[1]);
    expect(out.anchors[2].anchor[1]).toBeCloseTo(50, 12);
    expect(out.anchors[2].right[0]).toBeCloseTo(55, 12);
    expect(out.anchors[2].right[1]).toBeCloseTo(50, 12);
    expect(out.anchors[3].anchor).toEqual([0, 50]);
    expect(out.subpathStarts).toEqual([0]);
    expect(out.subpathOpen).toEqual([false]);
  });

  it("a corner where an OBLIQUE cut meets the outline SLIDES ALONG the outline — the edge keeps its line", () => {
    // The right half of a square cut by a line at 30°, the strip's half
    // width (0.05) off the cut: corner 1 sits on the square's left edge
    // x = 0, just above the cut.
    const k = Math.tan(Math.PI / 6);
    const cutY = (x: number) => 50 - k * (x - 50);
    const off = 0.05 / Math.cos(Math.PI / 6);
    const table: AnchorTable = {
      anchors: [
        corner(0, 0),
        corner(0, cutY(0) - off),
        corner(100, cutY(100) - off),
        corner(100, 0),
      ],
      subpathStarts: [0],
      subpathOpen: [false],
    };
    const cut: Vec2[] = [
      [-20, cutY(-20)],
      [120, cutY(120)],
    ];
    const out = snapOntoPolyline(table, cut, 0.08);
    // On the cut, and still on the square's vertical edges.
    expect(out.anchors[1].anchor[0]).toBeCloseTo(0, 12);
    expect(out.anchors[1].anchor[1]).toBeCloseTo(cutY(0), 9);
    expect(out.anchors[2].anchor[0]).toBeCloseTo(100, 12);
    expect(out.anchors[2].anchor[1]).toBeCloseTo(cutY(100), 9);
  });

  it("an anchor whose neighbours both lie along the cut (a bend of the cut) is projected onto it", () => {
    const table: AnchorTable = {
      anchors: [corner(0, 0.04), corner(10, 0.04), corner(10, 50), corner(0, 50)],
      subpathStarts: [0],
    };
    // Both 0 and 1 are near the cut, so neither may slide; each drops
    // straight onto y = 0.
    const out = snapOntoPolyline(table, [[-5, 0], [15, 0]], 0.05);
    expect(out.anchors[0].anchor).toEqual([0, 0]);
    expect(out.anchors[1].anchor).toEqual([10, 0]);
  });

  it("the nearest point is found on the right SEGMENT of a bent cut", () => {
    const near = nearestOnPolyline([12, 4], [
      [0, 0],
      [10, 0],
      [10, 10],
    ])!;
    expect(near.point).toEqual([10, 4]);
    expect(near.distance).toBeCloseTo(2, 12);
  });
});

describe("knife — bounds", () => {
  it("tableBounds is [top, left, bottom, right] over anchors AND handles", () => {
    expect(
      tableBounds({
        anchors: [
          { anchor: [10, 10], left: [5, 12], right: [10, 10] },
          { anchor: [20, 30], left: [20, 30], right: [25, 31] },
        ],
      }),
    ).toEqual([10, 5, 31, 25]);
    expect(tableBounds({ anchors: [] })).toBeNull();
  });

  it("boundsOverlap: touching counts, apart does not", () => {
    expect(boundsOverlap([0, 0, 10, 10], [10, 10, 20, 20])).toBe(true);
    expect(boundsOverlap([0, 0, 10, 10], [11, 0, 20, 10])).toBe(false);
  });
});
