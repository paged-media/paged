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

import type { LoweredContent } from "../src";
import {
  NO_FILL_SWATCH,
  cellAlignApplies,
  cellCharacterStyleApplies,
  offsetTableRows,
  tableInsertOp,
  tableRefreshOps,
  textOffsetLength,
} from "../src";

function content(
  texts: string[][],
  opts: { fillAt?: [number, number]; height?: number } = {},
): LoweredContent {
  return {
    cols: texts[0].map((_, i) => ({ index: i, widthPt: 50 })),
    rows: texts.map((row, r) => ({
      index: r,
      heightPt: opts.height ?? 18,
      cells: row.map((text, c) => ({
        col: c,
        text,
        align: "left" as const,
        styleKey:
          opts.fillAt && opts.fillAt[0] === r && opts.fillAt[1] === c ? 1 : 0,
      })),
    })),
    rules: { h: [], v: [] },
    merges: [],
    styles: [
      {
        key: 0,
        bold: false,
        italic: false,
        borderTop: false,
        borderRight: false,
        borderBottom: false,
        borderLeft: false,
      },
      {
        key: 1,
        bold: false,
        italic: false,
        fillRgb: "#FFFF00",
        borderTop: false,
        borderRight: false,
        borderBottom: false,
        borderLeft: false,
      },
    ],
  };
}

describe("placed-table refresh replaces in place [sheet.lower.page]", () => {
  it("re-pours ONLY the changed cell (no second table)", () => {
    const prev = content([
      ["Item", "Qty"],
      ["Pens", "3"],
    ]);
    const next = content([
      ["Item", "Qty"],
      ["Pens", "4"],
    ]);
    const ops = tableRefreshOps(prev, next, "S", "T", [50, 50], [50, 50]);
    expect(ops.structure).toEqual([]);
    expect(ops.text).toEqual([
      {
        op: "deleteRange",
        args: {
          storyId: "S",
          start: 0,
          end: 1,
          cell: { tableId: "T", row: 1, col: 1 },
        },
      },
      {
        op: "insertText",
        args: {
          storyId: "S",
          offset: 0,
          text: "4",
          cell: { tableId: "T", row: 1, col: 1 },
        },
      },
    ]);
    expect(JSON.stringify(ops)).not.toContain('insertTable"');
  });

  it("reshapes rows at the tail and pours the new rows", () => {
    const prev = content([["a"], ["b"], ["c"]]);
    const fewer = tableRefreshOps(prev, content([["a"]]), "S", "T", [50], [50]);
    expect(fewer.structure.map((m) => m.op)).toEqual([
      "deleteTableRow",
      "deleteTableRow",
    ]);
    expect(fewer.structure.map((m) => (m.args as { at: number }).at)).toEqual([
      2, 1,
    ]);
    expect(fewer.text).toEqual([]);

    const more = tableRefreshOps(content([["a"]]), prev, "S", "T", [50], [50]);
    expect(
      more.structure.filter((m) => m.op === "insertTableRow"),
    ).toHaveLength(2);
    expect(more.text.map((m) => m.op)).toEqual(["insertText", "insertText"]);
  });

  it("resets a fill the new content no longer has; widths/heights only when moved", () => {
    const prev = content([["x"]], { fillAt: [0, 0] });
    const next = content([["x"]], { height: 24 });
    const ops = tableRefreshOps(prev, next, "S", "T", [50], [60]);
    expect(ops.decor).toContainEqual({
      op: "setElementProperty",
      args: {
        elementId: {
          kind: "tableCell",
          id: { story_id: "S", table_id: "T", row: 0, col: 0 },
        },
        path: "cellFillColor",
        value: { type: "colorRef", value: NO_FILL_SWATCH },
      },
    });
    expect(ops.structure.map((m) => m.op).sort()).toEqual([
      "setColumnWidth",
      "setRowHeight",
    ]);
  });

  it("a page split that moved rows is a row insert + delete, not a re-pour of every shifted cell [sheet.lower.paginate]", () => {
    // Frame 2 of a chain: header H, then body rows a,b,c. The frame above
    // got shorter, so row z moved down into this frame and c moved out.
    const prev = content([["H"], ["a"], ["b"], ["c"]]);
    const next = content([["H"], ["z"], ["a"], ["b"]]);
    const ops = tableRefreshOps(prev, next, "S", "T", [50], [50]);
    expect(ops.structure).toEqual([
      { op: "deleteTableRow", args: { storyId: "S", tableId: "T", at: 3 } },
      { op: "insertTableRow", args: { storyId: "S", tableId: "T", at: 1 } },
      {
        op: "setRowHeight",
        args: { storyId: "S", tableId: "T", row: 1, height: 18 },
      },
    ]);
    expect(ops.text).toEqual([
      {
        op: "insertText",
        args: {
          storyId: "S",
          offset: 0,
          text: "z",
          cell: { tableId: "T", row: 1, col: 0 },
        },
      },
    ]);
  });

  it("measures text offsets in UTF-8 bytes (core's story unit)", () => {
    expect(textOffsetLength("Süd")).toBe(4);
  });

  it("a host header band moves every row-addressed op below it, and nothing else [sheet.lower.page]", () => {
    // The workbook's row 0 is the table's row 2 under a two-row band.
    const prev = content(
      [
        ["Item", "Qty"],
        ["Pens", "3"],
      ],
      { fillAt: [1, 1] },
    );
    const next = content(
      [
        ["Item", "Qty"],
        ["Pens", "4"],
        ["Ink", "9"],
      ],
      { fillAt: [0, 0], height: 20 },
    );
    const lanes = tableRefreshOps(prev, next, "S", "T", [50, 50], [50, 60]);
    const styles = [
      ...cellCharacterStyleApplies(next, "S", "T", { includeDefault: true }),
      ...cellAlignApplies(next, "S", "T", { includeDefault: true }),
    ];
    const ops = [...lanes.structure, ...lanes.text, ...lanes.decor, ...styles];
    const moved = offsetTableRows(ops, "T", 2);
    expect(moved).toHaveLength(ops.length);
    const rowOf = (m: (typeof ops)[number]): number | null => {
      const a = m.args as Record<string, unknown>;
      if (m.op === "insertTableRow" || m.op === "deleteTableRow")
        return a.at as number;
      if (m.op === "setRowHeight" || m.op === "setCellSpan")
        return a.row as number;
      const cell = a.cell as { row: number } | undefined;
      if (cell) return cell.row;
      const el = a.elementId as
        { kind: string; id: { row: number } } | undefined;
      return el?.kind === "tableCell" ? el.id.row : null;
    };
    let rowOps = 0;
    ops.forEach((op, i) => {
      const r = rowOf(op);
      if (r === null) {
        expect(moved[i]).toEqual(op);
      } else {
        rowOps += 1;
        expect(rowOf(moved[i])).toBe(r + 2);
        expect({
          ...moved[i],
          args: { ...moved[i].args, at: 0, row: 0, cell: 0, elementId: 0 },
        }).toEqual({
          ...op,
          args: { ...op.args, at: 0, row: 0, cell: 0, elementId: 0 },
        });
      }
    });
    // Every lane that names a row is in the fixture: inserts, heights, text,
    // fills, styles; and the column widths (no row) are left alone.
    expect(
      new Set(ops.filter((op) => rowOf(op) !== null).map((op) => op.op)),
    ).toEqual(
      new Set([
        "insertTableRow",
        "setRowHeight",
        "deleteRange",
        "insertText",
        "setElementProperty",
        "applyStyle",
      ]),
    );
    expect(rowOps).toBeGreaterThan(0);
    expect(moved.filter((op) => op.op === "setColumnWidth")).toEqual(
      ops.filter((op) => op.op === "setColumnWidth"),
    );
    // Another table's ops, and a zero offset, are untouched.
    expect(offsetTableRows(ops, "Other", 2)).toEqual(ops);
    expect(offsetTableRows(ops, "T", 0)).toEqual(ops);
    // A batch is walked.
    expect(offsetTableRows([{ op: "batch", args: { ops } }], "T", 2)).toEqual([
      { op: "batch", args: { ops: moved } },
    ]);
  });
});

/** A frame-page-shaped window: rows/cols carry SHEET indices, a cell's
 *  text names its sheet cell, `header` leading rows are header rows. */
function windowContent(
  rows: number[],
  cols: number[],
  header = 0,
): LoweredContent {
  return {
    cols: cols.map((index) => ({ index, widthPt: 40 + (index % 3) })),
    rows: rows.map((r) => ({
      index: r,
      heightPt: 15,
      cells: cols.map((c) => ({
        col: c,
        text: `${r}:${c}`,
        align: "left" as const,
        styleKey: 0,
      })),
    })),
    rules: { h: [], v: [] },
    merges: [],
    headerRows: header,
  };
}

const range = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => from + i);
const widthsOf = (c: LoweredContent) => c.cols.map((x) => x.widthPt);
const columnOps = (ops: { op: string }[]) =>
  ops.filter(
    (o) => o.op === "insertTableColumn" || o.op === "deleteTableColumn",
  );

describe("frame-page refresh aligns tracks by sheet index [sheet.lower.page]", () => {
  for (const k of [1, 3, 5]) {
    it(`a horizontal scroll by ${k} columns is ${k} deletes + ${k} inserts and re-pours only the new columns`, () => {
      const rows = range(0, 8);
      const prev = windowContent(rows, range(0, 10));
      const next = windowContent(rows, range(k, 10));
      const ops = tableRefreshOps(
        prev,
        next,
        "s",
        "t",
        widthsOf(prev),
        widthsOf(next),
      );
      const cols = columnOps(ops.structure);
      expect(cols.length).toBeLessThanOrEqual(2 * k);
      expect(cols.filter((o) => o.op === "deleteTableColumn")).toHaveLength(k);
      expect(cols.filter((o) => o.op === "insertTableColumn")).toHaveLength(k);
      // Deletes at the start, inserts at the end.
      for (const o of cols) {
        const at = (o as unknown as { args: { at: number } }).args.at;
        if (o.op === "deleteTableColumn") expect(at).toBeLessThan(k);
        else expect(at).toBeGreaterThanOrEqual(10 - k);
      }
      // No row moves, and text only for the k new columns of every row.
      expect(ops.structure.some((o) => o.op.endsWith("TableRow"))).toBe(false);
      expect(ops.rewrittenCells).toBe(rows.length * k);
      expect(ops.text.every((o) => o.op === "insertText")).toBe(true);
      expect(ops.replace).toBe(false);
    });
  }

  it("a frozen column stays while the body scrolls", () => {
    const rows = range(0, 4);
    const prev = windowContent(rows, [0, ...range(5, 6)]);
    const next = windowContent(rows, [0, ...range(7, 6)]);
    const ops = tableRefreshOps(
      prev,
      next,
      "s",
      "t",
      widthsOf(prev),
      widthsOf(next),
    );
    const cols = columnOps(ops.structure);
    expect(cols).toHaveLength(4);
    expect(
      cols
        .filter((o) => o.op === "deleteTableColumn")
        .map((o) => (o as unknown as { args: { at: number } }).args.at),
    ).toEqual([2, 1]);
    expect(ops.rewrittenCells).toBe(rows.length * 2);
  });

  it("a vertical scroll below frozen header rows moves body rows only", () => {
    const cols = range(0, 5);
    const prev = windowContent([0, ...range(10, 8)], cols, 1);
    const next = windowContent([0, ...range(12, 8)], cols, 1);
    const ops = tableRefreshOps(
      prev,
      next,
      "s",
      "t",
      widthsOf(prev),
      widthsOf(next),
    );
    const rowOps = ops.structure.filter((o) => o.op.endsWith("TableRow"));
    expect(rowOps).toHaveLength(4);
    expect(
      rowOps
        .filter((o) => o.op === "deleteTableRow")
        .map((o) => (o as unknown as { args: { at: number } }).args.at),
    ).toEqual([2, 1]);
    expect(columnOps(ops.structure)).toHaveLength(0);
    expect(ops.rewrittenCells).toBe(2 * cols.length);
  });

  it("a header band that grows gains header rows at its top; one that shrinks loses them", () => {
    const cols = range(0, 3);
    const one = windowContent([0, ...range(5, 4)], cols, 1);
    const two = windowContent([0, 1, ...range(5, 4)], cols, 2);
    const grow = tableRefreshOps(
      one,
      two,
      "s",
      "t",
      widthsOf(one),
      widthsOf(two),
    );
    expect(
      grow.structure.filter((o) => o.op === "insertHeaderRow"),
    ).toHaveLength(1);
    expect(grow.structure.some((o) => o.op.endsWith("TableRow"))).toBe(false);
    const shrink = tableRefreshOps(
      two,
      one,
      "s",
      "t",
      widthsOf(two),
      widthsOf(one),
    );
    expect(
      shrink.structure.filter((o) => o.op === "removeHeaderRow"),
    ).toHaveLength(1);
    expect(shrink.structure.some((o) => o.op.endsWith("TableRow"))).toBe(false);
    // The body rows are kept; only the header band's cells re-pour.
    expect(shrink.rewrittenCells).toBeLessThanOrEqual(2 * cols.length);
  });

  it("asks to replace the table when most cells would be re-poured", () => {
    const rows = range(0, 6);
    const prev = windowContent(rows, range(0, 10));
    const far = windowContent(rows, range(30, 10));
    const ops = tableRefreshOps(
      prev,
      far,
      "s",
      "t",
      widthsOf(prev),
      widthsOf(far),
    );
    expect(ops.rewrittenCells).toBe(60);
    expect(ops.replace).toBe(true);
    const near = windowContent(rows, range(2, 10));
    expect(
      tableRefreshOps(prev, near, "s", "t", widthsOf(prev), widthsOf(near))
        .replace,
    ).toBe(false);
  });

  it("a frame page's header rows become the table's header rows", () => {
    const page = windowContent([0, 1, ...range(9, 3)], range(0, 2), 2);
    const op = tableInsertOp(page, "s", widthsOf(page));
    expect(op.op === "insertTable" && op.args.headerRows).toBe(2);
  });
});
