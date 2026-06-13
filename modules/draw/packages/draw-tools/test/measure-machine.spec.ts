import { describe, expect, it } from "vitest";

import { MeasureMachine, measureReadout } from "../src";

const NONE = { shift: false };
const SHIFT = { shift: true };

describe("measureReadout", () => {
  it("computes dx/dy/distance/angle in pt + degrees", () => {
    const r = measureReadout([10, 10], [40, 50]);
    expect(r.dx).toBe(30);
    expect(r.dy).toBe(40);
    expect(r.distance).toBeCloseTo(50);
    expect(r.angleDeg).toBeCloseTo((Math.atan2(40, 30) * 180) / Math.PI);
  });
});

describe("MeasureMachine", () => {
  it("down→move produces a live line + readout; up freezes it", () => {
    const m = new MeasureMachine();
    m.handle({ type: "down", point: [0, 0], modifiers: NONE });
    const live = m.handle({ type: "move", point: [30, 40], modifiers: NONE });
    expect(live.measuring).toBe(true);
    expect(live.line).toEqual([
      [0, 0],
      [30, 40],
    ]);
    expect(live.readout!.distance).toBeCloseTo(50);

    const frozen = m.handle({ type: "up", point: [60, 80], modifiers: NONE });
    expect(frozen.measuring).toBe(false);
    expect(frozen.readout!.distance).toBeCloseTo(100);
    // The frozen line persists across hover moves (no down).
    const after = m.handle({ type: "move", point: [5, 5], modifiers: NONE });
    expect(after.line).toEqual([
      [0, 0],
      [60, 80],
    ]);
  });

  it("shift constrains the measured ray to 45° steps", () => {
    const m = new MeasureMachine();
    m.handle({ type: "down", point: [0, 0], modifiers: NONE });
    const snap = m.handle({ type: "move", point: [100, 8], modifiers: SHIFT });
    // Snapped to the horizontal.
    expect(snap.readout!.dy).toBeCloseTo(0);
    expect(snap.readout!.angleDeg).toBeCloseTo(0);
  });

  it("snapStart re-anchors the origin (the nearest-path-point snap)", () => {
    const m = new MeasureMachine();
    m.handle({ type: "down", point: [3, 4], modifiers: NONE });
    const snap = m.snapStart([0, 0]);
    expect(snap.line![0]).toEqual([0, 0]);
  });

  it("Escape clears the measurement", () => {
    const m = new MeasureMachine();
    m.handle({ type: "down", point: [0, 0], modifiers: NONE });
    m.handle({ type: "up", point: [10, 0], modifiers: NONE });
    const snap = m.handle({ type: "key", key: "Escape" });
    expect(snap.line).toBeNull();
    expect(snap.readout).toBeNull();
  });
});
