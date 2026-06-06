import { describe, expect, it } from "vitest";

import {
  closestTOnCubic,
  evalCubic,
  flattenAnchorRun,
  splitSegmentDeCasteljau,
} from "../src/bezier";
import { cornerAnchor } from "../src/handles";

describe("splitSegmentDeCasteljau", () => {
  it("splits at t=0.5 and both halves trace the original curve", () => {
    const start = [0, 0] as const;
    const startRight = [10, 0] as const;
    const endLeft = [20, 10] as const;
    const end = [30, 10] as const;
    const split = splitSegmentDeCasteljau(start, startRight, endLeft, end, 0.5);
    // The mid anchor lies ON the original curve at t=0.5.
    expect(split.midAnchor).toEqual(evalCubic(start, startRight, endLeft, end, 0.5));
    // First half at its own t=0.5 equals the original at t=0.25.
    const firstHalfMid = evalCubic(
      start,
      split.startRight,
      split.midLeft,
      split.midAnchor,
      0.5,
    );
    const originalQuarter = evalCubic(start, startRight, endLeft, end, 0.25);
    expect(firstHalfMid[0]).toBeCloseTo(originalQuarter[0], 10);
    expect(firstHalfMid[1]).toBeCloseTo(originalQuarter[1], 10);
  });
});

describe("closestTOnCubic", () => {
  it("finds the parameter of an on-curve click", () => {
    const start = [0, 0] as const;
    const startRight = [0, 0] as const;
    const endLeft = [30, 0] as const;
    const end = [30, 0] as const;
    // Degenerate-straight cubic: B(t) is monotone in x.
    const click = evalCubic(start, startRight, endLeft, end, 0.3);
    const t = closestTOnCubic(start, startRight, endLeft, end, click);
    const p = evalCubic(start, startRight, endLeft, end, t);
    expect(p[0]).toBeCloseTo(click[0], 3);
    expect(p[1]).toBeCloseTo(click[1], 3);
  });

  it("projects an off-curve click onto the curve", () => {
    const start = [0, 0] as const;
    const startRight = [10, 20] as const;
    const endLeft = [20, 20] as const;
    const end = [30, 0] as const;
    const t = closestTOnCubic(start, startRight, endLeft, end, [15, 30]);
    // Symmetric curve, click above the apex → t = 0.5.
    expect(t).toBeCloseTo(0.5, 2);
  });
});

describe("flattenAnchorRun", () => {
  it("emits straight segments without intermediate samples", () => {
    const run = [cornerAnchor([0, 0]), cornerAnchor([10, 0])];
    expect(flattenAnchorRun(run)).toEqual([
      [0, 0],
      [10, 0],
    ]);
  });

  it("samples curved segments", () => {
    const run = [
      { anchor: [0, 0], left: [0, 0], right: [0, 10] },
      { anchor: [10, 0], left: [10, 10], right: [10, 0] },
    ] as const;
    const out = flattenAnchorRun(run as never, { samplesPerSegment: 4 });
    expect(out.length).toBe(5);
    expect(out[0]).toEqual([0, 0]);
    expect(out[4][0]).toBeCloseTo(10);
  });

  it("closes the run when asked", () => {
    const run = [
      cornerAnchor([0, 0]),
      cornerAnchor([10, 0]),
      cornerAnchor([10, 10]),
    ];
    const out = flattenAnchorRun(run, { close: true });
    expect(out[out.length - 1]).toEqual([0, 0]);
  });
});
