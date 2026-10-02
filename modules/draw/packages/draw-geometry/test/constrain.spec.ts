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

import { constrainAngle, type Vec2 } from "../src";

const close = (actual: Vec2, expected: Vec2): void => {
  expect(actual[0]).toBeCloseTo(expected[0], 9);
  expect(actual[1]).toBeCloseTo(expected[1], 9);
};

describe("constrainAngle — the Shift constraint", () => {
  it("snaps a nearly-horizontal drag onto the horizontal, keeping its length", () => {
    // (10, 1) is 5.7° off the axis and √101 long.
    close(constrainAngle([0, 0], [10, 1]), [Math.sqrt(101), 0]);
  });

  it("snaps a nearly-vertical drag onto the vertical (y-down: +y is DOWN the page)", () => {
    close(constrainAngle([0, 0], [1, 10]), [0, Math.sqrt(101)]);
    close(constrainAngle([0, 0], [-1, -10]), [0, -Math.sqrt(101)]);
  });

  it("snaps to the 45° diagonals by default", () => {
    // (7, 8) is 48.8° — nearest multiple of 45° is 45°.
    const r = Math.hypot(7, 8);
    close(constrainAngle([0, 0], [7, 8]), [r * Math.SQRT1_2, r * Math.SQRT1_2]);
    close(constrainAngle([0, 0], [-7, 8]), [-r * Math.SQRT1_2, r * Math.SQRT1_2]);
  });

  it("measures the angle around the ORIGIN it is given, not the page origin", () => {
    // The pen's Shift-click: 45° from the PREVIOUS anchor.
    close(constrainAngle([100, 200], [110, 201]), [100 + Math.sqrt(101), 200]);
  });

  it("leaves a point that is already on a multiple where it is", () => {
    close(constrainAngle([0, 0], [5, 0]), [5, 0]);
    close(constrainAngle([0, 0], [-3, 3]), [-3, 3]);
    close(constrainAngle([2, 2], [2, -9]), [2, -9]);
  });

  it("honours a custom step", () => {
    // 90° steps: (7, 8) is nearer the vertical.
    close(constrainAngle([0, 0], [7, 8], 90), [0, Math.hypot(7, 8)]);
    // 15° steps: (10, 3) is 16.7° → 15°.
    const r = Math.hypot(10, 3);
    const a = (15 * Math.PI) / 180;
    close(constrainAngle([0, 0], [10, 3], 15), [r * Math.cos(a), r * Math.sin(a)]);
  });

  it("returns the point itself (a fresh tuple) when it sits on the origin", () => {
    const point: Vec2 = [4, 4];
    const out = constrainAngle([4, 4], point);
    expect(out).toEqual([4, 4]);
    expect(out).not.toBe(point);
  });
});
