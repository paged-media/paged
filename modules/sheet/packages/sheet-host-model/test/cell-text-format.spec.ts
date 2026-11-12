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

// Engine ADR 1098 — a native table cell's text formatting is direct
// properties on the cell-qualified story range; nothing is minted.

import { describe, expect, it } from "bun:test";

import type { Mutation } from "@paged-media/plugin-api";

import type { LoweredContent } from "../src";
import {
  CHARACTER_FACET_CLEARS,
  NO_CHARACTER_STYLE,
  NO_PARAGRAPH_STYLE,
  PARAGRAPH_FACET_CLEARS,
  cellCharacterFormatOps,
  cellParagraphFormatOps,
  cellsNeedingRealign,
  cellsNeedingRestyle,
} from "../src";

type Loose = { op: string; args: Record<string, unknown> };
const loose = (ops: Mutation[]) => ops as unknown as Loose[];
/** `[op, path or style, value, range, cell]` per op. */
const rows = (ops: Mutation[]) =>
  loose(ops).map((o) => {
    if (o.op === "applyStyle")
      return [o.op, o.args.style, o.args.scope, [o.args.start, o.args.end]];
    const id = (o.args.elementId as { id: Record<string, unknown> }).id;
    return [o.op, o.args.path, o.args.value, [id.start, id.end], id.cell];
  });

const base = {
  italic: false,
  borderTop: false,
  borderRight: false,
  borderBottom: false,
  borderLeft: false,
};
function content(boldHeader: boolean, body = "3"): LoweredContent {
  return {
    cols: [{ index: 0, widthPt: 50 }],
    rows: [
      {
        index: 0,
        heightPt: 18,
        cells: [{ col: 0, text: "Qty", align: "left", styleKey: 1 }],
      },
      {
        index: 1,
        heightPt: 18,
        cells: [{ col: 0, text: body, align: "right", styleKey: 0 }],
      },
    ],
    rules: { h: [], v: [] },
    merges: [],
    styles: [
      { key: 0, bold: false, ...base },
      { key: 1, bold: boldHeader, fontSizePt: boldHeader ? 14 : null, ...base },
    ],
  };
}

describe("native-table cell text formatting [sheet.lower.page]", () => {
  it("writes each facet on the cell's text, cell-qualified, and mints no style", () => {
    const ops = cellCharacterFormatOps(content(true), "S", "T");
    expect(rows(ops)).toEqual([
      [
        "setElementProperty",
        "characterFontStyle",
        { type: "text", value: "Bold" },
        [0, 3],
        { tableId: "T", row: 0, col: 0 },
      ],
      [
        "setElementProperty",
        "characterFontSize",
        { type: "length", value: 14 },
        [0, 3],
        { tableId: "T", row: 0, col: 0 },
      ],
    ]);
    expect(
      loose(ops).every((o) =>
        JSON.stringify(o).includes('"kind":"storyRange"'),
      ),
    ).toBe(true);
  });

  it("a document character style is applied as it is", () => {
    const c = content(true);
    c.styles![1] = { ...c.styles![1]!, docCharStyle: "CharacterStyle/Emph" };
    expect(rows(cellCharacterFormatOps(c, "S", "T"))).toEqual([
      ["applyStyle", "CharacterStyle/Emph", "character", [0, 3]],
    ]);
  });

  it("ranges count characters, as the engine does", () => {
    const c = content(true);
    c.rows[0]!.cells[0]!.text = "Größe";
    const [first] = rows(cellCharacterFormatOps(c, "S", "T"));
    expect(first![3]).toEqual([0, 5]);
  });

  it("a refresh resets every facet of the cells whose format changed, not plain re-pours", () => {
    // Header lost its bold; the plain body cell's text changed.
    const changed = cellsNeedingRestyle(content(true), content(false, "4"));
    expect([...changed]).toEqual(["0:0"]);
    const ops = rows(
      cellCharacterFormatOps(content(false, "4"), "S", "T", {
        cells: changed,
        reset: true,
      }),
    );
    expect(ops[0]).toEqual([
      "applyStyle",
      NO_CHARACTER_STYLE,
      "character",
      [0, 3],
    ]);
    expect(ops.slice(1).map((o) => [o[1], o[2]])).toEqual(
      Object.entries(CHARACTER_FACET_CLEARS),
    );
    // A plain table re-poured needs no restyle at all.
    expect(
      cellsNeedingRestyle(content(false, "3"), content(false, "4")).size,
    ).toBe(0);
  });
});

const aligned = (
  cells: [string, "general" | "left" | "center" | "right"][],
): LoweredContent => ({
  cols: cells.map((_, i) => ({ index: i, widthPt: 40 })),
  rows: [
    {
      index: 0,
      heightPt: 15,
      cells: cells.map(([text, align], col) => ({ col, text, align })),
    },
  ],
  rules: { h: [], v: [] },
  merges: [],
});

describe("cell alignment → paragraph justification [sheet.lower.page]", () => {
  it("left and general cells need nothing", () => {
    const c = aligned([
      ["a", "left"],
      ["b", "general"],
    ]);
    expect(cellParagraphFormatOps(c, "S", "t")).toEqual([]);
  });

  it("an aligned cell's paragraph takes its justification directly", () => {
    const c = aligned([
      ["1", "right"],
      ["x", "left"],
      ["yes", "center"],
    ]);
    expect(rows(cellParagraphFormatOps(c, "S", "t"))).toEqual([
      [
        "setElementProperty",
        "paragraphJustification",
        { type: "text", value: "RightAlign" },
        [0, 1],
        { tableId: "t", row: 0, col: 0 },
      ],
      [
        "setElementProperty",
        "paragraphJustification",
        { type: "text", value: "CenterAlign" },
        [0, 3],
        { tableId: "t", row: 0, col: 2 },
      ],
    ]);
  });

  it("a refresh re-aligns the changed cells, resetting the paragraph", () => {
    const prev = aligned([
      ["x", "left"],
      ["1", "right"],
      ["2", "right"],
    ]);
    const next = aligned([
      ["7", "right"],
      ["y", "left"],
      ["2", "right"],
    ]);
    const cells = cellsNeedingRealign(prev, next);
    expect([...cells].sort()).toEqual(["0:0", "0:1"]);
    const ops = rows(
      cellParagraphFormatOps(next, "S", "t", { cells, reset: true }),
    );
    // Cell (0,1) lost its alignment: no style, every facet cleared.
    const raw = loose(
      cellParagraphFormatOps(next, "S", "t", { cells, reset: true }),
    );
    const ofCell = (col: number) =>
      raw.filter((o) =>
        o.op === "applyStyle"
          ? (o.args.cell as { col: number }).col === col
          : (o.args.elementId as { id: { cell: { col: number } } }).id.cell
              .col === col,
      );
    const lost = ofCell(1);
    expect(lost[0]!.args.style).toBe(NO_PARAGRAPH_STYLE);
    expect(lost.slice(1).map((o) => [o.args.path, o.args.value])).toEqual(
      Object.entries(PARAGRAPH_FACET_CLEARS),
    );
    expect(ops.length).toBe(raw.length);
  });
});

describe("repeat fills → a right tab stop with a leader [sheet.format.engine]", () => {
  it("sets the tab at the cell's inner width on the cell's paragraph", () => {
    const c: LoweredContent = {
      cols: [{ index: 0, widthPt: 60 }],
      rows: [
        {
          index: 0,
          heightPt: 15,
          cells: [{ col: 0, text: "Total\t", align: "right", fill: "." }],
        },
      ],
      rules: { h: [], v: [] },
      merges: [],
    };
    // A number with a fill ignores its right alignment (the fill decides).
    expect(rows(cellParagraphFormatOps(c, "S", "t"))).toEqual([
      [
        "setElementProperty",
        "paragraphTabStops",
        {
          type: "tabStops",
          value: [{ position: 59, alignment: "RightAlign", leader: "." }],
        },
        [0, 6],
        { tableId: "t", row: 0, col: 0 },
      ],
    ]);
  });
});
