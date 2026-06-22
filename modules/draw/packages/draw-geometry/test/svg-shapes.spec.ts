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
