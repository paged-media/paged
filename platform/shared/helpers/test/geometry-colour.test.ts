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

import { describe, expect, it } from "bun:test";

import { nativeHexRgb } from "@paged-media/plugin-sdk";

import { hexToRgb, linearToSrgb, srgbToLinear } from "../src/colour.ts";
import { KAPPA } from "../src/geometry.ts";

describe("KAPPA", () => {
  it("is the cubic quarter circle's control distance", () => {
    expect(Math.abs(KAPPA - (4 / 3) * (Math.SQRT2 - 1))).toBeLessThan(1e-15);
  });
});

describe("the sRGB transfer curve", () => {
  it("has the published anchors", () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 12);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.21404114048, 10);
    expect(linearToSrgb(0.21404114048)).toBeCloseTo(0.5, 9);
  });
  it("round-trips every 8-bit value", () => {
    for (let i = 0; i <= 255; i++)
      expect(Math.round(linearToSrgb(srgbToLinear(i / 255)) * 255)).toBe(i);
  });
});

describe("hexToRgb", () => {
  it("reads every form the SDK's nativeHexRgb reads, to the same channels", () => {
    for (const hex of [
      "#abc",
      "ABC",
      " #a1B2c3 ",
      "000000",
      "#12345",
      "",
      "#ggg",
      "#ffffff",
    ])
      expect(hexToRgb(hex)).toEqual(nativeHexRgb(hex));
  });
});
