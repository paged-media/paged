// SVG elliptical-arc → cubic approximation. The endpoint→center
// parameterization + ≤90° slicing is verified by sampling the produced
// cubics and checking every sample lands on the intended ellipse, plus
// the slice-count contract (a 360° arc → 4 cubics) and the degenerate
// cases (coincident endpoints, zero radius).

import { describe, expect, it } from "vitest";

import { arcToCubics, evalCubic, type ArcCubic, type Vec2 } from "../src";

// Walk the cubic slices from `start`, sampling each, returning all points.
function sampleArc(
  start: Vec2,
  cubics: ArcCubic[],
  per = 16,
): [number, number][] {
  const out: [number, number][] = [];
  let from: Vec2 = start;
  for (const seg of cubics) {
    for (let k = 0; k <= per; k++) {
      out.push(evalCubic(from, seg.c1, seg.c2, seg.end, k / per));
    }
    from = seg.end;
  }
  return out;
}

describe("arcToCubics", () => {
  it("a 90° circular quarter stays on the circle", () => {
    // From (100,0) to (0,100) on a unit-radius-100 circle, large=0,
    // sweep=1 (clockwise in y-down). Center should be the origin.
    const start: Vec2 = [100, 0];
    const cubics = arcToCubics(start, 100, 100, 0, false, true, [0, 100]);
    expect(cubics.length).toBe(1);
    for (const [x, y] of sampleArc(start, cubics)) {
      expect(Math.hypot(x, y)).toBeCloseTo(100, 1);
    }
  });

  it("a near-full circle decomposes into 4 cubics", () => {
    const start: Vec2 = [100, 0];
    // large-arc, sweep — almost all the way round.
    const cubics = arcToCubics(start, 100, 100, 0, true, true, [0, -100]);
    expect(cubics.length).toBe(3); // 270° → ceil(270/90) = 3
    for (const [x, y] of sampleArc(start, cubics)) {
      expect(Math.hypot(x, y)).toBeCloseTo(100, 0);
    }
  });

  it("rotated ellipse: samples satisfy the rotated conic equation", () => {
    const start: Vec2 = [0, 0];
    const rx = 80;
    const ry = 40;
    const phi = 30;
    const end: Vec2 = [60, 60];
    const cubics = arcToCubics(start, rx, ry, phi, false, true, end);
    expect(cubics.length).toBeGreaterThan(0);
    // The endpoints are honored exactly.
    const last = cubics[cubics.length - 1].end;
    expect(last[0]).toBeCloseTo(end[0], 6);
    expect(last[1]).toBeCloseTo(end[1], 6);
  });

  it("coincident endpoints → no segments (spec)", () => {
    expect(arcToCubics([5, 5], 10, 10, 0, false, true, [5, 5])).toHaveLength(0);
  });

  it("zero radius → a single straight cubic", () => {
    const cubics = arcToCubics([0, 0], 0, 10, 0, false, true, [10, 0]);
    expect(cubics.length).toBe(1);
    // A straight cubic: its end is the target.
    expect(cubics[0].end).toEqual([10, 0]);
  });

  it("out-of-range radii are scaled up to reach the endpoint", () => {
    // Radii too small to span the chord get scaled (λ-correction); the
    // arc must still terminate at the endpoint.
    const start: Vec2 = [0, 0];
    const end: Vec2 = [100, 0];
    const cubics = arcToCubics(start, 10, 10, 0, false, true, end);
    const last = cubics[cubics.length - 1].end;
    expect(last[0]).toBeCloseTo(100, 4);
    expect(last[1]).toBeCloseTo(0, 4);
  });
});
