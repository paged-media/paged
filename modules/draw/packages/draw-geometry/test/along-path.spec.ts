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

// The SHARED along-path placement kernel — the one piece §16.2 (blend
// spines) and §16.3 (objects on a path) genuinely have in common. What
// is pinned here is the arithmetic both rows depend on: arc length over
// a flattened run, the point + tangent at a fraction of it, the two
// distribution rules, and the easing curve whose ZERO STRENGTH must be
// the identity (otherwise "the default changes nothing" is not true).

import { describe, expect, it } from "vitest";

import {
  distributeAlongPath,
  ease,
  EASE_KINDS,
  measureAnchorRun,
  measureSegment,
  pointAtFraction,
  pointAtLength,
  wrapOrClamp,
  type AnchorTriple,
} from "../src";

const corner = (x: number, y: number): AnchorTriple => ({
  anchor: [x, y],
  left: [x, y],
  right: [x, y],
});

/** A 300 pt horizontal line as two collapsed anchors. */
const LINE = [corner(0, 0), corner(300, 0)];

/** A 400 pt closed square (100 × 100), corners only. */
const SQUARE = [corner(0, 0), corner(100, 0), corner(100, 100), corner(0, 100)];

describe("measureAnchorRun", () => {
  it("measures a straight run EXACTLY — a collapsed segment is one chord, not 24 samples", () => {
    const m = measureAnchorRun(LINE);
    expect(m.length).toBe(300);
    // Two stations: no intermediate samples on a straight segment.
    expect(m.stations).toHaveLength(2);
    expect(m.closed).toBe(false);
  });

  it("closes a run when asked, and the closing segment counts", () => {
    expect(measureAnchorRun(SQUARE).length).toBe(300); // 3 sides
    const closed = measureAnchorRun(SQUARE, { close: true });
    expect(closed.length).toBe(400); // 4 sides
    expect(closed.closed).toBe(true);
  });

  it("flattens a CURVED segment and over-samples it (a quarter circle is longer than its chord)", () => {
    // A quarter-circle-ish cubic from (0,0) to (100,100).
    const k = 55.228;
    const curve: AnchorTriple[] = [
      { anchor: [0, 0], left: [0, 0], right: [k, 0] },
      { anchor: [100, 100], left: [100, 100 - k], right: [100, 100] },
    ];
    const m = measureAnchorRun(curve);
    // The chord is 141.4; a quarter circle of radius 100 is 157.1.
    expect(m.length).toBeGreaterThan(150);
    expect(m.length).toBeLessThan(160);
    expect(m.stations.length).toBe(25); // 1 + samplesPerSegment
    expect(measureAnchorRun(curve, { samplesPerSegment: 4 }).stations).toHaveLength(
      5,
    );
  });

  it("degrades honestly on an empty run (one station, zero length — never a throw)", () => {
    const m = measureAnchorRun([]);
    expect(m.length).toBe(0);
    expect(m.stations).toHaveLength(1);
    expect(pointAtFraction(m, 0.5).point).toEqual([0, 0]);
  });

  it("measureSegment IS the straight-line spine, expressed through the same kernel", () => {
    const m = measureSegment([10, 10], [10, 60]);
    expect(m.length).toBe(50);
    expect(pointAtFraction(m, 0.5).point).toEqual([10, 35]);
    // Y-DOWN: straight down the page is +90°, not -90°.
    expect(pointAtFraction(m, 0.5).tangentDeg).toBeCloseTo(90, 9);
  });
});

describe("pointAtLength / pointAtFraction", () => {
  it("walks the arc length, not the anchor index", () => {
    // An L: 100 across, then 300 down. The HALFWAY point by length is
    // 100 down the second leg, not the corner.
    const l = measureAnchorRun([corner(0, 0), corner(100, 0), corner(100, 300)]);
    expect(l.length).toBe(400);
    const mid = pointAtFraction(l, 0.5);
    expect(mid.point[0]).toBeCloseTo(100, 9);
    expect(mid.point[1]).toBeCloseTo(100, 9);
    expect(mid.tangentDeg).toBeCloseTo(90, 9);
    expect(mid.s).toBeCloseTo(200, 9);
  });

  it("reports the tangent in DEGREES, y-down", () => {
    const m = measureAnchorRun(LINE);
    expect(pointAtFraction(m, 0.25).tangentDeg).toBeCloseTo(0, 9);
    const up = measureAnchorRun([corner(0, 100), corner(0, 0)]);
    expect(pointAtFraction(up, 0.5).tangentDeg).toBeCloseTo(-90, 9);
  });

  it("CLAMPS out-of-range lengths rather than wrapping (wrapping is a different feature)", () => {
    const m = measureAnchorRun(LINE);
    expect(pointAtLength(m, -50).point).toEqual([0, 0]);
    expect(pointAtLength(m, 9999).point[0]).toBeCloseTo(300, 9);
    expect(pointAtLength(m, Number.NaN).point).toEqual([0, 0]);
  });

  it("wrapOrClamp wraps a CLOSED metric and clamps an open one", () => {
    const open = measureAnchorRun(SQUARE);
    const closed = measureAnchorRun(SQUARE, { close: true });
    expect(wrapOrClamp(open, 500)).toBe(300);
    expect(wrapOrClamp(closed, 500)).toBe(100);
    expect(wrapOrClamp(closed, -50)).toBe(350);
  });
});

describe("distributeAlongPath — count", () => {
  it("INTERIOR puts every slot strictly between the ends (the blend lane)", () => {
    const m = measureSegment([0, 0], [400, 0]);
    const slots = distributeAlongPath({
      metric: m,
      mode: "count",
      count: 3,
      endpoints: "interior",
    });
    expect(slots.map((s) => s.u)).toEqual([0.25, 0.5, 0.75]);
    expect(slots.map((s) => s.point[0])).toEqual([100, 200, 300]);
    expect(slots.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it("INCLUSIVE on an OPEN path lands the first and last slots on the ends", () => {
    const m = measureSegment([0, 0], [400, 0]);
    const slots = distributeAlongPath({
      metric: m,
      mode: "count",
      count: 5,
      endpoints: "inclusive",
    });
    expect(slots.map((s) => s.u)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it("INCLUSIVE on a CLOSED path divides by count — a slot on both ends would be two objects in one place", () => {
    const ring = measureAnchorRun(SQUARE, { close: true });
    const slots = distributeAlongPath({ metric: ring, mode: "count", count: 4 });
    expect(slots.map((s) => s.s)).toEqual([0, 100, 200, 300]);
    // …and the four corners, in order.
    expect(slots.map((s) => s.point)).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ]);
  });

  it("a count of 1 puts its single slot at the START (predictable beats clever)", () => {
    const m = measureSegment([0, 0], [400, 0]);
    expect(
      distributeAlongPath({ metric: m, mode: "count", count: 1 })[0].u,
    ).toBe(0);
    // …and interior still centres it.
    expect(
      distributeAlongPath({
        metric: m,
        mode: "count",
        count: 1,
        endpoints: "interior",
      })[0].u,
    ).toBe(0.5);
  });

  it("startOffset MOVES every slot along the path, and an open path drops what runs past the end", () => {
    const m = measureSegment([0, 0], [400, 0]);
    const shifted = distributeAlongPath({
      metric: m,
      mode: "count",
      count: 5,
      startOffsetPt: 100,
    });
    // 0/100/200/300/400 + 100 → the last two run off the end.
    expect(shifted.map((s) => s.s)).toEqual([100, 200, 300, 400]);
    // A CLOSED path has no end to run off — it wraps, and keeps all 4.
    const ring = measureAnchorRun(SQUARE, { close: true });
    const wrapped = distributeAlongPath({
      metric: ring,
      mode: "count",
      count: 4,
      startOffsetPt: 50,
    });
    expect(wrapped.map((s) => s.s)).toEqual([50, 150, 250, 350]);
  });

  it("clamps a hostile count rather than producing nothing", () => {
    const m = measureSegment([0, 0], [400, 0]);
    expect(distributeAlongPath({ metric: m, mode: "count", count: 0 })).toHaveLength(
      1,
    );
    expect(
      distributeAlongPath({ metric: m, mode: "count", count: -3 }),
    ).toHaveLength(1);
  });
});

describe("distributeAlongPath — spacing", () => {
  it("walks a fixed gap and stops at the path's end", () => {
    const m = measureSegment([0, 0], [250, 0]);
    const slots = distributeAlongPath({
      metric: m,
      mode: "spacing",
      spacingPt: 100,
    });
    expect(slots.map((s) => s.s)).toEqual([0, 100, 200]);
  });

  it("a CLOSED path stops after ONE lap — a ring cannot be paved twice", () => {
    const ring = measureAnchorRun(SQUARE, { close: true }); // length 400
    const slots = distributeAlongPath({
      metric: ring,
      mode: "spacing",
      spacingPt: 100,
    });
    expect(slots.map((s) => s.s)).toEqual([0, 100, 200, 300]);
  });

  it("honours the start offset and the slot ceiling", () => {
    const m = measureSegment([0, 0], [1000, 0]);
    expect(
      distributeAlongPath({
        metric: m,
        mode: "spacing",
        spacingPt: 100,
        startOffsetPt: 550,
      }).map((s) => s.s),
    ).toEqual([550, 650, 750, 850, 950]);
    expect(
      distributeAlongPath({
        metric: m,
        mode: "spacing",
        spacingPt: 1,
        maxSlots: 7,
      }),
    ).toHaveLength(7);
  });

  it("a non-positive spacing yields NO slots (rather than an infinite walk)", () => {
    const m = measureSegment([0, 0], [400, 0]);
    expect(
      distributeAlongPath({ metric: m, mode: "spacing", spacingPt: 0 }),
    ).toEqual([]);
    expect(
      distributeAlongPath({ metric: m, mode: "spacing", spacingPt: -10 }),
    ).toEqual([]);
  });

  it("a DEGENERATE path places exactly one SPACING slot — there are no gaps to walk", () => {
    const m = measureSegment([7, 9], [7, 9]);
    const slots = distributeAlongPath({ metric: m, mode: "spacing", spacingPt: 10 });
    expect(slots).toHaveLength(1);
    expect(slots[0].point).toEqual([7, 9]);
  });

  it("…but a COUNT distribution survives a degenerate path, keeping its fractions", () => {
    // This is not a curiosity: two CONCENTRIC key objects give a blend a
    // spine of length ZERO, and collapsing that to one intermediate
    // would silently drop every step of an ordinary concentric blend.
    const m = measureSegment([7, 9], [7, 9]);
    const slots = distributeAlongPath({
      metric: m,
      mode: "count",
      count: 3,
      endpoints: "interior",
    });
    expect(slots).toHaveLength(3);
    expect(slots.map((s) => s.u)).toEqual([0.25, 0.5, 0.75]);
    expect(slots.map((s) => s.point)).toEqual([
      [7, 9],
      [7, 9],
      [7, 9],
    ]);
  });
});

describe("ease", () => {
  it("STRENGTH 0 is the identity for EVERY kind — that is what makes the default provably inert", () => {
    for (const kind of EASE_KINDS) {
      for (const t of [0, 0.13, 0.5, 0.87, 1]) {
        expect(ease(t, kind, 0)).toBe(t);
      }
    }
    // …and so is `linear` at any strength.
    expect(ease(0.3, "linear", 1)).toBe(0.3);
  });

  it("easeIn starts slow, easeOut starts fast, easeInOut is symmetric", () => {
    expect(ease(0.5, "easeIn", 1)).toBeCloseTo(0.25, 9);
    expect(ease(0.5, "easeOut", 1)).toBeCloseTo(0.75, 9);
    expect(ease(0.5, "easeInOut", 1)).toBeCloseTo(0.5, 9);
    expect(ease(0.25, "easeInOut", 1)).toBeCloseTo(0.125, 9);
    expect(ease(0.75, "easeInOut", 1)).toBeCloseTo(0.875, 9);
  });

  it("stays MONOTONIC at every strength — a non-monotonic ease would REORDER a blend's intermediates", () => {
    for (const kind of EASE_KINDS) {
      for (const strength of [0, 0.25, 0.5, 0.75, 1]) {
        let prev = -Infinity;
        for (let i = 0; i <= 40; i++) {
          const v = ease(i / 40, kind, strength);
          expect(v).toBeGreaterThanOrEqual(prev);
          prev = v;
        }
      }
    }
  });

  it("pins the endpoints and clamps hostile inputs", () => {
    for (const kind of EASE_KINDS) {
      expect(ease(0, kind, 1)).toBe(0);
      expect(ease(1, kind, 1)).toBe(1);
      expect(ease(-5, kind, 1)).toBe(0);
      expect(ease(5, kind, 1)).toBe(1);
      expect(ease(Number.NaN, kind, Number.NaN)).toBe(0);
    }
    // Strength clamps into 0..1 rather than extrapolating.
    expect(ease(0.5, "easeIn", 9)).toBeCloseTo(0.25, 9);
  });
});
