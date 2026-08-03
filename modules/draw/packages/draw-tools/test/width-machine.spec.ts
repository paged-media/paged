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

import type { Vec2 } from "@paged-media/draw-geometry";

import { WidthMachine, type WidthOptions } from "../src";

// Three collinear anchors 100pt apart — deterministic nearest picks.
const ANCHORS: Vec2[] = [
  [0, 0],
  [100, 0],
  [200, 0],
];

const options = (over: Partial<WidthOptions> = {}): WidthOptions => ({
  anchors: ANCHORS,
  tolerance: 8,
  baseWidth: 2,
  falloff: 2,
  gain: 1,
  maxWidth: 72,
  ...over,
});

describe("WidthMachine", () => {
  it("down within tolerance arms the gesture at the nearest anchor", () => {
    const m = new WidthMachine(options());
    const snap = m.handle({ type: "down", point: [103, 4] });
    expect(snap.active).toBe(true);
    expect(snap.peakIndex).toBe(1);
    // No travel yet → the flat base profile.
    expect(snap.widths).toEqual([2, 2, 2]);
    expect(snap.commit).toBeNull();
  });

  it("down away from every anchor is inert (no gesture)", () => {
    const m = new WidthMachine(options());
    const snap = m.handle({ type: "down", point: [50, 50] });
    expect(snap.active).toBe(false);
    expect(snap.peakIndex).toBe(-1);
    // And a following up commits nothing.
    expect(m.handle({ type: "up", point: [50, 10] }).commit).toBeNull();
  });

  it("drag distance drives the peak; falloff spreads over neighbors", () => {
    const m = new WidthMachine(options());
    m.handle({ type: "down", point: [100, 0] });
    const live = m.handle({ type: "move", point: [100, 8] }); // 8 pt drag
    // peak = base 2 + 8 = 10; neighbors at distance 1 of falloff 2 →
    // halfway back to base.
    expect(live.widths).toEqual([6, 10, 6]);
    const snap = m.handle({ type: "up", point: [100, 8] });
    expect(snap.commit).toEqual({
      widths: [6, 10, 6],
      peakIndex: 1,
      peakWidth: 10,
    });
    expect(snap.active).toBe(false);
  });

  it("the peak clamps at maxWidth", () => {
    const m = new WidthMachine(options({ maxWidth: 12 }));
    m.handle({ type: "down", point: [0, 0] });
    const snap = m.handle({ type: "up", point: [0, 500] });
    expect(snap.commit?.peakWidth).toBe(12);
    expect(snap.commit?.widths[0]).toBe(12);
  });

  it("gain scales drag → width", () => {
    const m = new WidthMachine(options({ gain: 0.5 }));
    m.handle({ type: "down", point: [200, 0] });
    const snap = m.handle({ type: "up", point: [200, 10] });
    expect(snap.commit?.peakWidth).toBe(2 + 5);
  });

  it("a zero-travel click cancels instead of committing a degenerate bake", () => {
    const m = new WidthMachine(options());
    m.handle({ type: "down", point: [100, 0] });
    const snap = m.handle({ type: "up", point: [100, 0] });
    expect(snap.commit).toBeNull();
    expect(snap.active).toBe(false);
  });

  it("Escape cancels the in-flight drag", () => {
    const m = new WidthMachine(options());
    m.handle({ type: "down", point: [100, 0] });
    m.handle({ type: "move", point: [100, 20] });
    const snap = m.handle({ type: "key", key: "Escape" });
    expect(snap.active).toBe(false);
    expect(snap.commit).toBeNull();
    // The cancelled gesture is gone — a later up commits nothing.
    expect(m.handle({ type: "up", point: [100, 20] }).commit).toBeNull();
  });

  it("move without a down is inert", () => {
    const m = new WidthMachine(options());
    expect(m.handle({ type: "move", point: [0, 0] }).active).toBe(false);
  });
});
