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

// The two kernels Direct Selection added: the segment-drag solve and
// the smooth-anchor test.

import { describe, expect, it } from "vitest";

import {
  evalCubic,
  reshapeSegmentByDrag,
  segmentDragWeight,
  SEGMENT_DRAG_T_MIN,
} from "../src/bezier";
import { isCornerAnchor, isSmoothAnchor } from "../src/classify";

const P0 = [0, 0] as const;
const P1 = [30, -40] as const;
const P2 = [80, 60] as const;
const P3 = [100, 0] as const;

describe("segmentDragWeight", () => {
  it("is 0 up to a sixth, 1 from five sixths, ½ in the middle", () => {
    expect(segmentDragWeight(0)).toBe(0);
    expect(segmentDragWeight(1 / 6)).toBe(0);
    expect(segmentDragWeight(0.5)).toBeCloseTo(0.5, 12);
    expect(segmentDragWeight(5 / 6)).toBeCloseTo(1, 12);
    expect(segmentDragWeight(1)).toBe(1);
  });

  it("is continuous at the joins and monotone in between", () => {
    for (const t of [1 / 6, 0.5, 5 / 6]) {
      expect(segmentDragWeight(t + 1e-9)).toBeCloseTo(segmentDragWeight(t - 1e-9), 6);
    }
    let last = 0;
    for (let i = 0; i <= 100; i++) {
      const w = segmentDragWeight(i / 100);
      expect(w).toBeGreaterThanOrEqual(last);
      last = w;
    }
  });

  it("is symmetric: the end takes at 1−t what the start takes at t", () => {
    for (const t of [0.2, 0.3, 0.4, 0.45]) {
      expect(segmentDragWeight(1 - t)).toBeCloseTo(1 - segmentDragWeight(t), 12);
    }
  });
});

describe("reshapeSegmentByDrag", () => {
  it("moves the grabbed point by exactly the drag, at any parameter in range", () => {
    const delta = [7, -13] as const;
    for (const t of [SEGMENT_DRAG_T_MIN, 0.1, 0.25, 0.5, 0.6, 0.9, 1 - SEGMENT_DRAG_T_MIN]) {
      const before = evalCubic(P0, P1, P2, P3, t);
      const r = reshapeSegmentByDrag(P1, P2, t, delta);
      const after = evalCubic(P0, r.startRight, r.endLeft, P3, t);
      expect(after[0]).toBeCloseTo(before[0] + delta[0], 10);
      expect(after[1]).toBeCloseTo(before[1] + delta[1], 10);
    }
  });

  it("near the start only the start handle moves; near the end only the end handle", () => {
    const early = reshapeSegmentByDrag(P1, P2, 0.1, [5, 5]);
    expect(early.endLeft).toEqual([80, 60]);
    expect(early.startRight).not.toEqual([30, -40]);
    const late = reshapeSegmentByDrag(P1, P2, 0.9, [5, 5]);
    expect(late.startRight).toEqual([30, -40]);
    expect(late.endLeft).not.toEqual([80, 60]);
  });

  it("at the midpoint both handles take the same offset", () => {
    const r = reshapeSegmentByDrag(P1, P2, 0.5, [9, 0]);
    // 3(1−t)²t = 3(1−t)t² = ⅜ at t = ½, so each handle moves ½ / ⅜ = 4/3.
    expect(r.startRight[0] - P1[0]).toBeCloseTo(12, 12);
    expect(r.endLeft[0] - P2[0]).toBeCloseTo(12, 12);
  });

  it("a zero drag is the identity", () => {
    const r = reshapeSegmentByDrag(P1, P2, 0.37, [0, 0]);
    expect(r).toEqual({ startRight: [30, -40], endLeft: [80, 60] });
  });

  it("clamps the parameter at the ends so the gain stays bounded", () => {
    const atZero = reshapeSegmentByDrag(P1, P2, 0, [1, 0]);
    const atMin = reshapeSegmentByDrag(P1, P2, SEGMENT_DRAG_T_MIN, [1, 0]);
    expect(atZero).toEqual(atMin);
    expect(Number.isFinite(atZero.startRight[0])).toBe(true);
    // 1 / (3 · 0.95² · 0.05) ≈ 7.39 handle units per pointer unit.
    expect(atZero.startRight[0] - P1[0]).toBeCloseTo(1 / (3 * 0.95 * 0.95 * 0.05), 10);
    expect(reshapeSegmentByDrag(P1, P2, 1, [1, 0])).toEqual(
      reshapeSegmentByDrag(P1, P2, 1 - SEGMENT_DRAG_T_MIN, [1, 0]),
    );
  });
});

describe("isSmoothAnchor", () => {
  it("two handles on opposite sides of the anchor, any lengths", () => {
    expect(isSmoothAnchor({ anchor: [50, 50], left: [30, 50], right: [90, 50] })).toBe(true);
    expect(isSmoothAnchor({ anchor: [0, 0], left: [-3, -4], right: [30, 40] })).toBe(true);
  });

  it("a corner is not smooth", () => {
    const a = { anchor: [5, 5], left: [5, 5], right: [5, 5] } as never;
    expect(isCornerAnchor(a)).toBe(true);
    expect(isSmoothAnchor(a)).toBe(false);
  });

  it("a one-handled anchor is not smooth", () => {
    expect(isSmoothAnchor({ anchor: [0, 0], left: [0, 0], right: [30, 0] })).toBe(false);
    expect(isSmoothAnchor({ anchor: [0, 0], left: [-30, 0], right: [0, 0] })).toBe(false);
  });

  it("a cusp is not smooth — neither bent nor folded back on itself", () => {
    expect(isSmoothAnchor({ anchor: [0, 0], left: [-30, 0], right: [0, 30] })).toBe(false);
    // Collinear, but both handles on the SAME side.
    expect(isSmoothAnchor({ anchor: [0, 0], left: [10, 0], right: [30, 0] })).toBe(false);
  });

  it("tolerates round-off, and the tolerance is the caller's to set", () => {
    const nearly = { anchor: [50, 50], left: [30, 50.01], right: [90, 50] } as never;
    expect(isSmoothAnchor(nearly)).toBe(true);
    expect(isSmoothAnchor(nearly, undefined, 1e-6)).toBe(false);
  });
});
