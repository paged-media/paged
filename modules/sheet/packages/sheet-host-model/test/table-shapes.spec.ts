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

// Sheet ADR 530 — the shapes of a placed range on the page: a path per
// outline at the anchor cell plus its offset, painted by the shared mapper's
// look, its swatches minted once.

import { describe, expect, it } from "bun:test";

import {
  paletteSwatchId,
  tableShapeBox,
  tableShapeLosses,
  tableShapeOps,
  type LoweredContent,
  type LoweredShape,
} from "../src";

const content = {
  cols: [
    { index: 4, widthPt: 40 },
    { index: 5, widthPt: 60 },
  ],
  rows: [
    { index: 1, heightPt: 15, cells: [] },
    { index: 2, heightPt: 20, cells: [] },
  ],
  rules: { h: [], v: [] },
  merges: [],
  styles: [],
} as unknown as LoweredContent;

const corner = (x: number, y: number) => ({
  anchor: [x, y] as [number, number],
  left: [x, y] as [number, number],
  right: [x, y] as [number, number],
});

const shape: LoweredShape = {
  id: "xl/drawings/drawing1.xml#1",
  name: "Rectangle 1",
  row: 2,
  col: 5,
  dx: 3,
  dy: 2,
  wPt: 50,
  hPt: 30,
  items: [
    {
      anchors: [corner(0, 0), corner(50, 0), corner(50, 30), corner(0, 30)],
      closed: true,
      filled: true,
      stroked: true,
    },
  ],
  fx: {
    fill: "#FF0000",
    stroke: { color: "#0000FF", weight: 2 },
    dropShadow: {
      xOffset: 2,
      yOffset: 2,
      size: 2,
      opacity: 40,
      color: "#000000",
    },
  },
  losses: ["the text of a shape is not drawn on the page yet"],
};

type Op = { op: string; args: Record<string, unknown> };

describe("shapes over a page table [sheet.xlsx.shapes]", () => {
  it("places a shape at its anchor cell plus its offset", () => {
    expect(tableShapeBox(content, [40, 60], [100, 50], shape)).toEqual([
      117, 93, 147, 143,
    ]);
    expect(
      tableShapeBox(content, [40, 60], [0, 0], { ...shape, col: 9 }),
    ).toBeNull();
  });

  it("mints each colour once, inserts the path offset into the page and paints it", () => {
    const ops = tableShapeOps(
      { ...content, shapes: [shape, { ...shape, row: 1 }] },
      [40, 60],
      "p1" as never,
      [0, 0],
    ) as Op[];
    const mints = ops.filter((o) => o.op === "createSwatch");
    expect(mints).toHaveLength(3); // red, blue, the shadow's black
    const insert = ops.find((o) => o.op === "insertPath")!;
    expect(insert.args.open).toBe(false);
    expect(
      (insert.args.anchors as { anchor: number[] }[]).map((a) => a.anchor),
    ).toEqual([
      [43, 17],
      [93, 17],
      [93, 47],
      [43, 47],
    ]);
    const sets = ops
      .filter((o) => o.op === "setElementProperty")
      .map((o) => [o.args.path, (o.args.value as { value: unknown }).value]);
    expect(sets).toContainEqual([
      "frameFillColor",
      paletteSwatchId("chart", "FF0000"),
    ]);
    expect(sets).toContainEqual([
      "frameStrokeColor",
      paletteSwatchId("chart", "0000FF"),
    ]);
    expect(sets).toContainEqual(["frameStrokeWeight", 2]);
    expect(sets).toContainEqual(["frameDropShadow", true]);
    // A colour the document has is referenced; a failed read mints none.
    const known = new Set(
      ["FF0000", "0000FF", "000000"].map((h) => paletteSwatchId("chart", h)),
    );
    const content2 = { ...content, shapes: [shape] };
    const again = (k: Set<string> | null) =>
      tableShapeOps(content2, [40, 60], "p1" as never, [0, 0], k);
    expect(again(known).some((o) => o.op === "createSwatch")).toBe(false);
    expect(again(null).some((o) => o.op === "createSwatch")).toBe(false);
    expect(tableShapeLosses(content2)).toHaveLength(1);
  });

  it("keeps a shape without fill unfilled and writes several contours as one path", () => {
    const ring = {
      anchors: [
        corner(0, 0),
        corner(10, 0),
        corner(10, 10),
        corner(2, 2),
        corner(8, 2),
        corner(8, 8),
      ],
      subpathStarts: [0, 3],
      closed: true,
      filled: true,
      stroked: false,
    };
    const ops = tableShapeOps(
      {
        ...content,
        shapes: [
          {
            ...shape,
            fx: { stroke: { color: "#000000", weight: 1 } },
            items: [ring],
          },
        ],
      },
      [40, 60],
      "p1" as never,
      [0, 0],
    ) as Op[];
    const insert = ops.find((o) => o.op === "insertPath")!;
    expect((insert.args.anchors as unknown[]).length).toBe(3);
    const path = ops.find(
      (o) => o.op === "setElementProperty" && o.args.path === "framePath",
    )!;
    expect(
      (path.args.value as { value: { subpathStarts: number[] } }).value
        .subpathStarts,
    ).toEqual([0, 3]);
    // The stroke-less contour ends with no stroke colour over the shape's.
    const last = ops.filter((o) => o.op === "setElementProperty").at(-1)!;
    expect(last.args.path).toBe("frameStrokeColor");
    expect((last.args.value as { value: string }).value).toBe("Swatch/None");
  });
});
