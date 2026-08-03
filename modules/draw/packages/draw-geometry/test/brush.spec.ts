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
  anchorTangentAngle,
  calligraphicWidth,
  MIN_BRUSH_WIDTH_RATIO,
  type AnchorTriple,
  type NibProfile,
} from "../src";

const NIB: NibProfile = { angle: 0, roundness: 0.3, size: 6 };

const corner = (x: number, y: number): AnchorTriple => ({
  anchor: [x, y],
  left: [x, y],
  right: [x, y],
});

describe("calligraphicWidth", () => {
  it("deposits the full nib size perpendicular to the nib (neutral pressure)", () => {
    // Nib at 0 rad, stroke moving straight up (tangent π/2).
    expect(calligraphicWidth(Math.PI / 2, NIB)).toBeCloseTo(6);
  });

  it("deposits roundness·size along the nib", () => {
    expect(calligraphicWidth(0, NIB)).toBeCloseTo(0.3 * 6);
  });

  it("interpolates by |sin(tangent − angle)| between the extremes", () => {
    const w = calligraphicWidth(Math.PI / 4, NIB);
    expect(w).toBeCloseTo(6 * (0.3 + 0.7 * Math.sin(Math.PI / 4)));
    // A 45° nib against a horizontal stroke gives the same interpolant.
    const nib45: NibProfile = { ...NIB, angle: Math.PI / 4 };
    expect(calligraphicWidth(0, nib45)).toBeCloseTo(w);
  });

  it("a round nib (roundness 1) is angle-independent", () => {
    const round: NibProfile = { angle: 1.2, roundness: 1, size: 6 };
    for (const t of [0, 0.7, Math.PI / 2, 2.9]) {
      expect(calligraphicWidth(t, round)).toBeCloseTo(6);
    }
  });

  it("is symmetric under tangent reversal (θ and θ+π paint the same width)", () => {
    for (const t of [0.2, 1.1, 2.5]) {
      expect(calligraphicWidth(t + Math.PI, NIB)).toBeCloseTo(
        calligraphicWidth(t, NIB),
      );
    }
  });

  it("pressure scales the width: neutral 0.5 → 1×, 1 → 2×, floored near 0", () => {
    const base = calligraphicWidth(Math.PI / 2, NIB, 0.5);
    expect(base).toBeCloseTo(6);
    expect(calligraphicWidth(Math.PI / 2, NIB, 1)).toBeCloseTo(12);
    expect(calligraphicWidth(Math.PI / 2, NIB, 0.25)).toBeCloseTo(3);
    // Zero pressure floors at the hairline ratio, never a zero stop.
    expect(calligraphicWidth(Math.PI / 2, NIB, 0)).toBeCloseTo(
      MIN_BRUSH_WIDTH_RATIO * 6,
    );
  });

  it("a razor nib stroked along itself still floors at the hairline", () => {
    const razor: NibProfile = { angle: 0, roundness: 0, size: 10 };
    expect(calligraphicWidth(0, razor)).toBeCloseTo(
      MIN_BRUSH_WIDTH_RATIO * 10,
    );
  });

  it("defensive inputs: non-positive/non-finite size → 0; roundness clamps", () => {
    expect(calligraphicWidth(1, { angle: 0, roundness: 0.3, size: 0 })).toBe(0);
    expect(calligraphicWidth(1, { angle: 0, roundness: 0.3, size: -4 })).toBe(0);
    expect(calligraphicWidth(1, { angle: 0, roundness: 0.3, size: NaN })).toBe(0);
    // roundness above 1 clamps to a round nib.
    expect(
      calligraphicWidth(0, { angle: 0, roundness: 7, size: 6 }),
    ).toBeCloseTo(6);
  });
});

describe("anchorTangentAngle", () => {
  it("corner run: central difference inside, one-sided at open endpoints", () => {
    const run = [corner(0, 0), corner(100, 0), corner(100, 100)];
    // Start: one-sided toward the next anchor (horizontal).
    expect(anchorTangentAngle(run, 0)).toBeCloseTo(0);
    // Middle: central difference (0,0)→(100,100) — 45°.
    expect(anchorTangentAngle(run, 1)).toBeCloseTo(Math.PI / 4);
    // End: one-sided from the previous anchor (vertical, +y).
    expect(anchorTangentAngle(run, 2)).toBeCloseTo(Math.PI / 2);
  });

  it("a smooth anchor's fitted handles win over the neighbor difference", () => {
    const run: AnchorTriple[] = [
      corner(0, 0),
      // Handles span vertically even though the neighbors are horizontal.
      { anchor: [50, 0], left: [50, -10], right: [50, 10] },
      corner(100, 0),
    ];
    expect(anchorTangentAngle(run, 1)).toBeCloseTo(Math.PI / 2);
  });

  it("closed runs wrap the neighbor difference around the contour", () => {
    const quad = [
      corner(0, 0),
      corner(100, 0),
      corner(100, 100),
      corner(0, 100),
    ];
    // At index 0 the previous neighbor is the LAST anchor (0,100):
    // (0,100)→(100,0) — down-right in page coords.
    expect(anchorTangentAngle(quad, 0, true)).toBeCloseTo(
      Math.atan2(-100, 100),
    );
  });

  it("degenerate inputs answer 0", () => {
    expect(anchorTangentAngle([], 0)).toBe(0);
    expect(anchorTangentAngle([corner(5, 5)], 0)).toBe(0);
    expect(anchorTangentAngle([corner(5, 5), corner(5, 5)], 0)).toBe(0);
  });
});
