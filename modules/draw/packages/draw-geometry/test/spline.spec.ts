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

import { smoothAnchorsThrough, type Vec2 } from "../src";

describe("smoothAnchorsThrough (Catmull-Rom handle fitting)", () => {
  it("returns [] for no points and a collapsed anchor for one point", () => {
    expect(smoothAnchorsThrough([])).toEqual([]);
    const one = smoothAnchorsThrough([[10, 20]]);
    expect(one).toHaveLength(1);
    expect(one[0].anchor).toEqual([10, 20]);
    expect(one[0].left).toEqual([10, 20]);
    expect(one[0].right).toEqual([10, 20]);
  });

  it("anchors pass exactly through the input points", () => {
    const pts: Vec2[] = [
      [0, 0],
      [100, 50],
      [200, 0],
    ];
    const run = smoothAnchorsThrough(pts);
    expect(run.map((a) => a.anchor)).toEqual(pts);
  });

  it("interior points get mirrored (smooth) handles along the chord of their neighbours", () => {
    const run = smoothAnchorsThrough([
      [0, 0],
      [100, 0],
      [200, 0],
    ]);
    const mid = run[1];
    // Tangent = (next − prev)/6 = (200/6, 0).
    expect(mid.right[0]).toBeCloseTo(100 + 200 / 6);
    expect(mid.left[0]).toBeCloseTo(100 - 200 / 6);
    // Mirrored pair: anchor is the midpoint of left/right.
    expect((mid.left[0] + mid.right[0]) / 2).toBeCloseTo(mid.anchor[0]);
    expect((mid.left[1] + mid.right[1]) / 2).toBeCloseTo(mid.anchor[1]);
  });

  it("collinear points produce handles ON the line (no perpendicular wobble)", () => {
    const run = smoothAnchorsThrough([
      [0, 0],
      [50, 50],
      [100, 100],
      [150, 150],
    ]);
    for (const a of run) {
      expect(a.left[1]).toBeCloseTo(a.left[0]);
      expect(a.right[1]).toBeCloseTo(a.right[0]);
    }
  });

  it("open ends clamp the ghost neighbour (shortened terminal tangent, no overshoot)", () => {
    const run = smoothAnchorsThrough([
      [0, 0],
      [60, 0],
    ]);
    // First point: tangent = (P1 − P0)/6 = (10, 0).
    expect(run[0].right).toEqual([10, 0]);
    expect(run[0].left).toEqual([-10, 0]);
    // Last point mirrors.
    expect(run[1].left).toEqual([50, 0]);
  });

  it("a corner flag collapses that point's handles while neighbours stay smooth", () => {
    const run = smoothAnchorsThrough(
      [
        [0, 0],
        [100, 100],
        [200, 0],
      ],
      [false, true, false],
    );
    expect(run[1].left).toEqual([100, 100]);
    expect(run[1].right).toEqual([100, 100]);
    // Endpoint handles still fit through the corner.
    expect(run[0].right).not.toEqual([0, 0]);
  });

  it("closed contours wrap the neighbour lookup (smooth across the seam)", () => {
    const square: Vec2[] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ];
    const run = smoothAnchorsThrough(square, undefined, true);
    // First point's tangent = (P1 − P3)/6 = ([100,0] − [0,100])/6.
    expect(run[0].right[0]).toBeCloseTo(100 / 6);
    expect(run[0].right[1]).toBeCloseTo(-100 / 6);
    expect(run[0].left[0]).toBeCloseTo(-100 / 6);
    expect(run[0].left[1]).toBeCloseTo(100 / 6);
  });
});
