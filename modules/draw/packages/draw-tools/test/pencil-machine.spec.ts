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

import { PencilMachine } from "../src";

describe("PencilMachine", () => {
  it("collects decimated samples while drawing (live polyline preview)", () => {
    const m = new PencilMachine({ tolerance: 1, minSampleDistance: 2 });
    m.handle({ type: "down", point: [0, 0] });
    m.handle({ type: "move", point: [0.5, 0] }); // below the floor — dropped
    m.handle({ type: "move", point: [5, 0] });
    const snap = m.handle({ type: "move", point: [10, 0] });
    expect(snap.points).toEqual([
      [0, 0],
      [5, 0],
      [10, 0],
    ]);
    expect(snap.active).toBe(true);
    expect(snap.commit).toBeNull();
  });

  it("commit simplifies with RDP: collinear samples collapse, real corners survive", () => {
    const m = new PencilMachine({
      tolerance: 1,
      minSampleDistance: 0,
      smooth: false,
    });
    m.handle({ type: "down", point: [0, 0] });
    for (let x = 10; x <= 100; x += 10) {
      m.handle({ type: "move", point: [x, 0] });
    }
    for (let y = 10; y <= 100; y += 10) {
      m.handle({ type: "move", point: [100, y] });
    }
    const snap = m.handle({ type: "up", point: [100, 100] });
    expect(snap.commit).not.toBeNull();
    // One L corner: exactly three survivors.
    expect(snap.commit!.anchors.map((a) => a.anchor)).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
    ]);
    expect(snap.commit!.open).toBe(true);
    // smooth:false → corner anchors (collapsed handles).
    expect(snap.commit!.anchors[1].left).toEqual([100, 0]);
    expect(snap.active).toBe(false);
  });

  it("default smoothing fits handles through the simplified anchors", () => {
    const m = new PencilMachine({ tolerance: 1, minSampleDistance: 0 });
    m.handle({ type: "down", point: [0, 0] });
    m.handle({ type: "move", point: [50, 40] });
    m.handle({ type: "move", point: [100, 0] });
    const snap = m.handle({ type: "up", point: [100, 0] });
    const mid = snap.commit!.anchors[1];
    expect(mid.anchor).toEqual([50, 40]);
    expect(mid.left).not.toEqual(mid.anchor); // smooth, not corner
  });

  it("lifting near the start (within closeTolerance) commits a CLOSED contour", () => {
    const m = new PencilMachine({
      tolerance: 1,
      minSampleDistance: 0,
      smooth: false,
      closeTolerance: 5,
    });
    m.handle({ type: "down", point: [0, 0] });
    m.handle({ type: "move", point: [100, 0] });
    m.handle({ type: "move", point: [100, 100] });
    m.handle({ type: "move", point: [0, 100] });
    const snap = m.handle({ type: "up", point: [2, 2] });
    expect(snap.commit).not.toBeNull();
    expect(snap.commit!.open).toBe(false);
    // The coincident tail is dropped — the wraparound edge returns.
    expect(snap.commit!.anchors.map((a) => a.anchor)).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ]);
  });

  it("a click (no travel) cancels instead of committing a degenerate path", () => {
    const m = new PencilMachine({ tolerance: 1 });
    m.handle({ type: "down", point: [10, 10] });
    const snap = m.handle({ type: "up", point: [10, 10] });
    expect(snap.commit).toBeNull();
    expect(snap.active).toBe(false);
  });

  it("Escape cancels the in-flight stroke", () => {
    const m = new PencilMachine({ tolerance: 1 });
    m.handle({ type: "down", point: [0, 0] });
    m.handle({ type: "move", point: [50, 0] });
    const snap = m.handle({ type: "key", key: "Escape" });
    expect(snap.commit).toBeNull();
    expect(snap.active).toBe(false);
    expect(snap.points).toHaveLength(0);
  });
});
