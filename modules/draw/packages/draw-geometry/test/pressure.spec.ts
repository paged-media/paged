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
  NEUTRAL_PRESSURE,
  clampPressure,
  strokeWidthFromPressure,
} from "../src/pressure";

describe("clampPressure", () => {
  it("passes through values already in 0..1", () => {
    expect(clampPressure(0)).toBe(0);
    expect(clampPressure(0.37)).toBeCloseTo(0.37);
    expect(clampPressure(1)).toBe(1);
  });

  it("clamps out-of-range samples to the 0..1 ends", () => {
    expect(clampPressure(-0.5)).toBe(0);
    expect(clampPressure(2)).toBe(1);
  });

  it("falls back to the neutral pressure on a non-finite sample", () => {
    expect(clampPressure(Number.NaN)).toBe(NEUTRAL_PRESSURE);
    expect(clampPressure(Number.POSITIVE_INFINITY)).toBe(NEUTRAL_PRESSURE);
  });
});

describe("strokeWidthFromPressure", () => {
  const profile = { min: 0.5, max: 4 };

  it("maps the pressure ends to the profile ends", () => {
    expect(strokeWidthFromPressure(0, profile)).toBeCloseTo(0.5);
    expect(strokeWidthFromPressure(1, profile)).toBeCloseTo(4);
  });

  it("lands a mouse's neutral 0.5 mid-range", () => {
    expect(strokeWidthFromPressure(NEUTRAL_PRESSURE, profile)).toBeCloseTo(2.25);
  });

  it("clamps before interpolating so an out-of-range sample stays bounded", () => {
    expect(strokeWidthFromPressure(5, profile)).toBeCloseTo(4);
    expect(strokeWidthFromPressure(-1, profile)).toBeCloseTo(0.5);
  });
});
