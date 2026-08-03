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

import { pointInPolygon, type Vec2 } from "../src";

const SQUARE: Vec2[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

describe("pointInPolygon", () => {
  it("inside / outside a convex square", () => {
    expect(pointInPolygon([5, 5], SQUARE)).toBe(true);
    expect(pointInPolygon([15, 5], SQUARE)).toBe(false);
    expect(pointInPolygon([-1, 5], SQUARE)).toBe(false);
    expect(pointInPolygon([5, 11], SQUARE)).toBe(false);
  });

  it("handles a concave (L-shaped) ring by even-odd crossings", () => {
    const L: Vec2[] = [
      [0, 0],
      [10, 0],
      [10, 4],
      [4, 4],
      [4, 10],
      [0, 10],
    ];
    expect(pointInPolygon([2, 8], L)).toBe(true); // in the vertical leg
    expect(pointInPolygon([8, 2], L)).toBe(true); // in the horizontal leg
    expect(pointInPolygon([8, 8], L)).toBe(false); // in the notch
  });

  it("winding order does not matter", () => {
    const reversed = [...SQUARE].reverse();
    expect(pointInPolygon([5, 5], reversed)).toBe(true);
    expect(pointInPolygon([15, 5], reversed)).toBe(false);
  });

  it("fewer than 3 vertices answers false", () => {
    expect(pointInPolygon([0, 0], [])).toBe(false);
    expect(
      pointInPolygon(
        [0, 0],
        [
          [0, 0],
          [1, 1],
        ],
      ),
    ).toBe(false);
  });
});
