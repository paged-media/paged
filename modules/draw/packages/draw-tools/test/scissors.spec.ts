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

import type { ElementId } from "@paged-media/plugin-api";
import { evalCubic, type AnchorTable } from "@paged-media/draw-geometry";

import { planScissorsAt, scissorsMutation } from "../src";

const corner = (x: number, y: number) => ({
  anchor: [x, y] as [number, number],
  left: [x, y] as [number, number],
  right: [x, y] as [number, number],
});

const SQUARE: AnchorTable = {
  anchors: [corner(0, 0), corner(100, 0), corner(100, 100), corner(0, 100)],
  subpathStarts: [0],
  subpathOpen: [false],
};

/** An open quarter-ish curve: 0 → 1 is a real cubic. */
const CURVE: AnchorTable = {
  anchors: [
    { anchor: [0, 0], left: [0, 0], right: [40, -30] },
    { anchor: [100, 0], left: [60, -30], right: [130, 20] },
    corner(150, 80),
  ],
  subpathStarts: [0],
  subpathOpen: [true],
};

const EL = { kind: "polygon", id: "p" } as ElementId;

describe("planScissorsAt", () => {
  it("a click ON an anchor cuts there, with no insert (the host Scissors' rule)", () => {
    expect(planScissorsAt(SQUARE, [100.5, 0.5], 2)).toEqual({ kind: "anchor", index: 1 });
  });

  it("a click on a SEGMENT plans the de Casteljau insert, then opens at the new anchor", () => {
    const plan = planScissorsAt(SQUARE, [40, 0.5], 2)!;
    expect(plan.kind).toBe("segment");
    if (plan.kind !== "segment") return;
    expect(plan.index).toBe(1);
    expect(plan.insert.insertIndex).toBe(1);
    // Corner anchors make the segment's parametrisation non-uniform, so
    // the closest-t refinement lands within its documented bound, not
    // exactly on the foot of the perpendicular.
    expect(plan.insert.anchor.anchor[0]).toBeCloseTo(40, 3);
    expect(plan.insert.anchor.anchor[1]).toBeCloseTo(0, 9);
  });

  it("the CLOSING segment of a closed contour inserts at the contour's end", () => {
    const plan = planScissorsAt(SQUARE, [0.5, 50], 2)!;
    expect(plan.kind).toBe("segment");
    expect(plan.index).toBe(4);
  });

  it("on a CURVE the inserted anchor lies ON the curve (the split does not move it)", () => {
    const click = evalCubic([0, 0], [40, -30], [60, -30], [100, 0], 0.37);
    const plan = planScissorsAt(CURVE, [click[0], click[1] + 0.2], 1)!;
    expect(plan.kind).toBe("segment");
    if (plan.kind !== "segment") return;
    expect(plan.insert.anchor.anchor[0]).toBeCloseTo(click[0], 1);
    expect(plan.insert.anchor.anchor[1]).toBeCloseTo(click[1], 1);
  });

  it("an OPEN contour's ENDPOINT is not a cut (the engine refuses it); an interior anchor is", () => {
    expect(planScissorsAt(CURVE, [0, 0], 1)).toBeNull();
    expect(planScissorsAt(CURVE, [150, 80], 1)).toBeNull();
    expect(planScissorsAt(CURVE, [100, 0], 1)).toEqual({ kind: "anchor", index: 1 });
  });

  it("a click on nothing plans nothing", () => {
    expect(planScissorsAt(SQUARE, [50, 50], 2)).toBeNull();
  });
});

describe("scissorsMutation", () => {
  it("a segment cut is ONE batch: the two handle writes, the insert, then pathOpenAt at the new index", () => {
    const plan = planScissorsAt(SQUARE, [40, 0.5], 2)!;
    const batch = scissorsMutation(plan, EL);
    expect(batch.op).toBe("batch");
    expect(batch.args.ops.map((o) => o.op)).toEqual([
      "pathPointSet",
      "pathPointSet",
      "pathPointInsert",
      "pathOpenAt",
    ]);
    expect(batch.args.ops[3]).toEqual({ op: "pathOpenAt", args: { elementId: EL, index: 1 } });
  });

  it("an anchor cut is the one pathOpenAt", () => {
    expect(scissorsMutation({ kind: "anchor", index: 2 }, EL)).toEqual({
      op: "batch",
      args: { ops: [{ op: "pathOpenAt", args: { elementId: EL, index: 2 } }] },
    });
  });
});
