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

// SVG basic-shape → anchor-table conversions. Each shape lowers to its
// path equivalent; we assert anchor counts, the closed flag, on-curve
// extrema, and (for circle/ellipse) that the κ-approximation passes
// through the cardinal points and stays within tolerance of the true
// conic on a dense sample.

import { describe, expect, it } from "vitest";

import {
  rectToPath,
  circleToPath,
  ellipseToPath,
  lineToPath,
  mapTable,
  ovalToPath,
  polyToPath,
  evalCubic,
  type AnchorTable,
} from "../src";

function outline(t: AnchorTable, per = 24): [number, number][] {
  const out: [number, number][] = [];
  const n = t.anchors.length;
  const closed = !(t.subpathOpen?.[0] ?? false);
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = t.anchors[i];
    const b = t.anchors[(i + 1) % n];
    for (let k = 0; k < per; k++) {
      out.push(evalCubic(a.anchor, a.right, b.left, b.anchor, k / per));
    }
  }
  return out;
}

describe("rectToPath", () => {
  it("sharp rect → 4 closed corners", () => {
    const t = rectToPath(10, 20, 100, 50);
    expect(t.anchors.length).toBe(4);
    expect(t.subpathOpen).toEqual([false]);
    expect(t.anchors.map((a) => a.anchor)).toEqual([
      [10, 20],
      [110, 20],
      [110, 70],
      [10, 70],
    ]);
  });

  it("rounded rect → 8 anchors, corners inset by the radius", () => {
    const t = rectToPath(0, 0, 100, 80, 10, 10);
    expect(t.anchors.length).toBe(8);
    expect(t.subpathOpen).toEqual([false]);
    // The bounding box of the outline matches the rect.
    const pts = outline(t);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(0, 5);
    expect(Math.max(...xs)).toBeCloseTo(100, 5);
    expect(Math.min(...ys)).toBeCloseTo(0, 5);
    expect(Math.max(...ys)).toBeCloseTo(80, 5);
  });

  it("radius clamps to half the side", () => {
    const t = rectToPath(0, 0, 20, 20, 50, 50);
    // rx/ry clamp to 10; the outline still fits the box.
    const pts = outline(t);
    expect(Math.max(...pts.map((p) => p[0]))).toBeCloseTo(20, 5);
  });

  it("degenerate size → empty", () => {
    expect(rectToPath(0, 0, 0, 10).anchors).toHaveLength(0);
  });
});

describe("circleToPath / ellipseToPath", () => {
  it("circle passes through the 4 cardinal points", () => {
    const t = circleToPath(50, 50, 40);
    expect(t.anchors.length).toBe(4);
    expect(t.anchors.map((a) => a.anchor)).toEqual([
      [90, 50],
      [50, 90],
      [10, 50],
      [50, 10],
    ]);
  });

  it("circle outline stays within ~0.03% of r everywhere", () => {
    const r = 100;
    const t = circleToPath(0, 0, r);
    let maxErr = 0;
    for (const [x, y] of outline(t, 64)) {
      maxErr = Math.max(maxErr, Math.abs(Math.hypot(x, y) - r));
    }
    // κ-approximation error for a quarter arc is ~0.027% of the radius.
    expect(maxErr).toBeLessThan(r * 0.0003);
  });

  it("ellipse honours rx ≠ ry", () => {
    const t = ellipseToPath(0, 0, 60, 30);
    const pts = outline(t, 48);
    expect(Math.max(...pts.map((p) => p[0]))).toBeCloseTo(60, 3);
    expect(Math.max(...pts.map((p) => p[1]))).toBeCloseTo(30, 3);
  });

  it("non-positive radius → empty", () => {
    expect(circleToPath(0, 0, 0).anchors).toHaveLength(0);
    expect(ellipseToPath(0, 0, 10, -1).anchors).toHaveLength(0);
  });
});

describe("lineToPath / polyToPath", () => {
  it("line → open 2-anchor path", () => {
    const t = lineToPath(0, 0, 10, 10);
    expect(t.anchors.length).toBe(2);
    expect(t.subpathOpen).toEqual([true]);
  });

  it("polyline → open corners; polygon → closed", () => {
    const pts: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    expect(polyToPath(pts, false).subpathOpen).toEqual([true]);
    expect(polyToPath(pts, true).subpathOpen).toEqual([false]);
    expect(polyToPath(pts, false).anchors.length).toBe(3);
  });

  it("fewer than 2 points → empty", () => {
    expect(polyToPath([[0, 0]], false).anchors).toHaveLength(0);
  });
});

// An OVAL frame has no path in the engine (`pathAnchors` answers nothing for
// one, and the planar arrangement reads it as its box — the Shape Builder
// merged ovals as rectangles). The plugin derives the outline from the box.
describe("ovalToPath — the curve of an oval frame, from its box [plugin-draw.shape-builder]", () => {
  it("is the ellipse inscribed in [top, left, bottom, right], through its four extremes", () => {
    const t = ovalToPath([100, 200, 300, 400]); // centre (300, 200), rx 100, ry 100
    expect(t.anchors).toHaveLength(4);
    expect(t.subpathOpen).toEqual([false]);
    expect(t.anchors.map((a) => a.anchor)).toEqual([
      [400, 200],
      [300, 300],
      [200, 200],
      [300, 100],
    ]);
    // On the true circle everywhere (κ's error is < 0.03 % of the radius)...
    for (const p of outline(t)) {
      expect(Math.hypot(p[0] - 300, p[1] - 200)).toBeCloseTo(100, 1);
    }
    // ...so the box's corner is outside it — what a bounding-box merge kept.
    const corner = outline(t).some((p) => p[0] < 220 && p[1] < 120);
    expect(corner).toBe(false);
  });

  it("an unequal box is an ellipse with those radii", () => {
    const t = ovalToPath([0, 0, 50, 200]); // rx 100, ry 25
    for (const p of outline(t)) {
      const e = ((p[0] - 100) / 100) ** 2 + ((p[1] - 25) / 25) ** 2;
      expect(e).toBeCloseTo(1, 2);
    }
  });

  it("a degenerate box has no outline", () => {
    expect(ovalToPath([10, 10, 10, 50]).anchors).toHaveLength(0);
  });

  it("mapTable carries the outline through an item transform, handles included", () => {
    const t = ovalToPath([0, 0, 100, 100]);
    const moved = mapTable(t, [1, 0, 0, 1, 50, 20]);
    expect(moved.anchors[0].anchor).toEqual([150, 70]);
    expect(moved.anchors[0].left).toEqual([t.anchors[0].left[0] + 50, t.anchors[0].left[1] + 20]);
    const turned = mapTable(t, [0, 1, -1, 0, 0, 0]); // 90°
    expect(turned.anchors[0].anchor[0]).toBeCloseTo(-50, 9);
    expect(turned.anchors[0].anchor[1]).toBeCloseTo(100, 9);
    expect(mapTable(t, null)).toBe(t);
  });
});
