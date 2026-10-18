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

import { cornerAnchor, type AnchorTable } from "@paged-media/draw-geometry";

import {
  planAnchorAdd,
  planAnchorConvert,
  planAnchorDelete,
  segmentPairsOf,
} from "../src/anchor-machine";

/** Closed unit square (corner anchors, one subpath). */
function square(): AnchorTable {
  return {
    anchors: [
      cornerAnchor([0, 0]),
      cornerAnchor([10, 0]),
      cornerAnchor([10, 10]),
      cornerAnchor([0, 10]),
    ],
    subpathStarts: [0],
    subpathOpen: [false],
  };
}

/** Open three-point polyline. */
function polyline(): AnchorTable {
  return {
    anchors: [cornerAnchor([0, 0]), cornerAnchor([10, 0]), cornerAnchor([20, 0])],
    subpathStarts: [0],
    subpathOpen: [true],
  };
}

describe("segmentPairsOf", () => {
  it("open subpath: adjacent pairs only", () => {
    expect(segmentPairsOf(polyline())).toEqual([
      [0, 1, null],
      [1, 2, null],
    ]);
  });

  it("closed subpath: adds the wraparound edge carrying subEnd", () => {
    const pairs = segmentPairsOf(square());
    expect(pairs).toContainEqual([3, 0, 4]);
    expect(pairs).toHaveLength(4);
  });

  it("two subpaths enumerate independently", () => {
    const table: AnchorTable = {
      anchors: [
        cornerAnchor([0, 0]),
        cornerAnchor([10, 0]),
        cornerAnchor([10, 10]),
        cornerAnchor([20, 20]),
        cornerAnchor([30, 20]),
        cornerAnchor([30, 30]),
      ],
      subpathStarts: [0, 3],
      subpathOpen: [false, false],
    };
    const pairs = segmentPairsOf(table);
    expect(pairs).toContainEqual([2, 0, 3]); // first subpath's closing edge
    expect(pairs).toContainEqual([5, 3, 6]); // second subpath's closing edge
    expect(pairs).not.toContainEqual([2, 3, null]); // no cross-subpath pair
  });
});

describe("planAnchorDelete", () => {
  it("plans removal of the nearest anchor within tolerance", () => {
    expect(planAnchorDelete(square(), [9.5, 0.5], 2)).toEqual({
      kind: "remove",
      index: 1,
    });
  });

  it("returns null when nothing is in range", () => {
    expect(planAnchorDelete(square(), [5, 5], 2)).toBeNull();
  });

  it("refuses to shrink a 2-anchor contour", () => {
    const line: AnchorTable = {
      anchors: [cornerAnchor([0, 0]), cornerAnchor([10, 0])],
      subpathStarts: [0],
      subpathOpen: [true],
    };
    expect(planAnchorDelete(line, [0, 0], 2)).toBeNull();
  });
});

describe("planAnchorConvert", () => {
  it("corner anchor converts to smooth", () => {
    expect(planAnchorConvert(square(), [0, 0], 2)).toEqual({
      kind: "convert",
      index: 0,
      smooth: true,
    });
  });

  it("smooth anchor converts to corner", () => {
    const table: AnchorTable = {
      anchors: [
        { anchor: [0, 0], left: [-5, 0], right: [5, 0] },
        cornerAnchor([10, 0]),
        cornerAnchor([10, 10]),
      ],
      subpathStarts: [0],
      subpathOpen: [true],
    };
    expect(planAnchorConvert(table, [0.5, 0], 2)).toEqual({
      kind: "convert",
      index: 0,
      smooth: false,
    });
  });
});

describe("planAnchorAdd", () => {
  it("splits an interior straight segment at the click", () => {
    const plan = planAnchorAdd(polyline(), [5, 0.5], 2);
    expect(plan).not.toBeNull();
    if (plan?.kind !== "insert") throw new Error("expected insert");
    expect(plan.segStart).toBe(0);
    expect(plan.segEnd).toBe(1);
    expect(plan.insertIndex).toBe(1);
    expect(plan.anchor.anchor[0]).toBeCloseTo(5, 1);
    expect(plan.anchor.anchor[1]).toBeCloseTo(0, 5);
    expect(plan.prevSubpathStarts).toBeUndefined();
  });

  it("returns null off-curve", () => {
    expect(planAnchorAdd(polyline(), [5, 8], 2)).toBeNull();
  });

  it("the last subpath's closing edge inserts at subEnd without an override", () => {
    const plan = planAnchorAdd(square(), [0, 5], 1);
    expect(plan).not.toBeNull();
    if (plan?.kind !== "insert") throw new Error("expected insert");
    // Closing edge is [3, 0, 4] (left side of the square: (0,10)→(0,0)).
    expect(plan.segStart).toBe(3);
    expect(plan.segEnd).toBe(0);
    expect(plan.insertIndex).toBe(4);
    expect(plan.prevSubpathStarts).toBeUndefined();
  });

  it("a non-final subpath's closing edge supplies the starts override", () => {
    const table: AnchorTable = {
      anchors: [
        cornerAnchor([0, 0]),
        cornerAnchor([10, 0]),
        cornerAnchor([10, 10]),
        cornerAnchor([100, 100]),
        cornerAnchor([110, 100]),
        cornerAnchor([110, 110]),
      ],
      subpathStarts: [0, 3],
      subpathOpen: [false, false],
    };
    // Click on the FIRST subpath's closing edge (10,10)→(0,0).
    const plan = planAnchorAdd(table, [5, 5], 1);
    expect(plan).not.toBeNull();
    if (plan?.kind !== "insert") throw new Error("expected insert");
    expect(plan.insertIndex).toBe(3);
    expect(plan.prevSubpathStarts).toEqual([0, 4]);
  });
});
