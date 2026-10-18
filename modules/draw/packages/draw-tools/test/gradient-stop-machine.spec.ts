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
  axisPercentAt,
  clampStopLocation,
  GradientStopMachine,
  pointOnAxis,
  type GradientAxis,
} from "../src";

/** A horizontal axis 200 pt long from (100, 50). */
const AXIS: GradientAxis = { origin: [100, 50], angleDeg: 0, lengthPt: 200 };

describe("gradient stop geometry", () => {
  it("a location is a point along the axis, and back", () => {
    expect(pointOnAxis(AXIS, 25)).toEqual([150, 50]);
    expect(axisPercentAt(AXIS, [150, 80])).toBeCloseTo(25, 12);
    const tilted: GradientAxis = { origin: [0, 0], angleDeg: 90, lengthPt: 100 };
    const p = pointOnAxis(tilted, 40);
    expect(p[0]).toBeCloseTo(0, 12);
    expect(p[1]).toBeCloseTo(40, 12);
    expect(axisPercentAt({ ...AXIS, lengthPt: 0 }, [500, 0])).toBe(0);
  });

  it("a stop is clamped between its neighbours, and to 0..100", () => {
    expect(clampStopLocation([0, 50, 100], 1, 120)).toBe(100);
    expect(clampStopLocation([0, 30, 60, 100], 1, 75)).toBe(60);
    expect(clampStopLocation([0, 30, 60, 100], 2, 10)).toBe(30);
    expect(clampStopLocation([10, 100], 0, -5)).toBe(0);
  });
});

describe("GradientStopMachine", () => {
  const machine = (locations = [0, 40, 100]) =>
    new GradientStopMachine({ axis: AXIS, locations, hitTolerance: 4 });

  it("a press on a marker GRABS the nearest stop; anywhere else is not this machine's gesture", () => {
    const m = machine();
    expect(m.handle({ type: "down", point: [100, 200] }).grabbed).toBe(false);
    const grab = m.handle({ type: "down", point: [181, 52] });
    expect(grab.grabbed).toBe(true);
    expect(grab.dragging).toBe(1);
    expect(grab.points).toEqual([
      [100, 50],
      [180, 50],
      [300, 50],
    ]);
  });

  it("the dragged stop follows the pointer's PROJECTION, clamped between its neighbours", () => {
    const m = machine();
    m.handle({ type: "down", point: [180, 50] });
    expect(m.handle({ type: "move", point: [220, 90] }).locations).toEqual([0, 60, 100]);
    expect(m.handle({ type: "move", point: [999, 50] }).locations).toEqual([0, 100, 100]);
    expect(m.handle({ type: "move", point: [-50, 50] }).locations).toEqual([0, 0, 100]);
  });

  it("release COMMITS one location change (rounded to 0.01 %)", () => {
    const m = machine();
    m.handle({ type: "down", point: [180, 50] });
    const done = m.handle({ type: "up", point: [233.3333, 50] });
    expect(done.commit).toEqual({ index: 1, locationPct: 66.67 });
    expect(done.dragging).toBeNull();
  });

  it("a press that does not move commits NOTHING", () => {
    const m = machine();
    m.handle({ type: "down", point: [181, 50] });
    const done = m.handle({ type: "up", point: [180, 50] });
    expect(done.commit).toBeNull();
    expect(done.locations).toEqual([0, 40, 100]);
  });

  it("Escape puts every marker back and the trailing up commits nothing", () => {
    const m = machine();
    m.handle({ type: "down", point: [180, 50] });
    m.handle({ type: "move", point: [250, 50] });
    expect(m.handle({ type: "key", key: "Escape" }).locations).toEqual([0, 40, 100]);
    expect(m.handle({ type: "up", point: [250, 50] }).commit).toBeNull();
  });

  it("an END stop moves too, within 0..its neighbour", () => {
    const m = machine([10, 50, 90]);
    m.handle({ type: "down", point: [120, 50] });
    expect(m.handle({ type: "up", point: [40, 50] }).commit).toEqual({ index: 0, locationPct: 0 });
  });
});
