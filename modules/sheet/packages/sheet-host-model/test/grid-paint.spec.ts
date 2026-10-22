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
