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

// Engine ADR 1098 — a table cell's Word direct formatting is set as direct
// properties on the cell's text (a cell-qualified `storyRange`), over the
// Word style the lowering's synthesized `docx-auto-*` style stands on, and a
// synthesized style only a cell named is no longer minted.

import { describe, expect, it } from "bun:test";

import {
  buildStyleMutations,
  buildTableCellCarets,
  buildTableCells,
  catalogue,
  synthesizedStylesInUse,
  type LoweredDoc,
  type LoweredStyle,
  type LoweredTable,
} from "../src/index.ts";

type Op = { op: string; args: Record<string, unknown> };

const styles: LoweredStyle[] = [
  {
    id: "ParagraphStyle/docx-Normal",
    name: "Normal",
    collection: "paragraph",
    props: [],
  },
  {
    id: "CharacterStyle/docx-Strong",
    name: "Strong",
    collection: "character",
    props: [
      { path: "characterFontStyle", value: { type: "text", value: "Bold" } },
    ],
  },
  {
    id: "ParagraphStyle/docx-auto-p1",
    name: "docx direct format 1",
    collection: "paragraph",
    basedOn: "ParagraphStyle/docx-Normal",
    props: [
      {
        path: "paragraphJustification",
        value: { type: "text", value: "CenterAlign" },
      },
      { path: "characterLanguage", value: { type: "text", value: "en" } },
    ],
  },
  {
    id: "CharacterStyle/docx-auto-c1",
    name: "docx direct format 1",
    collection: "character",
    props: [
      { path: "characterFontSize", value: { type: "length", value: 14 } },
      {
        path: "characterFillColor",
        value: { type: "colorRef", value: "Color/docx-C00000" },
      },
    ],
  },
  {
    id: "ParagraphStyle/docx-auto-p2",
    name: "docx direct format 2",
    collection: "paragraph",
    basedOn: "ParagraphStyle/docx-Normal",
    props: [{ path: "characterFontSize", value: { type: "length", value: 9 } }],
  },
  {
    id: "CharacterStyle/docx-auto-c2",
    name: "docx direct format 2",
    collection: "character",
    props: [
      { path: "characterUnderline", value: { type: "bool", value: true } },
    ],
  },
];

const table: LoweredTable = {
  rows: 1,
  cols: 2,
  columnWidthsPt: [100, 100],
  cells: [
    {
      row: 0,
      col: 0,
      rowSpan: 1,
      colSpan: 1,
      paragraphs: [
        {
          paraStyleId: "ParagraphStyle/docx-auto-p1",
          runs: [
            { text: "Tot", charStyleId: "CharacterStyle/docx-auto-c1" },
            { text: "al" },
          ],
          sourceIndex: 0,
        },
      ],
    },
    {
      row: 0,
      col: 1,
      rowSpan: 1,
      colSpan: 1,
      paragraphs: [
        {
          paraStyleId: "ParagraphStyle/docx-auto-p2",
          runs: [],
          sourceIndex: 1,
        },
      ],
    },
  ],
};

const opsOf = (m: unknown) => (m as Op).args.ops as Op[];
const sets = (ops: Op[]) =>
  ops
    .filter((o) => o.op === "setElementProperty")
    .map((o) => {
      const id = (o.args.elementId as { id: Record<string, unknown> }).id;
      return [
        id.start,
        id.end,
        o.args.path,
        (o.args.value as { value: unknown }).value,
      ];
    });

describe("a cell's direct formatting @feat:plugin-doc.read-path", () => {
  it("is the Word style plus direct properties on the cell's ranges", () => {
    const ops = opsOf(buildTableCells(table, "s", "t1", catalogue(styles)));
    const applied = ops
      .filter((o) => o.op === "applyStyle")
      .map((o) => [o.args.start, o.args.end, o.args.style]);
    // No synthesized style is applied to the text cell.
    expect(applied).toEqual([[0, 5, "ParagraphStyle/docx-Normal"]]);
    expect(
      sets(ops).filter(
        (s) =>
          typeof s[2] === "string" &&
          /^(character|paragraph)/.test(s[2] as string),
      ),
    ).toEqual([
      [0, 3, "characterFontSize", 14],
      [0, 3, "characterFillColor", "Color/docx-C00000"],
      [0, 5, "paragraphJustification", "CenterAlign"],
    ]);
    const cell = ops.find((o) => o.op === "setElementProperty")!.args
      .elementId as { id: { cell: unknown } };
    expect(cell.id.cell).toEqual({ tableId: "t1", row: 0, col: 0 });
  });

  it("keeps a synthesized paragraph style whose character properties have no run", () => {
    const carets = buildTableCellCarets(
      table,
      "s",
      "t1",
      catalogue(styles),
    ) as unknown as Op[];
    expect(carets.map((o) => o.args.style)).toEqual([
      "ParagraphStyle/docx-auto-p2",
    ]);
  });

  it("mints only the synthesized styles something still names", () => {
    const doc = {
      styles,
      swatches: [],
      story: {
        blocks: [
          { kind: "table", ...table },
          {
            kind: "paragraph",
            runs: [{ text: "x", charStyleId: "CharacterStyle/docx-auto-c2" }],
            sourceIndex: 2,
          },
        ],
      },
    } as unknown as LoweredDoc;
    expect([...synthesizedStylesInUse(doc as never)].sort()).toEqual([
      "CharacterStyle/docx-auto-c2",
      "ParagraphStyle/docx-auto-p2",
    ]);
    const created = (buildStyleMutations(doc) as unknown as Op[])
      .filter((o) => o.op.startsWith("create"))
      .map((o) => o.args.selfId);
    expect(created).not.toContain("CharacterStyle/docx-auto-c1");
    expect(created).not.toContain("ParagraphStyle/docx-auto-p1");
    expect(created).toContain("ParagraphStyle/docx-auto-p2");
    expect(created).toContain("CharacterStyle/docx-Strong");
  });
});
