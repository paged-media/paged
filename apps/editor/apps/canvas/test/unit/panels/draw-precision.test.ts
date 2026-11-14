/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// paged.draw ADR 370 — the inspector's Points section, the Shape
// suggestions and the Pathfinder's operand outline, as arithmetic: what
// each shows and the one batch each edit sends.

import { describe, expect, test } from "bun:test";

import {
  alignAnchorsOps,
  curveTypeOps,
  moveAnchorsOps,
  pointBatch,
  removeAnchorsOps,
  summarizePoints,
  toInner,
} from "../../../src/panels/anchor-points";
import {
  SIMPLIFY_FROM_ANCHORS,
  isComplexShape,
  smoothCornerOps,
  suggestShapeActions,
} from "../../../src/panels/shape-suggestions";
import {
  operandPreview,
  specialRole,
} from "../../../src/panels/pathfinder-preview";

const corner = (x: number, y: number) => ({
  anchor: [x, y] as [number, number],
  left: [x, y] as [number, number],
  right: [x, y] as [number, number],
});
const smooth = (x: number, y: number) => ({
  anchor: [x, y] as [number, number],
  left: [x - 10, y] as [number, number],
  right: [x + 10, y] as [number, number],
});

describe("the Points section (paged.draw ADR 370)", () => {
  const page = [corner(10, 10), smooth(50, 30), corner(90, 20)];

  test("one anchor: its point and type; several: their bounds and a mixed type", () => {
    expect(summarizePoints(page, [1])).toEqual({
      count: 1,
      x: 50,
      y: 30,
      width: 0,
      height: 0,
      kind: "smooth",
    });
    expect(summarizePoints(page, [0, 2])).toMatchObject({
      count: 2,
      x: 10,
      y: 10,
      width: 80,
      height: 10,
      kind: "corner",
    });
    expect(summarizePoints(page, [0, 1])?.kind).toBe("mixed");
    expect(summarizePoints(page, [])).toBeNull();
  });

  test("a move takes each anchor and its handles by the delta, through the path's transform", () => {
    // Identity: the inner delta is the page delta.
    const ops = moveAnchorsOps(page, null, [1], 5, -2);
    expect(ops).toEqual([
      { op: "pathPointSet", index: 1, role: "anchor", position: [55, 28] },
      { op: "pathPointSet", index: 1, role: "left", position: [45, 28] },
      { op: "pathPointSet", index: 1, role: "right", position: [65, 28] },
    ]);
    // A path scaled ×2 and moved: a page delta of 10 is 5 inside it.
    const m: [number, number, number, number, number, number] = [
      2, 0, 0, 2, 100, 100,
    ];
    const scaled = moveAnchorsOps([corner(0, 0)], m, [0], 10, 0);
    expect(scaled[0]).toEqual({
      op: "pathPointSet",
      index: 0,
      role: "anchor",
      position: [5, 0],
    });
    expect(toInner(m, [110, 120])).toEqual([5, 10]);
    expect(moveAnchorsOps(page, null, [0], 0, 0)).toEqual([]);
  });

  test("align lines the anchors up on their average; corner/smooth and delete are point ops", () => {
    const ops = alignAnchorsOps(page, null, page, [0, 2], "horizontal");
    // y 10 and 20 → 15 each, x unchanged.
    expect(
      ops.filter((o) => o.op === "pathPointSet" && o.role === "anchor"),
    ).toEqual([
      { op: "pathPointSet", index: 0, role: "anchor", position: [10, 15] },
      { op: "pathPointSet", index: 2, role: "anchor", position: [90, 15] },
    ]);
    expect(alignAnchorsOps(page, null, page, [0], "vertical")).toEqual([]);
    expect(curveTypeOps([0, 2], true)).toEqual([
      { op: "pathPointCurveType", index: 0, smooth: true },
      { op: "pathPointCurveType", index: 2, smooth: true },
    ]);
    // Highest index first: a removal shifts the ones after it.
    expect(removeAnchorsOps([0, 2]).map((o) => o.index)).toEqual([2, 0]);
  });

  test("every edit is ONE batch on the path", () => {
    const id = { kind: "polygon", id: "p1" };
    const batch = pointBatch(id, removeAnchorsOps([1]));
    expect(batch.op).toBe("batch");
    expect(batch.args.ops).toEqual([
      { op: "pathPointRemove", args: { elementId: id, index: 1 } },
    ]);
  });
});

describe("Shape suggestions (paged.draw ADR 370)", () => {
  const all = () => true;
  const star = {
    kind: "polygon",
    anchors: Array.from({ length: 10 }, (_, i) =>
      corner(Math.cos(i) * 50, Math.sin(i) * 50),
    ),
    subpathOpen: [false],
  };

  test("a closed polygon of corners: round, smooth, offset, repeat, mirror", () => {
    expect(isComplexShape(star)).toBe(true);
    expect(suggestShapeActions(star, all).map((s) => s.id)).toEqual([
      "roundCorners",
      "smooth",
      "offset",
      "repeat",
      "mirror",
    ]);
    expect(smoothCornerOps(star)).toHaveLength(10);
  });

  test("a dense path also simplifies; an open line neither rounds nor offsets", () => {
    const dense = {
      kind: "polygon",
      anchors: Array.from({ length: SIMPLIFY_FROM_ANCHORS }, (_, i) =>
        smooth(i * 10, (i % 2) * 5),
      ),
      subpathOpen: [true],
    };
    const ids = suggestShapeActions(dense, all).map((s) => s.id);
    expect(ids).toContain("simplify");
    expect(ids).not.toContain("roundCorners");
    expect(ids).not.toContain("offset");
  });

  test("only commands the editor offers; a two-point straight line is not complex", () => {
    const only = suggestShapeActions(
      star,
      (c) => c === "paged.corners.rounded",
    );
    expect(only.map((s) => s.id)).toEqual(["roundCorners", "smooth"]);
    expect(
      isComplexShape({
        kind: "graphicLine",
        anchors: [corner(0, 0), corner(9, 9)],
      }),
    ).toBe(false);
    expect(isComplexShape({ kind: "textFrame", anchors: star.anchors })).toBe(
      false,
    );
  });
});

describe("the Pathfinder's outline before the click (paged.draw ADR 370)", () => {
  const a = { kind: "polygon", id: "a" };
  const b = { kind: "polygon", id: "b" };
  const boxes = [
    {
      id: a,
      pageId: "p",
      bounds: [0, 0, 10, 10] as [number, number, number, number],
    },
    {
      id: b,
      pageId: "p",
      bounds: [5, 5, 15, 15] as [number, number, number, number],
    },
  ];

  test("a shape mode keeps the first selected: solid and named, the other dashed", () => {
    expect(specialRole("union")).toEqual({
      which: "first-selected",
      role: "result",
    });
    const shapes = operandPreview("union", boxes, b, "Keeps the result");
    const paths = shapes.filter((s) => "anchors" in s);
    expect(paths.map((p) => p.dashed)).toEqual([false, true]);
    expect(shapes.find((s) => s.kind === "text")).toMatchObject({
      text: "Keeps the result",
      x: 0,
    });
  });

  test("Crop cuts with the frontmost; Divide outlines all alike", () => {
    const crop = operandPreview("pathfinderCrop", boxes, b, "Cuts the others");
    expect(crop.filter((s) => "anchors" in s).map((p) => p.dashed)).toEqual([
      true,
      false,
    ]);
    const divide = operandPreview("pathfinderDivide", boxes, b, null);
    expect(divide.filter((s) => "anchors" in s).map((p) => p.dashed)).toEqual([
      false,
      false,
    ]);
    expect(divide.some((s) => s.kind === "text")).toBe(false);
  });
});
