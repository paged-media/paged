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

import {
  pathDistancesFrom,
  reshapeTable,
  reshapeWeight,
  type AnchorTable,
  type AnchorTriple,
} from "../src";

type P = [number, number];
const corner = (p: P): AnchorTriple => ({ anchor: p, left: p, right: p });
const row = (n: number, open = true): AnchorTable => ({
  anchors: Array.from({ length: n }, (_, i) => corner([i * 10, 0])),
  subpathStarts: [0],
  subpathOpen: [open],
});

describe("reshapeTable — the Reshape tool's falloff [plugin-draw.tool-wave-3]", () => {
  it("the bell is 1 at the anchor and 0 at the radius", () => {
    expect(reshapeWeight(0, 30)).toBe(1);
    expect(reshapeWeight(15, 30)).toBeCloseTo(0.5, 9);
    expect(reshapeWeight(30, 30)).toBe(0);
    expect(reshapeWeight(40, 30)).toBe(0);
  });

  it("the dragged anchor moves fully, its neighbours by less, far ones not at all", () => {
    const out = reshapeTable(row(9), 4, [0, 20], 25);
    const ys = out.anchors.map((a) => a.anchor[1]);
    expect(ys[4]).toBe(20);
    expect(ys[3]).toBeGreaterThan(0);
    expect(ys[3]).toBeLessThan(20);
    expect(ys[3]).toBeCloseTo(ys[5]!, 9);
    expect(ys[2]).toBeLessThan(ys[3]!);
    expect(ys[0]).toBe(0);
    expect(ys[8]).toBe(0);
    // Handles travel with their anchor.
    expect(out.anchors[3]!.left).toEqual(out.anchors[3]!.anchor);
  });

  it("distance is measured ALONG the path, and the short way round a closed one", () => {
    const sq: AnchorTable = {
      anchors: [
        corner([0, 0]),
        corner([10, 0]),
        corner([10, 10]),
        corner([0, 10]),
      ],
      subpathStarts: [0],
      subpathOpen: [false],
    };
    expect(pathDistancesFrom(sq, 0)).toEqual([0, 10, 20, 10]);
    // A U whose arms nearly touch: the far arm's tip is far along the path.
    const u: AnchorTable = {
      anchors: [
        corner([0, 0]),
        corner([0, 100]),
        corner([2, 100]),
        corner([2, 0]),
      ],
      subpathStarts: [0],
      subpathOpen: [true],
    };
    const out = reshapeTable(u, 0, [-10, 0], 20);
    expect(out.anchors[3]!.anchor).toEqual([2, 0]);
  });

  it("another contour of the same element does not move", () => {
    const t: AnchorTable = {
      anchors: [...row(3).anchors, corner([0, 50]), corner([10, 50])],
      subpathStarts: [0, 3],
      subpathOpen: [true, true],
    };
    const out = reshapeTable(t, 1, [0, 10], 100);
    expect(out.anchors[3]!.anchor).toEqual([0, 50]);
    expect(out.anchors[4]!.anchor).toEqual([10, 50]);
  });
});
