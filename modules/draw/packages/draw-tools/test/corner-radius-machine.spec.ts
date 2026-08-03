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
  cornerAt,
  cornerPreview,
  maxRadius,
  radiusFromDrag,
  type Bounds,
} from "../src/corner-radius-machine";

// A 100×60 rectangle: top 10, left 20, bottom 70, right 120.
const B: Bounds = [10, 20, 70, 120];

describe("cornerAt", () => {
  it("hits each corner within tolerance, in IDML order", () => {
    expect(cornerAt(B, [21, 11], 4)).toBe(0); // TL
    expect(cornerAt(B, [119, 12], 4)).toBe(1); // TR
    expect(cornerAt(B, [118, 69], 4)).toBe(2); // BR
    expect(cornerAt(B, [22, 68], 4)).toBe(3); // BL
    expect(cornerAt(B, [70, 40], 4)).toBeNull(); // center — no corner
  });
});

describe("radiusFromDrag", () => {
  it("reads the inward drag and clamps to half the short side", () => {
    // TL inward drag by (15, 12) → the smaller inward axis wins: 12.
    expect(radiusFromDrag(B, 0, [35, 22])).toBe(12);
    // Dragging past the middle clamps to min(w,h)/2 = 30.
    expect(radiusFromDrag(B, 0, [120, 70])).toBe(30);
    expect(maxRadius(B)).toBe(30);
  });

  it("an outward drag reads 0 (never a negative radius)", () => {
    expect(radiusFromDrag(B, 0, [0, 0])).toBe(0);
    // BR corner outward.
    expect(radiusFromDrag(B, 2, [130, 80])).toBe(0);
  });
});

describe("cornerPreview", () => {
  it("draws the L through the corner with the radius extent on both edges", () => {
    expect(cornerPreview(B, 0, 10)).toEqual([
      [30, 10],
      [20, 10],
      [20, 20],
    ]);
    expect(cornerPreview(B, 2, 8)).toEqual([
      [112, 70],
      [120, 70],
      [120, 62],
    ]);
  });
});
