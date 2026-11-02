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

// Doc ADR 623 — a cropped picture in a table cell, inline and anchored
// (`docx-conformance`'s `picture_crop_cell_docx`): the cell's batch sets the
// lowering's placement on the frame `insertAnchoredFrame` made, addressed in
// the cell's own paragraph and characters, as the body's pictures are.

import { describe, expect, it } from "bun:test";

import type { LoweredCrop, LoweredTable } from "../src/lowered.js";
import { buildTableCells } from "../src/mutations.js";

type Op = { op: string; args: Record<string, unknown> };

const flat = (ops: Op[]): Op[] =>
  ops.flatMap((o) =>
    o.op === "batch" ? flat((o.args as { ops: Op[] }).ops) : [o],
  );

const URI = "data:image/png;base64,AAAA";

/** l = r = 25 % of a 200 px picture shown 72 pt wide. */
const middleHalf: LoweredCrop = {
  l: 0.25,
  t: 0,
  r: 0.25,
  b: 0,
  placement: [0.72, 0, 0, 0.72, -36, 0],
};

/** t = 10 %, b = 40 % of a 100 px picture shown 144 x 36 pt. */
const band: LoweredCrop = {
  l: 0,
  t: 0.1,
  r: 0,
  b: 0.4,
  placement: [0.72, 0, 0, 0.72, 0, -7.2],
};

const anchor = {
  position: "Anchored",
  anchorPoint: "TopLeftAnchor",
  horizontalReference: "TextFrame",
  horizontalAlignment: "LeftAlign",
  verticalReference: "LineBaseline",
  verticalAlignment: "TopAlign",
  xOffsetPt: 0,
  yOffsetPt: 14.4,
};

function table(): LoweredTable {
  const cell = (col: number, images: object[]) => ({
    row: 0,
    col,
    rowSpan: 1,
    colSpan: 1,
    paragraphs: [
      {
        paraStyleId: null,
        runs: [{ text: "x", charStyleId: null }],
        images,
        sourceIndex: 0,
      },
    ],
  });
  return {
    kind: "table",
    rows: 1,
    cols: 2,
    columnWidthsPt: [225, 225],
    cells: [
      cell(0, [
        { at: 1, widthPt: 72, heightPt: 72, uri: URI, crop: middleHalf },
      ]),
      cell(1, [
        {
          at: 1,
          widthPt: 144,
          heightPt: 36,
          uri: URI,
          crop: band,
          anchor,
        },
      ]),
    ],
  } as unknown as LoweredTable;
}

describe("[plugin-doc.picture-crop] a cropped picture in a table cell", () => {
  const ops = flat([buildTableCells(table(), "Story/u1", "Table/u1")] as Op[]);
  const place = (handle: string) =>
    ops.filter(
      (o) =>
        o.op === "setElementProperty" &&
        o.args.path === "imageContentTransform" &&
        (o.args.elementId as { id: string }).id === `$h:${handle}`,
    );

  it("an inline picture's frame is bound and placed by the crop, in its cell", () => {
    const insert = ops.filter((o) => o.op === "insertAnchoredFrame");
    expect(insert).toHaveLength(2);
    expect(insert[0]?.args).toMatchObject({
      storyId: "Story/u1",
      paragraph: 0,
      cell: { tableId: "Table/u1", row: 0, col: 0 },
      width: 72,
      height: 72,
    });
    const at = ops.indexOf(insert[0]!);
    const bind = ops[at + 1]!;
    expect(bind.op).toBe("bindCreated");
    const handle = (bind.args as { handle: string }).handle;
    const placed = place(handle);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.args.value).toEqual({
      type: "transform",
      value: [0.72, 0, 0, 0.72, -36, 0],
    });
  });

  it("an anchored picture takes its anchor settings and its crop", () => {
    const insert = ops.filter((o) => o.op === "insertAnchoredFrame")[1]!;
    expect(insert.args).toMatchObject({
      cell: { tableId: "Table/u1", row: 0, col: 1 },
      width: 144,
      height: 36,
    });
    const at = ops.indexOf(insert);
    const handle = (ops[at + 1]!.args as { handle: string }).handle;
    expect(ops[at + 1]!.op).toBe("bindCreated");
    expect(
      ops.some(
        (o) =>
          o.args.path === "anchoredPosition" &&
          (o.args.elementId as { id: string }).id === `$h:${handle}`,
      ),
    ).toBe(true);
    const placed = place(handle);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.args.value).toEqual({
      type: "transform",
      value: [0.72, 0, 0, 0.72, 0, -7.2],
    });
  });

  it("a cell picture shown whole is inserted without a placement", () => {
    const t = table();
    for (const c of t.cells)
      for (const p of c.paragraphs)
        for (const i of p.images ?? []) delete (i as { crop?: unknown }).crop;
    const plain = flat([buildTableCells(t, "Story/u1", "Table/u1")] as Op[]);
    expect(plain.some((o) => o.args.path === "imageContentTransform")).toBe(
      false,
    );
  });
});
