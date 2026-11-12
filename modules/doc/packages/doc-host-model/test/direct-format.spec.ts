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

// Doc ADR 600, amendment 2026-11-12b — the pour sets Word's direct
// formatting the way `docx-js` tells it (`direct` looks, the native body's
// rule, decided in Rust: `docx_skeleton::direct`): the Word style a
// synthesized `docx-auto-*` style stands on, applied, and its properties set
// on the range (engine ADR 1098), in the body, a blank line (a caret naming
// its paragraph), a table's own paragraph, a cell, and a tracked change's look
// before. Only the synthesized styles a look still applies are minted. The
// rule itself is tested in Rust (`docx-skeleton/tests/direct.rs`).

import { describe, expect, it } from "bun:test";

import {
  buildStoryBlocks,
  buildStyleMutations,
  buildTableCellCarets,
  buildTableCells,
  type LoweredBlock,
  type LoweredDoc,
  type LoweredStyle,
  type LoweredTable,
  type StoryStep,
} from "../src/index.ts";

type Op = { op: string; args: Record<string, unknown> };

const center = {
  path: "paragraphJustification",
  value: { type: "text" as const, value: "CenterAlign" },
};
const size14 = {
  path: "characterFontSize",
  value: { type: "length" as const, value: 14 },
};
const red = {
  path: "characterFillColor",
  value: { type: "colorRef" as const, value: "Color/docx-C00000" },
};
const spaceAfter = {
  path: "paragraphSpaceAfter",
  value: { type: "length" as const, value: 0 },
};

const styles: LoweredStyle[] = [
  {
    id: "ParagraphStyle/docx-Normal",
    name: "Normal",
    collection: "paragraph",
    props: [],
  },
  {
    id: "ParagraphStyle/docx-auto-p1",
    name: "docx direct format 1",
    collection: "paragraph",
    basedOn: "ParagraphStyle/docx-Normal",
    props: [center],
  },
  {
    id: "CharacterStyle/docx-auto-c1",
    name: "docx direct format 1",
    collection: "character",
    props: [size14, red],
  },
  {
    id: "ParagraphStyle/docx-auto-p2",
    name: "docx direct format 2",
    collection: "paragraph",
    basedOn: "ParagraphStyle/docx-Normal",
    props: [{ path: "characterFontSize", value: { type: "length", value: 9 } }],
  },
];

const table: LoweredTable = {
  rows: 1,
  cols: 2,
  columnWidthsPt: [100, 100],
  paraStyleId: "ParagraphStyle/docx-auto-p1",
  direct: { style: "ParagraphStyle/docx-Normal", props: [center] },
  cells: [
    {
      row: 0,
      col: 0,
      rowSpan: 1,
      colSpan: 1,
      paragraphs: [
        {
          paraStyleId: "ParagraphStyle/docx-auto-p1",
          direct: { style: "ParagraphStyle/docx-Normal", props: [center] },
          runs: [
            {
              text: "Tot",
              charStyleId: "CharacterStyle/docx-auto-c1",
              direct: { style: null, props: [size14, red] },
            },
            { text: "al", direct: { style: null } },
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
          // Kept: its character properties have no run to carry them.
          paraStyleId: "ParagraphStyle/docx-auto-p2",
          direct: { style: "ParagraphStyle/docx-auto-p2" },
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
const applied = (ops: Op[]) =>
  ops
    .filter((o) => o.op === "applyStyle")
    .map((o) => [o.args.start, o.args.end, o.args.style]);

function run(steps: StoryStep[]): Op[] {
  const out: Op[] = [];
  let text = 0;
  let style = 0;
  for (const step of steps) {
    if (step.kind === "text") {
      out.push(...(step.mutations(text, style) as unknown as Op[]));
      text += step.byteLength;
      style += step.length;
    } else {
      out.push(step.insert as unknown as Op);
      out.push(...opsOf(step.cells("Table/t1")));
      if (step.style) out.push(...(step.style(style) as unknown as Op[]));
      text += step.textLength;
    }
  }
  return out;
}

describe("the pour sets the looks docx-js decided @feat:plugin-doc.read-path", () => {
  it("a cell: the Word style plus direct properties on the cell's ranges", () => {
    const ops = opsOf(buildTableCells(table, "s", "t1"));
    expect(applied(ops)).toEqual([[0, 5, "ParagraphStyle/docx-Normal"]]);
    expect(
      sets(ops).filter((s) => /^(character|paragraph)/.test(String(s[2]))),
    ).toEqual([
      [0, 3, "characterFontSize", 14],
      [0, 3, "characterFillColor", "Color/docx-C00000"],
      [0, 5, "paragraphJustification", "CenterAlign"],
    ]);
    const cell = ops.find((o) => o.op === "setElementProperty")!.args
      .elementId as { id: { cell: unknown } };
    expect(cell.id.cell).toEqual({ tableId: "t1", row: 0, col: 0 });
  });

  it("a cell's blank line keeps the style docx-js kept", () => {
    const carets = buildTableCellCarets(table, "s", "t1") as unknown as Op[];
    expect(carets.map((o) => o.args.style)).toEqual([
      "ParagraphStyle/docx-auto-p2",
    ]);
  });

  it("the body, a blank line and a table's paragraph: carets name their paragraph", () => {
    const blocks: LoweredBlock[] = [
      {
        kind: "paragraph",
        paraStyleId: "ParagraphStyle/docx-auto-p1",
        direct: { style: "ParagraphStyle/docx-Normal", props: [center] },
        runs: [
          {
            text: "Hi",
            charStyleId: "CharacterStyle/docx-auto-c1",
            direct: { style: null, props: [size14] },
          },
        ],
        sourceIndex: 0,
      },
      {
        kind: "paragraph",
        paraStyleId: "ParagraphStyle/docx-auto-p3",
        direct: { style: "ParagraphStyle/docx-Normal", props: [spaceAfter] },
        runs: [],
        sourceIndex: 1,
      },
      { kind: "table", ...table },
    ];
    const ops = run(buildStoryBlocks(blocks, "s"));
    const body = ops.filter(
      (o) =>
        (o.op === "applyStyle" || o.op === "setElementProperty") &&
        !(
          o.args.cell ||
          (o.args.elementId as { id?: { cell?: unknown } })?.id?.cell
        ),
    );
    const shown = body.map((o) =>
      o.op === "applyStyle"
        ? ["style", o.args.start, o.args.end, o.args.style, o.args.paragraph]
        : [
            "set",
            ...((id) => [id.start, id.end, id.paragraph])(
              (o.args.elementId as { id: Record<string, unknown> }).id,
            ),
            o.args.path,
          ],
    );
    expect(shown).toContainEqual([
      "style",
      0,
      2,
      "ParagraphStyle/docx-Normal",
      undefined,
    ]);
    expect(shown).toContainEqual(["set", 0, 2, undefined, "characterFontSize"]);
    expect(shown).toContainEqual([
      "set",
      0,
      2,
      undefined,
      "paragraphJustification",
    ]);
    // The blank line (paragraph 1) and the table's paragraph (2), named.
    expect(shown).toContainEqual([
      "style",
      2,
      2,
      "ParagraphStyle/docx-Normal",
      1,
    ]);
    expect(shown).toContainEqual(["set", 2, 2, 1, "paragraphSpaceAfter"]);
    expect(shown).toContainEqual([
      "style",
      2,
      2,
      "ParagraphStyle/docx-Normal",
      2,
    ]);
    expect(shown).toContainEqual(["set", 2, 2, 2, "paragraphJustification"]);
    expect(shown.some((s) => String(s[3]).includes("docx-auto"))).toBe(false);
  });

  it("a tracked format change's look before is its style and properties", () => {
    const blocks: LoweredBlock[] = [
      {
        kind: "paragraph",
        runs: [
          {
            text: "Bold",
            charStyleId: "CharacterStyle/docx-auto-c1",
            direct: { style: null, props: [size14, red] },
            formatChange: {
              change: { id: "docx-r1", kind: "format", author: "A" },
              beforeCharStyleId: "CharacterStyle/docx-auto-c9",
            },
            beforeDirect: {
              style: "CharacterStyle/docx-Strong",
              props: [size14],
            },
          },
        ],
        sourceIndex: 0,
      },
    ];
    const ops = run(buildStoryBlocks(blocks, "s"));
    const record = ops.find((o) => o.op === "recordChange")!;
    expect(record.args.change).toEqual({
      kind: "format",
      id: "docx-r1",
      author: "A",
      beforeCharacterStyle: "CharacterStyle/docx-Strong",
      beforeCharacterProperties: [size14],
    });
  });

  it("mints only the synthesized styles docx-js says a look still applies", () => {
    const doc = {
      styles,
      swatches: [],
      story: { blocks: [{ kind: "table", ...table }] },
      mintedStyles: ["ParagraphStyle/docx-auto-p2"],
    } as unknown as LoweredDoc;
    const created = (buildStyleMutations(doc) as unknown as Op[])
      .filter((o) => o.op.startsWith("create"))
      .map((o) => o.args.selfId);
    expect(created).toEqual([
      "ParagraphStyle/docx-Normal",
      "ParagraphStyle/docx-auto-p2",
    ]);
  });
});
