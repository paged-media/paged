import { describe, expect, it } from "vitest";

import { segmentDistance, simplifyRdp } from "../src/rdp";

describe("segmentDistance", () => {
  it("measures perpendicular distance to the segment body", () => {
    expect(segmentDistance([5, 5], [0, 0], [10, 0])).toBeCloseTo(5);
  });

  it("clamps to the nearest endpoint beyond the segment", () => {
    expect(segmentDistance([-3, 4], [0, 0], [10, 0])).toBeCloseTo(5);
  });

  it("degenerates to point distance for zero-length segments", () => {
    expect(segmentDistance([3, 4], [0, 0], [0, 0])).toBeCloseTo(5);
  });
});

describe("simplifyRdp", () => {
  it("keeps collinear runs as two endpoints", () => {
    const points: [number, number][] = [
      [0, 0],
      [1, 0.001],
      [2, -0.001],
      [3, 0],
    ];
    expect(simplifyRdp(points, 0.5)).toEqual([
      [0, 0],
      [3, 0],
    ]);
  });

  it("keeps a deviation above tolerance", () => {
    const points: [number, number][] = [
      [0, 0],
      [5, 4],
      [10, 0],
    ];
    expect(simplifyRdp(points, 1)).toEqual(points);
  });

  it("returns short inputs unchanged (copies)", () => {
    const points: [number, number][] = [
      [0, 0],
      [1, 1],
    ];
    const out = simplifyRdp(points, 10);
    expect(out).toEqual(points);
    expect(out[0]).not.toBe(points[0]);
  });
});
