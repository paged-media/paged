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
  arcPath,
  spiralPath,
  rectGridPaths,
  polarGridPaths,
  type AnchorTable,
} from "../src";

const TAU = Math.PI * 2;

function onEllipse(
  t: AnchorTable,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): void {
  for (const a of t.anchors) {
    const dx = (a.anchor[0] - cx) / rx;
    const dy = (a.anchor[1] - cy) / ry;
    expect(dx * dx + dy * dy).toBeCloseTo(1, 9);
  }
}

describe("arcPath", () => {
  it("a quarter arc is one cubic slice with on-ellipse endpoints", () => {
    const t = arcPath(0, 0, 100, 100, 0, Math.PI / 2);
    expect(t.anchors).toHaveLength(2);
    expect(t.subpathOpen).toEqual([true]);
    // Start at angle 0 = (100, 0); end at π/2 = (0, 100) — y-down space.
    expect(t.anchors[0].anchor[0]).toBeCloseTo(100);
    expect(t.anchors[0].anchor[1]).toBeCloseTo(0);
    expect(t.anchors[1].anchor[0]).toBeCloseTo(0);
    expect(t.anchors[1].anchor[1]).toBeCloseTo(100);
    onEllipse(t, 0, 0, 100, 100);
    // The endpoints collapse their outward handles (open corner ends).
    expect(t.anchors[0].left).toEqual(t.anchors[0].anchor);
    expect(t.anchors[1].right).toEqual(t.anchors[1].anchor);
    // The inward handles are the §F.6.6 k-rule: k = 4/3·tan(δ/4),
    // handle = k·tangent → for δ = π/2 the first right handle sits at
    // (100, 100k).
    const k = (4 / 3) * Math.tan(Math.PI / 8);
    expect(t.anchors[0].right[0]).toBeCloseTo(100);
    expect(t.anchors[0].right[1]).toBeCloseTo(100 * k);
  });

  it("a 270° sweep slices into ≤90° segments (3 slices, 4 anchors)", () => {
    const t = arcPath(200, 200, 100, 50, 0, 1.5 * Math.PI);
    expect(t.anchors).toHaveLength(4);
    onEllipse(t, 200, 200, 100, 50);
  });

  it("a negative sweep runs the other way", () => {
    const t = arcPath(0, 0, 10, 10, 0, -Math.PI / 2);
    expect(t.anchors[1].anchor[0]).toBeCloseTo(0);
    expect(t.anchors[1].anchor[1]).toBeCloseTo(-10);
  });

  it("closed marks the contour closed (chord closure)", () => {
    const t = arcPath(0, 0, 10, 10, 0, Math.PI, true);
    expect(t.subpathOpen).toEqual([false]);
  });

  it("|sweep| clamps to a full turn", () => {
    const t = arcPath(0, 0, 10, 10, 0, 3 * TAU);
    expect(t.anchors).toHaveLength(5); // 4 quarter slices
    expect(t.anchors[4].anchor[0]).toBeCloseTo(10);
    expect(t.anchors[4].anchor[1]).toBeCloseTo(0, 6);
  });

  it("degenerate input yields an empty table, never a throw", () => {
    expect(arcPath(0, 0, 0, 10, 0, 1).anchors).toHaveLength(0);
    expect(arcPath(0, 0, 10, -1, 0, 1).anchors).toHaveLength(0);
    expect(arcPath(0, 0, 10, 10, 0, 0).anchors).toHaveLength(0);
    expect(arcPath(NaN, 0, 10, 10, 0, 1).anchors).toHaveLength(0);
  });
});

describe("spiralPath", () => {
  it("radius decays by `decay` per full turn; the contour is open", () => {
    const t = spiralPath(0, 0, 100, 0.5, 2, 4);
    expect(t.subpathOpen).toEqual([true]);
    expect(t.anchors).toHaveLength(9); // 2 turns × 4 segments + 1
    const radius = (i: number) =>
      Math.hypot(t.anchors[i].anchor[0], t.anchors[i].anchor[1]);
    expect(radius(0)).toBeCloseTo(100);
    expect(radius(4)).toBeCloseTo(50); // one full turn → ×0.5
    expect(radius(8)).toBeCloseTo(25); // two turns → ×0.25
  });

  it("decay 1 keeps a constant radius (circle-like wind)", () => {
    const t = spiralPath(10, 20, 30, 1, 1, 8);
    for (const a of t.anchors) {
      expect(Math.hypot(a.anchor[0] - 10, a.anchor[1] - 20)).toBeCloseTo(30);
    }
  });

  it("the endpoints collapse their outward handles", () => {
    const t = spiralPath(0, 0, 100, 0.8, 1, 4);
    expect(t.anchors[0].left).toEqual(t.anchors[0].anchor);
    const last = t.anchors[t.anchors.length - 1];
    expect(last.right).toEqual(last.anchor);
    // Interior anchors carry real (non-collapsed) handles.
    expect(t.anchors[1].left).not.toEqual(t.anchors[1].anchor);
    expect(t.anchors[1].right).not.toEqual(t.anchors[1].anchor);
  });

  it("degenerate input yields an empty table", () => {
    expect(spiralPath(0, 0, 0, 0.5, 2, 4).anchors).toHaveLength(0);
    expect(spiralPath(0, 0, 10, 0, 2, 4).anchors).toHaveLength(0);
    expect(spiralPath(0, 0, 10, 0.5, 0, 4).anchors).toHaveLength(0);
    expect(spiralPath(0, 0, 10, 0.5, 2, 1).anchors).toHaveLength(0);
  });
});

describe("rectGridPaths", () => {
  it("rows+1 horizontals then cols+1 verticals, border included", () => {
    const lines = rectGridPaths([100, 100, 300, 300], 2, 4);
    expect(lines).toHaveLength(3 + 5);
    // Every line is an open 2-anchor contour.
    for (const l of lines) {
      expect(l.anchors).toHaveLength(2);
      expect(l.subpathOpen).toEqual([true]);
    }
    // First horizontal = the top border; second at 1/2 height.
    expect(lines[0].anchors[0].anchor).toEqual([100, 100]);
    expect(lines[0].anchors[1].anchor).toEqual([300, 100]);
    expect(lines[1].anchors[0].anchor).toEqual([100, 200]);
    // First vertical = the left border, spanning top→bottom.
    expect(lines[3].anchors[0].anchor).toEqual([100, 100]);
    expect(lines[3].anchors[1].anchor).toEqual([100, 300]);
  });

  it("degenerate bounds or counts yield an empty list", () => {
    expect(rectGridPaths([0, 0, 0, 100], 2, 2)).toHaveLength(0);
    expect(rectGridPaths([0, 0, 100, 100], 0, 2)).toHaveLength(0);
  });
});

describe("polarGridPaths", () => {
  it("rings are closed circles at r·i/rings; radials are open spokes", () => {
    const paths = polarGridPaths(200, 200, 100, 2, 4);
    expect(paths).toHaveLength(2 + 4);
    // Ring 1 at radius 50, ring 2 (outermost) at 100 — closed 4-anchor
    // κ circles.
    expect(paths[0].subpathOpen).toEqual([false]);
    expect(paths[0].anchors).toHaveLength(4);
    expect(paths[0].anchors[0].anchor[0]).toBeCloseTo(250);
    expect(paths[1].anchors[0].anchor[0]).toBeCloseTo(300);
    // Spokes: center → rim, first along +x.
    expect(paths[2].anchors[0].anchor).toEqual([200, 200]);
    expect(paths[2].anchors[1].anchor[0]).toBeCloseTo(300);
    expect(paths[2].anchors[1].anchor[1]).toBeCloseTo(200);
  });

  it("either family may be omitted; both absent (or r ≤ 0) is empty", () => {
    expect(polarGridPaths(0, 0, 10, 3, 0)).toHaveLength(3);
    expect(polarGridPaths(0, 0, 10, 0, 5)).toHaveLength(5);
    expect(polarGridPaths(0, 0, 10, 0, 0)).toHaveLength(0);
    expect(polarGridPaths(0, 0, 0, 3, 3)).toHaveLength(0);
  });
});
