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

// Extensions ADR 347 — the lowering kit's table scaffold: the one spelling
// of the native-table ops sheet, doc and data lower through.

import { describe, expect, it } from "bun:test";

import {
  nativeCellPropertyOp,
  nativeCellSpanOp,
  nativeCellTextOp,
  nativeRowHeightOp,
  nativeTabTextFrameOps,
  nativeTableCellId,
  nativeTableInsertOp,
} from "../src/index.js";

describe("nativeTableInsertOp", () => {
  it("writes only the fields the module states, in one order", () => {
    const bare = nativeTableInsertOp("Story/u1", { rows: 2, cols: 3 });
    expect(JSON.stringify(bare)).toBe(
      '{"op":"insertTable","args":{"storyId":"Story/u1","rows":2,"cols":3}}',
    );
    const full = nativeTableInsertOp("Story/u1", {
      rows: 1,
      cols: 1,
      headerRows: 0,
      footerRows: 0,
      columnWidths: [40],
      rowHeights: [12],
      word: { indent: 2, autofit: true },
      cell: { tableId: "T1", row: 0, col: 0 },
      paragraph: 1,
    });
    expect(Object.keys(full.args)).toEqual([
      "storyId",
      "rows",
      "cols",
      "headerRows",
      "footerRows",
      "columnWidths",
      "rowHeights",
      "word",
      "cell",
      "paragraph",
    ]);
  });
});

describe("cell ops", () => {
  it("address the cell by story, table, row and column", () => {
    expect(nativeTableCellId("S", "T", 1, 2)).toEqual({
      kind: "tableCell",
      id: { story_id: "S", table_id: "T", row: 1, col: 2 },
    });
    expect(nativeCellTextOp("S", "T", 1, 2, "x")).toEqual({
      op: "insertText",
      args: {
        storyId: "S",
        offset: 0,
        text: "x",
        cell: { tableId: "T", row: 1, col: 2 },
      },
    });
    expect(
      nativeCellPropertyOp("S", "T", 1, 2, "cellFillColor", {
        type: "colorRef",
        value: "Color/x",
      }),
    ).toEqual({
      op: "setElementProperty",
      args: {
        elementId: nativeTableCellId("S", "T", 1, 2),
        path: "cellFillColor",
        value: { type: "colorRef", value: "Color/x" },
      },
    });
    expect(nativeCellSpanOp("S", "T", 0, 1, 2, 3)).toEqual({
      op: "setCellSpan",
      args: {
        storyId: "S",
        tableId: "T",
        row: 0,
        col: 1,
        rowSpan: 2,
        columnSpan: 3,
      },
    });
    expect(nativeRowHeightOp("S", "T", 4, null, false)).toEqual({
      op: "setRowHeight",
      args: {
        storyId: "S",
        tableId: "T",
        row: 4,
        height: null,
        autoGrow: false,
      },
    });
  });
});

describe("nativeTabTextFrameOps", () => {
  it("frames, draws the grid, keeps the decor, then names the frame", () => {
    const decor = { op: "insertPath", args: {} } as never;
    const ops = nativeTabTextFrameOps({
      pageId: "p1",
      bounds: [10, 20, 30, 40],
      lines: [{ start: [20, 10], end: [40, 10] }],
      decor: [decor],
      metadata: { key: "k", value: "v" },
    });
    expect(ops.map((o) => o.op)).toEqual([
      "insertTextFrame",
      "insertLine",
      "insertPath",
      "setPluginMetadata",
    ]);
    expect(ops[1]).toEqual({
      op: "insertLine",
      args: { pageId: "p1", start: [20, 10], end: [40, 10] },
    });
    expect(ops[3]).toEqual({
      op: "setPluginMetadata",
      args: {
        elementId: { kind: "textFrame", id: "$created" },
        key: "k",
        value: "v",
      },
    });
  });
});
