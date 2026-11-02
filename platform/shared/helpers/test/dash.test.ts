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
  DASH_PRESET_LENGTHS,
  dashArrayOp,
  dashLengthsFromPairs,
  dashPairsFromLengths,
} from "../src/index.ts";

describe("dash presets", () => {
  it("the four runs, and the one op that writes them", () => {
    expect(DASH_PRESET_LENGTHS.solid).toEqual([]);
    expect(DASH_PRESET_LENGTHS.dashed).toEqual([6, 3]);
    expect(DASH_PRESET_LENGTHS.dotted).toEqual([1, 3]);
    expect(DASH_PRESET_LENGTHS.dashDot).toEqual([6, 3, 1, 3]);
    expect(dashArrayOp("x", [6, 3])).toEqual({
      op: "setElementProperty",
      args: {
        elementId: "x",
        path: "frameStrokeDashArray",
        value: { type: "lengths", value: [6, 3] },
      },
    });
  });
});

describe("dashPairsFromLengths", () => {
  it("solid reads as null", () => {
    expect(dashPairsFromLengths([])).toBeNull();
    expect(dashPairsFromLengths(null)).toBeNull();
    expect(dashPairsFromLengths([0, 0])).toBeNull();
  });

  it("reads pairs, repeats an odd run, and counts the pairs past the third", () => {
    expect(dashPairsFromLengths([6, 3, 1, 3])).toEqual({
      pairs: [
        { dash: 6, gap: 3 },
        { dash: 1, gap: 3 },
      ],
      hiddenPairs: 0,
    });
    expect(dashPairsFromLengths([5])?.pairs).toEqual([{ dash: 5, gap: 5 }]);
    expect(dashPairsFromLengths([1, 2, 3])?.pairs).toEqual([
      { dash: 1, gap: 2 },
      { dash: 3, gap: 1 },
      { dash: 2, gap: 3 },
    ]);
    const long = dashPairsFromLengths([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    expect(long?.pairs).toHaveLength(3);
    expect(long?.hiddenPairs).toBe(2);
  });
});

describe("dashLengthsFromPairs", () => {
  it("keeps the first pair, drops later 0/0 pairs, and is solid when all zero", () => {
    expect(
      dashLengthsFromPairs([
        { dash: 6, gap: 3 },
        { dash: 0, gap: 0 },
        { dash: 1, gap: 3 },
      ]),
    ).toEqual([6, 3, 1, 3]);
    expect(dashLengthsFromPairs([{ dash: 0, gap: 0 }])).toEqual([]);
    expect(dashLengthsFromPairs([{ dash: -2, gap: 4 }])).toEqual([0, 4]);
  });
});
