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
  BINDING_KEY,
  paletteSwatchId,
  parseShapeStamp,
  placedShapesIn,
  shapeHash,
  shapePresetWrite,
  shapeStampValue,
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

  it("links the first path of a shape with a click action to its URL", () => {
    const ops = tableShapeOps(
      {
        ...content,
        shapes: [
          {
            ...shape,
            link: "https://paged.media",
            items: [shape.items[0]!, shape.items[0]!],
          },
        ],
      },
      [40, 60],
      "p1" as never,
      [0, 0],
    ) as Op[];
    const links = ops.filter((o) => o.op === "insertItemHyperlink");
    expect(links).toEqual([
      {
        op: "insertItemHyperlink",
        args: {
          item: "$h:sheetShape_0_0",
          url: "https://paged.media",
          name: shape.id,
        },
      },
    ]);
    const bind = ops.findIndex((o) => o.op === "bindCreated");
    expect(ops[bind - 1]!.op).toBe("insertPath");
  });

  it("gives a preset item its engine preset and its turn in spread coordinates [engine ADR 1096]", () => {
    const turned: LoweredShape = {
      ...shape,
      transform: [0, 1, -1, 0, 40, -10],
      items: [
        {
          ...shape.items[0]!,
          preset: {
            name: "roundRect",
            adjusts: [["adj", "val 5000"]],
            frame: [0, 0, 50, 30],
            key: shape.id,
          },
        },
      ],
    };
    const ops = tableShapeOps(
      { ...content, shapes: [turned] },
      [40, 60],
      "p1" as never,
      [0, 0],
      undefined,
      { pageOrigin: [612, 0] },
    ) as Op[];
    // insertPath takes page coordinates; the raw writes take the spread's.
    const insert = ops.find((o) => o.op === "insertPath")!;
    expect((insert.args.anchors as { anchor: number[] }[])[0]!.anchor).toEqual([
      43, 17,
    ]);
    const set = (path: string) =>
      ops.find((o) => o.op === "setElementProperty" && o.args.path === path)!
        .args.value as { value: unknown };
    expect(JSON.parse(set("frameShapePreset").value as string)).toEqual({
      name: "roundRect",
      adjusts: [["adj", "val 5000"]],
      frame: [655, 17, 50, 30],
      key: shape.id,
    });
    // The anchor box's turn about its centre, moved to the box's place in
    // the spread: (tx, ty) = (655, 17).
    expect(set("frameTransform").value).toEqual([
      0,
      1,
      -1,
      0,
      40 + 655 - 0 * 655 - -1 * 17,
      -10 + 17 - 1 * 655 - 0 * 17,
    ]);
  });

  it("sets Office's line ends and the nearest InDesign arrowhead beside them", () => {
    const line: LoweredShape = {
      ...shape,
      fx: { stroke: { color: "#000000", weight: 1 } },
      items: [
        {
          anchors: [corner(0, 0), corner(50, 0)],
          closed: false,
          filled: false,
          stroked: true,
          startHead: { kind: "oval" },
          endHead: { kind: "triangle", w: "lg" },
          startArrowhead: "CircleSolidArrowHead",
          endArrowhead: "TriangleArrowHead",
        },
      ],
    };
    const ops = tableShapeOps(
      { ...content, shapes: [line] },
      [40, 60],
      "p1" as never,
      [0, 0],
    ) as Op[];
    const sets = ops
      .filter((o) => o.op === "setElementProperty")
      .map((o) => [o.args.path, (o.args.value as { value: unknown }).value]);
    expect(sets).toContainEqual([
      "frameStrokeStartArrowhead",
      "CircleSolidArrowHead",
    ]);
    expect(sets).toContainEqual([
      "frameStrokeEndArrowhead",
      "TriangleArrowHead",
    ]);
    // Office's own heads, through the engine's paths.
    expect(sets).toContainEqual([
      "frameStrokeStartOfficeHead",
      JSON.stringify({ kind: "oval" }),
    ]);
    expect(sets).toContainEqual([
      "frameStrokeEndOfficeHead",
      JSON.stringify({ kind: "triangle", w: "lg" }),
    ]);
  });

  it("stamps each item, and keeps a placed shape the workbook did not change", () => {
    const ops = tableShapeOps(
      { ...content, shapes: [shape] },
      [40, 60],
      "p1" as never,
      [0, 0],
      undefined,
      { sheet: 0 },
    ) as Op[];
    const meta = ops.find((o) => o.op === "setPluginMetadata")!;
    expect(meta.args.key).toBe(BINDING_KEY);
    expect(parseShapeStamp(meta.args.value as string)).toEqual({
      id: shape.id,
      item: 0,
      hash: shapeHash(shape),
      sheet: 0,
    });
    const el = { kind: "polygon", id: "u9" } as never;
    const placed = (hash: string, table?: string) =>
      new Map([
        [
          shape.id,
          { id: shape.id, hash, items: [el], ...(table ? { table } : {}) },
        ],
      ]);
    const refresh = (
      p: ReturnType<typeof placed>,
      shapes: LoweredShape[] = [shape],
    ) =>
      tableShapeOps(
        { ...content, shapes },
        [40, 60],
        "p1" as never,
        [0, 0],
        undefined,
        { placed: p, table: "tf1", sheet: 0 },
      ) as Op[];
    // Unchanged and stamped with this table: nothing at all.
    expect(refresh(placed(shapeHash(shape), "tf1"))).toEqual([]);
    // Unchanged, not yet naming the table: only its stamp is completed.
    const restamp = refresh(placed(shapeHash(shape)));
    expect(restamp.map((o) => o.op)).toEqual(["setPluginMetadata"]);
    expect(parseShapeStamp(restamp[0]!.args.value as string)?.table).toBe(
      "tf1",
    );
    // Changed in the workbook: removed and drawn again.
    const redrawn = refresh(placed("old", "tf1"));
    expect(redrawn[0]).toEqual({ op: "deleteFrame", args: { frameId: "u9" } });
    expect(redrawn.some((o) => o.op === "insertPath")).toBe(true);
    // Gone from the workbook: removed.
    expect(refresh(placed(shapeHash(shape), "tf1"), [])).toEqual([
      { op: "deleteFrame", args: { frameId: "u9" } },
    ]);
  });

  it("finds a table's placed shapes by their stamps in the scene tree", () => {
    const stamp = (id: string, item: number, table?: string, sheet = 0) => [
      {
        key: BINDING_KEY,
        value: shapeStampValue({ id, item, hash: "h", sheet, table }),
      },
    ];
    const roots = [
      {
        id: null,
        children: [
          {
            id: { kind: "polygon", id: "a0" },
            pluginMetadata: stamp("s1", 0, "tf1"),
          },
          {
            id: { kind: "polygon", id: "a1" },
            pluginMetadata: stamp("s1", 1, "tf1"),
          },
          { id: { kind: "polygon", id: "b0" }, pluginMetadata: stamp("s2", 0) },
          {
            id: { kind: "polygon", id: "c0" },
            pluginMetadata: stamp("s3", 0, "tf2"),
          },
          {
            id: { kind: "polygon", id: "d0" },
            pluginMetadata: stamp("s4", 0, undefined, 1),
          },
          {
            id: { kind: "textFrame", id: "tf1" },
            pluginMetadata: [{ key: BINDING_KEY, value: '{"v":2,"data":{}}' }],
          },
        ],
      },
    ] as never;
    const found = placedShapesIn(roots, "tf1", 0);
    expect([...found.keys()].sort()).toEqual(["s1", "s2"]);
    expect(found.get("s1")!.items.map((i) => i.id)).toEqual(["a0", "a1"]);
    expect(found.get("s1")!.table).toBe("tf1");
    expect(found.get("s2")!.table).toBeUndefined();
  });

  it("asks the workbook to write a first item's live preset [engine ADR 1096]", () => {
    const stamp = { id: "xl/drawings/drawing1.xml#3", item: 0, hash: "h" };
    const preset = JSON.stringify({
      name: "roundRect",
      adjusts: [["adj", "val 40000"]],
      frame: [0, 0, 10, 10],
    });
    expect(shapePresetWrite(stamp, preset)).toEqual({
      id: stamp.id,
      name: "roundRect",
      adjusts: [["adj", "val 40000"]],
    });
    // Reshaped (no live preset), a detail item, garbage: nothing.
    expect(shapePresetWrite(stamp, "")).toBeNull();
    expect(shapePresetWrite({ ...stamp, item: 1 }, preset)).toBeNull();
    expect(shapePresetWrite(stamp, "{")).toBeNull();
  });
});
