// W2.2 (sheet ADR 518) — the cell visual model on the page table: document
// swatches named instead of minted, document character / paragraph / cell
// styles applied, strike and super/subscript, rich-text runs, rotation cell
// styles and diagonal lines.

import { describe, expect, it } from "bun:test";

import type { Mutation } from "@paged-media/plugin-api";

import {
  cellAlignStyleMints,
  cellCharacterStyleApplies,
  cellCharacterStyleMints,
  cellFillSwatchOps,
  cellRotationOps,
  styleProps,
  tableDecorOps,
  tableDiagonalOps,
  tableRotation,
  type LoweredContent,
  type LoweredStyle,
} from "../src";

type Loose = { op: string; args: Record<string, unknown> };
const loose = (ops: Mutation[]) => ops as unknown as Loose[];

const base: LoweredStyle = {
  key: 1,
  bold: false,
  italic: false,
  borderTop: false,
  borderRight: false,
  borderBottom: false,
  borderLeft: false,
};

const content = (
  style: Partial<LoweredStyle>,
  cell: Partial<LoweredContent["rows"][0]["cells"][0]> = {},
): LoweredContent => ({
  cols: [{ index: 0, widthPt: 60 }],
  rows: [
    {
      index: 0,
      heightPt: 20,
      cells: [{ col: 0, text: "Value", align: "left", styleKey: 1, ...cell }],
    },
  ],
  rules: { h: [], v: [] },
  merges: [],
  styles: [
    { ...base, key: 0 },
    { ...base, ...style },
  ],
});

describe("document references on the page [sheet.format.cell-style]", () => {
  it("names a document fill swatch and mints nothing for it", () => {
    const c = content({ fillRgb: "#E3000F", fillSwatch: "Color/Brand" });
    expect(cellFillSwatchOps(c, new Set())).toEqual([]);
    const fill = loose(tableDecorOps(c, "S", "T").ops).find(
      (o) => o.args.path === "cellFillColor",
    );
    expect(fill?.args.value).toEqual({
      type: "colorRef",
      value: "Color/Brand",
    });
  });

  it("applies a document cell style and character style as they are", () => {
    const c = content({
      bold: true,
      docCellStyle: "CellStyle/Total",
      docCharStyle: "CharacterStyle/Strong",
    });
    const cellStyle = loose(tableDecorOps(c, "S", "T").ops).find(
      (o) => o.args.path === "appliedCellStyle",
    );
    expect(cellStyle?.args.value).toEqual({
      type: "text",
      value: "CellStyle/Total",
    });
    expect(cellCharacterStyleMints(c, new Set())).toEqual([]);
    expect(loose(cellCharacterStyleApplies(c, "S", "T"))[0].args.style).toBe(
      "CharacterStyle/Strong",
    );
  });

  it("bases a minted paragraph style on the document paragraph style", () => {
    const c = content({ docParaStyle: "ParagraphStyle/Body", indentPt: 6.75 });
    const ops = loose(cellAlignStyleMints(c, new Set()));
    expect(ops[0].args.basedOn).toBe("ParagraphStyle/Body");
    // With nothing on top the document style applies as it is: no mint.
    expect(
      cellAlignStyleMints(
        content({ docParaStyle: "ParagraphStyle/Body" }),
        new Set(),
      ),
    ).toEqual([]);
  });

  it("carries strike, super/subscript and a document text swatch", () => {
    const props = styleProps({
      ...base,
      strike: true,
      vertAlign: "superscript",
      textRgb: "#123456",
      textSwatch: "Color/Ink",
    });
    expect(props).toContainEqual({
      path: "characterStrikethru",
      value: { type: "bool", value: true },
    });
    expect(props).toContainEqual({
      path: "characterPosition",
      value: { type: "text", value: "Superscript" },
    });
    expect(props).toContainEqual({
      path: "characterFillColor",
      value: { type: "colorRef", value: "Color/Ink" },
    });
  });
});

describe("rich text, rotation and diagonals [sheet.format.cell-style]", () => {
  it("applies each run's style over its range", () => {
    const c: LoweredContent = {
      ...content({}),
      styles: [
        { ...base, key: 0 },
        { ...base, key: 1 },
        { ...base, key: 2, bold: true },
      ],
    };
    c.rows[0].cells[0] = {
      col: 0,
      text: "Bold x",
      align: "left",
      styleKey: 1,
      runs: [
        { text: "Bold ", styleKey: 2 },
        { text: "x", styleKey: 1 },
      ],
    };
    const ops = loose(cellCharacterStyleApplies(c, "S", "T"));
    expect(ops).toHaveLength(1);
    expect([ops[0].args.start, ops[0].args.end]).toEqual([0, 5]);
    expect(loose(cellCharacterStyleMints(c, new Set()))[0].op).toBe(
      "createCharacterStyle",
    );
  });

  it("maps Excel rotation onto the table's quarter turns", () => {
    expect([10, 45, 90, 135, 180, 255].map(tableRotation)).toEqual([
      0, 90, 90, 270, 270, 0,
    ]);
    const ops = loose(
      cellRotationOps(content({ rotation: 90 }), "S", "T", new Set()),
    );
    expect(ops.map((o) => o.op)).toEqual([
      "createCellStyle",
      "setStyleProperty",
      "setElementProperty",
    ]);
    expect(cellRotationOps(content({ rotation: 90 }), "S", "T", null)).toEqual(
      [],
    );
  });

  it("draws a diagonal as a page line in its colour", () => {
    const c = content({
      borderLines: {
        diagonalUp: { style: "thin", weightPt: 0.75, rgb: "#FF0000" },
      },
    });
    const ops = loose(tableDiagonalOps(c, [80], "P1", [100, 50]));
    expect(ops[0].op).toBe("insertPath");
    const anchors = ops[0].args.anchors as { anchor: [number, number] }[];
    expect(anchors.map((a) => a.anchor)).toEqual([
      [50, 120],
      [130, 100],
    ]);
    expect(ops.some((o) => o.args.path === "frameStrokeWeight")).toBe(true);
    // Its colour is one of the table's own stroke mints.
    expect(cellFillSwatchOps(c, new Set())).toHaveLength(1);
  });
});
