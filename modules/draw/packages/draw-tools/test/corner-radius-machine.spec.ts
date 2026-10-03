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
  cornerAt,
  cornerPreview,
  maxRadius,
  radiusFromDrag,
  type Bounds,
} from "../src/corner-radius-machine";

// A 100×60 rectangle: top 10, left 20, bottom 70, right 120.
const B: Bounds = [10, 20, 70, 120];

describe("cornerAt", () => {
  it("hits each corner within tolerance, in IDML order", () => {
    expect(cornerAt(B, [21, 11], 4)).toBe(0); // TL
    expect(cornerAt(B, [119, 12], 4)).toBe(1); // TR
    expect(cornerAt(B, [118, 69], 4)).toBe(2); // BR
    expect(cornerAt(B, [22, 68], 4)).toBe(3); // BL
    expect(cornerAt(B, [70, 40], 4)).toBeNull(); // center — no corner
  });
});

describe("radiusFromDrag", () => {
  it("reads the inward drag and clamps to half the short side", () => {
    // TL inward drag by (15, 12) → the smaller inward axis wins: 12.
    expect(radiusFromDrag(B, 0, [35, 22])).toBe(12);
    // Dragging past the middle clamps to min(w,h)/2 = 30.
    expect(radiusFromDrag(B, 0, [120, 70])).toBe(30);
    expect(maxRadius(B)).toBe(30);
  });

  it("an outward drag reads 0 (never a negative radius)", () => {
    expect(radiusFromDrag(B, 0, [0, 0])).toBe(0);
    // BR corner outward.
    expect(radiusFromDrag(B, 2, [130, 80])).toBe(0);
  });
});

describe("cornerPreview", () => {
  it("draws the L through the corner with the radius extent on both edges", () => {
    expect(cornerPreview(B, 0, 10)).toEqual([
      [30, 10],
      [20, 10],
      [20, 20],
    ]);
    expect(cornerPreview(B, 2, 8)).toEqual([
      [112, 70],
      [120, 70],
      [120, 62],
    ]);
  });
});

// ---- POLYGON corners: the renderer's inscribed-circle rule, inner space.
import {
  polygonCornerAt,
  polygonCornerPreview,
  polygonCorners,
  polygonRadiusFromDrag,
  polygonTangentFromDrag,
} from "../src/corner-radius-machine";
import type { AnchorTable } from "@paged-media/draw-geometry";

const pt = (x: number, y: number) => ({
  anchor: [x, y] as [number, number],
  left: [x, y] as [number, number],
  right: [x, y] as [number, number],
});

/** A closed right triangle (0,0) (100,0) (0,100). */
const TRIANGLE: AnchorTable = {
  anchors: [pt(0, 0), pt(100, 0), pt(0, 100)],
  subpathStarts: [0],
  subpathOpen: [false],
};

describe("polygonCorners", () => {
  it("one corner per straight-straight anchor of a CLOSED contour, with its real angle", () => {
    const corners = polygonCorners(TRIANGLE);
    expect(corners.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(corners[0]!.halfAngle).toBeCloseTo(Math.PI / 4, 12);
    expect(corners[1]!.halfAngle).toBeCloseTo(Math.PI / 8, 12);
  });

  it("an OPEN contour has no corners; a CURVED junction gets no handle", () => {
    expect(polygonCorners({ ...TRIANGLE, subpathOpen: [true] })).toEqual([]);
    const curved: AnchorTable = {
      anchors: [pt(0, 0), { anchor: [100, 0], left: [80, -20], right: [100, 0] }, pt(0, 100)],
      subpathStarts: [0],
      subpathOpen: [false],
    };
    // Segment 0 → 1 is curved, so neither of its ends is a corner.
    expect(polygonCorners(curved).map((c) => c.index)).toEqual([2]);
  });

  it("hit-testing finds the nearest corner within tolerance", () => {
    const corners = polygonCorners(TRIANGLE);
    expect(polygonCornerAt(corners, [99, 2], 4)?.index).toBe(1);
    expect(polygonCornerAt(corners, [50, 50], 4)).toBeNull();
  });
});

describe("polygon radius from a drag", () => {
  it("at a RIGHT angle the radius IS the tangent distance (the box rule)", () => {
    const tl = polygonCorners(TRIANGLE)[0]!;
    expect(polygonRadiusFromDrag(tl, [10, 14])).toBeCloseTo(10, 12);
  });

  it("at 45° the radius is d · tan(22.5°), and the preview meets the edges d back", () => {
    const acute = polygonCorners(TRIANGLE)[1]!;
    // Drag 20 pt back along the base (toward (0,0)).
    const d = polygonTangentFromDrag(acute, [80, 0.5]);
    expect(d).toBeCloseTo(Math.min(20, 20 * Math.SQRT1_2 + 0.5 * Math.SQRT1_2), 6);
    const r = polygonRadiusFromDrag(acute, [80, 0.5]);
    expect(r).toBeCloseTo(d * Math.tan(Math.PI / 8), 12);
    const [pin, c, pout] = polygonCornerPreview(acute, r);
    expect(c).toEqual([100, 0]);
    expect(Math.hypot(pin![0] - 100, pin![1])).toBeCloseTo(d, 9);
    expect(Math.hypot(pout![0] - 100, pout![1])).toBeCloseTo(d, 9);
  });

  it("is clamped to half the shorter edge, and to 0 outside the corner", () => {
    const tl = polygonCorners(TRIANGLE)[0]!;
    expect(polygonRadiusFromDrag(tl, [500, 500])).toBeCloseTo(50, 12);
    expect(polygonRadiusFromDrag(tl, [-10, -10])).toBe(0);
  });
});
