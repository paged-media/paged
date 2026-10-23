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

// sheet ADR 510 — the frame surface's painter: an opaque background, Excel
// headings inside the frame (letters, numbers, the active tracks
// highlighted), cell text aligned in its cell, the selection, and nothing
// in the heading strips when headings are off.

import { describe, expect, it } from "bun:test";

import {
  columnLetters,
  paintGridScene,
  rowHeadingWidthPt,
  type GridScene,
  type PaintContext,
} from "../src";

interface Call {
  op: string;
  args: unknown[];
  fillStyle?: unknown;
  textAlign?: string;
}

function recorder(): { ctx: PaintContext; calls: Call[] } {
  const calls: Call[] = [];
  const state = {
    fillStyle: "" as PaintContext["fillStyle"],
    strokeStyle: "" as PaintContext["strokeStyle"],
    lineWidth: 1,
    font: "",
    textAlign: "left" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
  };
  const rec =
    (op: string) =>
    (...args: unknown[]) =>
      calls.push({
        op,
        args,
        fillStyle: state.fillStyle,
        textAlign: state.textAlign,
      });
  const ctx = Object.assign(state, {
    save: rec("save"),
    restore: rec("restore"),
    translate: rec("translate"),
    beginPath: rec("beginPath"),
    rect: rec("rect"),
    clip: rec("clip"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    stroke: rec("stroke"),
    fillRect: rec("fillRect"),
    strokeRect: rec("strokeRect"),
    fillText: rec("fillText"),
  }) as unknown as PaintContext;
  return { ctx, calls };
}

const scene: GridScene = {
  viewport: {
    firstRow: 9,
    firstCol: 2,
    rows: 2,
    cols: 2,
    xOffsets: [0, 40, 80],
    yOffsets: [0, 15, 30],
  },
  cells: [
    { row: 9, col: 2, text: "Lamp", align: "left", styleKey: 0 },
    { row: 10, col: 3, text: "49.00", align: "right", styleKey: 0 },
  ],
  styles: [],
  gridlines: {
    h: [{ at: 15, from: 0, to: 80 }],
    v: [{ at: 40, from: 0, to: 30 }],
  },
  selection: { anchorRow: 10, anchorCol: 3, rows: 1, cols: 1 },
};

describe("sheet_grid_paint: frame surface painter", () => {
  it("draws headings for the window's columns and rows, highlighting the active ones", () => {
    const { ctx, calls } = recorder();
    paintGridScene(ctx, scene, {
      headings: true,
      rowHeadingWidthPt: 30,
      widthPt: 200,
      heightPt: 100,
    });
    const texts = calls
      .filter((c) => c.op === "fillText")
      .map((c) => c.args[0]);
    expect(texts).toEqual(
      expect.arrayContaining(["C", "D", "10", "11", "Lamp", "49.00"]),
    );
    const d = calls.find((c) => c.op === "fillText" && c.args[0] === "D");
    const c = calls.find((c) => c.op === "fillText" && c.args[0] === "C");
    expect(d?.fillStyle).not.toBe(c?.fillStyle); // D is the selected column
  });

  it("is opaque, aligns numbers right, and offsets the cells by the headings", () => {
    const { ctx, calls } = recorder();
    paintGridScene(ctx, scene, {
      headings: true,
      rowHeadingWidthPt: 30,
      widthPt: 200,
      heightPt: 100,
    });
    expect(calls[0]).toMatchObject({ op: "fillRect", args: [0, 0, 200, 100] });
    expect(calls.find((c) => c.op === "translate")?.args).toEqual([30, 16]);
    const num = calls.find((c) => c.op === "fillText" && c.args[0] === "49.00");
    expect(num?.textAlign).toBe("right");
    expect(num?.args[1]).toBe(80 - 3);
    expect(calls.some((c) => c.op === "strokeRect")).toBe(true); // the selection
  });

  it("without headings, the cells start at the frame's corner and no labels are drawn", () => {
    const { ctx, calls } = recorder();
    paintGridScene(ctx, scene, {
      headings: false,
      rowHeadingWidthPt: 30,
      widthPt: 200,
      heightPt: 100,
    });
    expect(calls.find((c) => c.op === "translate")?.args).toEqual([0, 0]);
    const texts = calls
      .filter((c) => c.op === "fillText")
      .map((c) => c.args[0]);
    expect(texts).toEqual(["Lamp", "49.00"]);
  });

  it("column letters and the row-heading width", () => {
    expect([0, 25, 26, 701, 16383].map(columnLetters)).toEqual([
      "A",
      "Z",
      "AA",
      "ZZ",
      "XFD",
    ]);
    expect(rowHeadingWidthPt(0)).toBe(26);
    expect(rowHeadingWidthPt(1_000_000)).toBeGreaterThan(rowHeadingWidthPt(0));
  });
});

describe("sheet_grid_paint: number-format fills [sheet.format.engine]", () => {
  it("draws a repeat fill: head left, tail right, the character repeated between", () => {
    const { ctx, calls } = recorder();
    (ctx as { measureText?: (t: string) => { width: number } }).measureText = (
      t: string,
    ) => ({ width: t.length * 2 });
    const filled: GridScene = {
      ...scene,
      cells: [
        {
          row: 9,
          col: 2,
          text: "Total\t",
          fill: ".",
          align: "left",
          styleKey: 0,
        },
        {
          row: 10,
          col: 3,
          text: "$\t1,234",
          fill: " ",
          align: "right",
          styleKey: 0,
        },
      ],
      selection: null,
    };
    paintGridScene(ctx, filled, {
      headings: false,
      rowHeadingWidthPt: 0,
      widthPt: 200,
      heightPt: 100,
    });
    const texts = calls.filter((c) => c.op === "fillText");
    const head = texts.find((c) => c.args[0] === "Total");
    expect(head?.textAlign).toBe("left");
    // 40 pt cell, pad 3 → 34 pt free; "Total" is 10 → 24 pt of "." (2 each).
    const dots = texts.find((c) => String(c.args[0]).startsWith("."));
    expect(dots?.args[0]).toBe(".".repeat(12));
    const tail = texts.find((c) => c.args[0] === "1,234");
    expect(tail?.textAlign).toBe("right");
    expect(tail?.args[1]).toBe(80 - 3);
    expect(texts.find((c) => c.args[0] === "$")?.args[1]).toBe(40 + 3);
    // A space fill draws no fill glyphs.
    expect(
      texts.some((c) => String(c.args[0]).trim() === "" && c.args[0] !== ""),
    ).toBe(false);
  });
});

describe("sheet_grid_paint: the cell visual model [sheet.format.cell-style]", () => {
  const style = (over: Record<string, unknown>) => ({
    key: 1,
    bold: false,
    italic: false,
    borderTop: false,
    borderRight: false,
    borderBottom: false,
    borderLeft: false,
    ...over,
  });
  const one = (
    st: Record<string, unknown>,
    cell: Record<string, unknown> = {},
  ): GridScene => ({
    ...scene,
    cells: [
      { row: 9, col: 2, text: "Ab", align: "left", styleKey: 1, ...cell },
    ],
    styles: [style({ key: 0 }), style(st)] as GridScene["styles"],
    selection: null,
  });
  const opts = {
    headings: false,
    rowHeadingWidthPt: 0,
    widthPt: 200,
    heightPt: 100,
  };

  it("paints a pattern's background then its marks, and draws diagonals", () => {
    const { ctx, calls } = recorder();
    (ctx as { setLineDash?: unknown }).setLineDash = () => {};
    paintGridScene(
      ctx,
      one({
        fillRgb: "#808080",
        fillPattern: {
          pattern: "darkHorizontal",
          fgRgb: "#FF0000",
          bgRgb: "#FFFF00",
        },
        borderLines: {
          diagonalDown: { style: "thin", weightPt: 0.75, rgb: "#0000FF" },
        },
      }),
      opts,
    );
    const bg = calls.find(
      (c) => c.op === "fillRect" && c.fillStyle === "#FFFF00",
    );
    expect(bg?.args).toEqual([0, 0, 40, 15]);
    // The blend is not painted where the pattern can be drawn.
    expect(
      calls.some((c) => c.op === "fillRect" && c.fillStyle === "#808080"),
    ).toBe(false);
    const moves = calls.filter((c) => c.op === "moveTo").map((c) => c.args);
    expect(moves).toContainEqual([0, 0]); // the diagonal from the top-left
  });

  it("rotates text when the context can, and lays rich runs end to end", () => {
    const { ctx } = recorder();
    const angles: number[] = [];
    Object.assign(ctx, {
      rotate: (a: number) => angles.push(a),
      measureText: (t: string) => ({ width: t.length * 5 }),
    });
    paintGridScene(ctx, one({ rotation: 90 }), opts);
    expect(angles).toEqual([-Math.PI / 2]);

    const r = recorder();
    Object.assign(r.ctx, {
      measureText: (t: string) => ({ width: t.length * 5 }),
    });
    const sc = one(
      {},
      {
        runs: [
          { text: "A", styleKey: 2 },
          { text: "b", styleKey: 1 },
        ],
      },
    );
    sc.styles.push(
      style({
        key: 2,
        bold: true,
        textRgb: "#C00000",
      }) as GridScene["styles"][0],
    );
    paintGridScene(r.ctx, sc, opts);
    const texts = r.calls.filter((c) => c.op === "fillText");
    expect(texts.map((c) => c.args[0])).toEqual(["A", "b"]);
    expect(texts[0].fillStyle).toBe("#C00000");
    expect(texts[1].args[1]).toBe((texts[0].args[1] as number) + 5);
  });
});
