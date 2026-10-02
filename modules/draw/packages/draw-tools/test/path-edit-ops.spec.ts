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

// The op vocabulary's lowering, and the index-addressed anchor planners
// the Pen's add / delete clicks ride.

import { describe, expect, it } from "vitest";

import { cornerAnchor, type AnchorTable } from "@paged-media/draw-geometry";
import type { ElementId } from "@paged-media/plugin-api";

import {
  planAnchorAdd,
  planAnchorAddAt,
  planAnchorDelete,
  planAnchorDeleteAt,
  segmentPairFrom,
} from "../src/anchor-machine";
import {
  anchorEditOps,
  lowerPathOp,
  pathEditBatch,
  targetedPathEditBatch,
} from "../src/path-edit-ops";
import { applyPathOps } from "./support/apply-ops";

const EL: ElementId = { kind: "polygon", id: "u1" };
const OTHER: ElementId = { kind: "graphicLine", id: "u2" };

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

function polyline(): AnchorTable {
  return {
    anchors: [cornerAnchor([0, 0]), cornerAnchor([10, 0]), cornerAnchor([20, 0])],
    subpathStarts: [0],
    subpathOpen: [true],
  };
}

describe("lowerPathOp", () => {
  it("lowers each op to its wire shape on the element", () => {
    expect(
      lowerPathOp(EL, { op: "pathPointSet", index: 2, role: "left", position: [1, 2] }),
    ).toEqual({
      op: "pathPointSet",
      args: { elementId: EL, index: 2, role: "left", position: [1, 2] },
    });
    expect(lowerPathOp(EL, { op: "pathPointRemove", index: 3 })).toEqual({
      op: "pathPointRemove",
      args: { elementId: EL, index: 3 },
    });
    expect(lowerPathOp(EL, { op: "pathPointCurveType", index: 1, smooth: true })).toEqual({
      op: "pathPointCurveType",
      args: { elementId: EL, index: 1, smooth: true },
    });
    expect(lowerPathOp(EL, { op: "closePath", subpath: 1 })).toEqual({
      op: "closePath",
      args: { elementId: EL, subpath: 1 },
    });
    expect(lowerPathOp(EL, { op: "joinPaths", otherId: OTHER })).toEqual({
      op: "joinPaths",
      args: { elementId: EL, otherId: OTHER },
    });
  });

  it("an insert carries the contour starts only when the plan supplied them", () => {
    const bare = lowerPathOp(EL, { op: "pathPointInsert", index: 3, anchor: cornerAnchor([5, 5]) });
    expect(bare).toEqual({
      op: "pathPointInsert",
      args: { elementId: EL, index: 3, anchor: cornerAnchor([5, 5]) },
    });
    // Absent, not `undefined`: an explicit key would serialise as null,
    // which the engine reads as "no override" only by luck.
    expect("prevSubpathStarts" in bare.args).toBe(false);
    expect(
      lowerPathOp(EL, {
        op: "pathPointInsert",
        index: 3,
        anchor: cornerAnchor([5, 5]),
        prevSubpathStarts: [0, 4],
      }).args,
    ).toMatchObject({ prevSubpathStarts: [0, 4] });
  });

  it("a set's position is a fresh tuple, not the plan's own array", () => {
    const position: [number, number] = [1, 2];
    const wire = lowerPathOp(EL, { op: "pathPointSet", index: 0, role: "anchor", position });
    expect(wire.op === "pathPointSet" && wire.args.position).not.toBe(position);
  });
});

describe("pathEditBatch / targetedPathEditBatch", () => {
  it("wraps a single-path op list in ONE batch, order preserved", () => {
    expect(
      pathEditBatch(EL, [
        { op: "pathPointRemove", index: 3 },
        { op: "pathPointRemove", index: 1 },
      ]),
    ).toEqual({
      op: "batch",
      args: {
        ops: [
          { op: "pathPointRemove", args: { elementId: EL, index: 3 } },
          { op: "pathPointRemove", args: { elementId: EL, index: 1 } },
        ],
      },
    });
  });

  it("a single op is still a batch — one gesture is one undo step by shape", () => {
    const batch = pathEditBatch(EL, [{ op: "closePath", subpath: 0 }]);
    expect(batch.op).toBe("batch");
    expect(batch.args.ops).toHaveLength(1);
  });

  it("addresses each op at ITS element and leaves no stray key behind", () => {
    const batch = targetedPathEditBatch([
      { elementId: EL, op: "pathPointInsert", index: 3, anchor: cornerAnchor([5, 5]) },
      { elementId: EL, op: "joinPaths", otherId: OTHER },
      { elementId: OTHER, op: "pathPointRemove", index: 0 },
    ]);
    expect(batch).toEqual({
      op: "batch",
      args: {
        ops: [
          { op: "pathPointInsert", args: { elementId: EL, index: 3, anchor: cornerAnchor([5, 5]) } },
          { op: "joinPaths", args: { elementId: EL, otherId: OTHER } },
          { op: "pathPointRemove", args: { elementId: OTHER, index: 0 } },
        ],
      },
    });
    for (const op of batch.args.ops) {
      expect(Object.keys(op).sort()).toEqual(["args", "op"]);
    }
  });
});

describe("anchorEditOps", () => {
  it("an insert keeps the planners' order: both handles at their old indices, then the anchor", () => {
    const table = polyline();
    const plan = planAnchorAdd(table, [5, 0], 1)!;
    const ops = anchorEditOps(plan);
    expect(ops.map((o) => o.op)).toEqual(["pathPointSet", "pathPointSet", "pathPointInsert"]);
    const after = applyPathOps(table, ops);
    expect(after.anchors.map((a) => a.anchor)).toEqual([
      [0, 0],
      [5, 0],
      [10, 0],
      [20, 0],
    ]);
  });

  it("a closing-edge insert carries the starts override through", () => {
    const table: AnchorTable = {
      anchors: [...square().anchors, cornerAnchor([100, 100]), cornerAnchor([110, 100])],
      subpathStarts: [0, 4],
      subpathOpen: [false, true],
    };
    const plan = planAnchorAddAt(table, 3, 0.5)!;
    const ops = anchorEditOps(plan);
    expect(ops[2]).toMatchObject({ op: "pathPointInsert", index: 4, prevSubpathStarts: [0, 5] });
    const after = applyPathOps(table, ops);
    // The new anchor closes out the FIRST contour; the second is intact.
    expect(after.subpathStarts).toEqual([0, 5]);
    expect(after.anchors[4].anchor).toEqual([0, 5]);
  });

  it("remove and convert are one op each", () => {
    expect(anchorEditOps({ kind: "remove", index: 2 })).toEqual([{ op: "pathPointRemove", index: 2 }]);
    expect(anchorEditOps({ kind: "convert", index: 1, smooth: true })).toEqual([
      { op: "pathPointCurveType", index: 1, smooth: true },
    ]);
  });
});

describe("index-addressed anchor planners", () => {
  it("segmentPairFrom finds the segment an anchor starts", () => {
    expect(segmentPairFrom(polyline(), 0)).toEqual([0, 1, null]);
    // The last anchor of an OPEN contour starts none…
    expect(segmentPairFrom(polyline(), 2)).toBeNull();
    // …of a CLOSED one it starts the closing edge.
    expect(segmentPairFrom(square(), 3)).toEqual([3, 0, 4]);
    expect(segmentPairFrom(square(), 9)).toBeNull();
  });

  it("planAnchorAddAt agrees with the click planner on the same point", () => {
    const table = square();
    const byIndex = planAnchorAddAt(table, 1, 0.25);
    if (byIndex?.kind !== "insert") throw new Error("expected insert");
    // Where t = ¼ falls on the right edge. Not a quarter of the way
    // down: a corner-to-corner cubic is straight but NOT linear in t
    // (B(t) = P0 + (3t² − 2t³)(P3 − P0)), so it is 10 · 0.15625.
    expect(byIndex.anchor.anchor).toEqual([10, 1.5625]);
    const byClick = planAnchorAdd(table, [10, 1.5625], 0.5);
    if (byClick?.kind !== "insert") throw new Error("expected insert");
    expect(byClick.segStart).toBe(byIndex.segStart);
    expect(byClick.segEnd).toBe(byIndex.segEnd);
    expect(byClick.insertIndex).toBe(byIndex.insertIndex);
    // The click planner SEARCHES for t (coarse scan + one Newton step);
    // the index planner is handed it. Same point, to the search's
    // precision.
    expect(byClick.anchor.anchor[0]).toBeCloseTo(10, 6);
    expect(byClick.anchor.anchor[1]).toBeCloseTo(1.5625, 1);
  });

  it("planAnchorAddAt clamps the parameter and refuses what is not a segment", () => {
    const table = polyline();
    const clamped = planAnchorAddAt(table, 0, 7);
    if (clamped?.kind !== "insert") throw new Error("expected insert");
    expect(clamped.anchor.anchor).toEqual([10, 0]);
    expect(planAnchorAddAt(table, 2, 0.5)).toBeNull();
    expect(planAnchorAddAt(table, 0, Number.NaN)).toBeNull();
  });

  it("planAnchorDeleteAt agrees with the click planner, floor included", () => {
    const table = polyline();
    expect(planAnchorDeleteAt(table, 1)).toEqual(planAnchorDelete(table, [10, 0], 1));
    expect(planAnchorDeleteAt(table, 1)).toEqual({ kind: "remove", index: 1 });
    const pair: AnchorTable = {
      anchors: [cornerAnchor([0, 0]), cornerAnchor([10, 0])],
      subpathStarts: [0],
      subpathOpen: [true],
    };
    expect(planAnchorDeleteAt(pair, 0)).toBeNull();
    expect(planAnchorDeleteAt(table, 3)).toBeNull();
    expect(planAnchorDeleteAt(table, -1)).toBeNull();
    expect(planAnchorDeleteAt(table, 0.5)).toBeNull();
  });
});
