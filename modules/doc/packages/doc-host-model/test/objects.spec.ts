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

// Doc ADR 614 — the W4a mutations: a float as an anchored object with its
// settings (one batch whose handle names the frame), a cell's Word borders
// and shading, and the style of a table's own paragraph (its alignment).

import { describe, expect, it } from "bun:test";

import {
  buildStoryBlocks,
  buildTableCells,
  buildTextPour,
  type LoweredBlock,
  type LoweredParagraph,
  type LoweredTable,
} from "../src/index.js";

type Op = { op: string; args: Record<string, unknown> };

const floating: LoweredParagraph = {
  runs: [{ text: "Text beside a float." }],
  images: [
    {
      at: 0,
      widthPt: 108,
      heightPt: 72,
      uri: "data:image/png;base64,AAAA",
      anchor: {
        position: "Anchored",
        anchorPoint: "TopLeftAnchor",
        horizontalReference: "ColumnEdge",
        horizontalAlignment: "LeftAlign",
        verticalReference: "TopOfLeading",
        verticalAlignment: "TopAlign",
        xOffsetPt: 12,
        yOffsetPt: 0,
      },
    },
    { at: 4, widthPt: 10, heightPt: 10, uri: "data:image/png;base64,BBBB" },
  ],
  sourceIndex: 0,
};

describe("a float placed as an anchored object @feat:plugin-doc.read-path", () => {
  const ops = buildTextPour([floating], "docx_s0", 0, 0, { paraBase: 0 })
    .mutations as unknown as Op[];

  it("inserts the frame and sets its settings through a handle, in one batch", () => {
    const batch = ops.find((o) => o.op === "batch")!;
    const inner = (batch.args.ops as Op[]).map((o) => o.op);
    expect(inner.slice(0, 2)).toEqual(["insertAnchoredFrame", "bindCreated"]);
    const sets = (batch.args.ops as Op[]).filter(
      (o) => o.op === "setElementProperty",
    );
    expect(sets.map((s) => s.args.path)).toEqual([
      "anchoredPosition",
      "anchorPoint",
      "anchoredHorizontalReference",
      "anchoredHorizontalAlignment",
      "anchoredVerticalReference",
      "anchoredVerticalAlignment",
      "anchoredXOffset",
      "anchoredYOffset",
    ]);
    const handle = (batch.args.ops as Op[])[1]!.args.handle as string;
    expect(sets[0]!.args.elementId).toEqual({
      kind: "rectangle",
      id: `$h:${handle}`,
    });
    expect(sets[6]!.args.value).toEqual({ type: "length", value: 12 });
  });

  it("leaves an inline picture a plain insert", () => {
    const plain = ops.filter((o) => o.op === "insertAnchoredFrame");
    expect(plain).toHaveLength(1);
    expect(plain[0]!.args.imageUri).toBe("data:image/png;base64,BBBB");
  });
});

const table: LoweredTable = {
  rows: 1,
  cols: 1,
  columnWidthsPt: [100],
  cells: [
    {
      row: 0,
      col: 0,
      rowSpan: 1,
      colSpan: 1,
      paragraphs: [{ runs: [{ text: "c" }], sourceIndex: 0 }],
      look: {
        top: { weightPt: 1.5, color: "Color/docx-C00000" },
        left: { weightPt: 0, color: "Color/docx-000000" },
        bottom: { weightPt: 0.5, color: "Color/docx-000000" },
        right: { weightPt: 0.5, color: "Color/docx-000000" },
        fill: "Color/docx-FFFF00",
      },
    },
  ],
  paraStyleId: "ParagraphStyle/docx-auto-p9",
};

describe("a table's Word look @feat:plugin-doc.read-path", () => {
  it("strokes each cell edge and fills the cell", () => {
    const ops = (buildTableCells(table, "docx_s0", "t1") as unknown as Op).args
      .ops as Op[];
    const set = (path: string) =>
      ops.find((o) => o.op === "setElementProperty" && o.args.path === path)
        ?.args.value;
    expect(set("cellTopEdgeStrokeWeight")).toEqual({
      type: "length",
      value: 1.5,
    });
    expect(set("cellTopEdgeStrokeColor")).toEqual({
      type: "colorRef",
      value: "Color/docx-C00000",
    });
    expect(set("cellLeftEdgeStrokeWeight")).toEqual({
      type: "length",
      value: 0,
    });
    expect(set("cellFillColor")).toEqual({
      type: "colorRef",
      value: "Color/docx-FFFF00",
    });
  });

  it("styles the table's own paragraph, which aligns it", () => {
    const blocks: LoweredBlock[] = [
      { kind: "paragraph", runs: [{ text: "Before." }], sourceIndex: 0 },
      { kind: "table", ...table },
    ];
    const steps = buildStoryBlocks(blocks, "docx_s0");
    const step = steps.find((s) => s.kind === "table");
    expect(step?.kind).toBe("table");
    if (step?.kind !== "table") return;
    expect(step.style?.(7)).toEqual({
      op: "applyStyle",
      args: {
        storyId: "docx_s0",
        start: 7,
        end: 7,
        style: "ParagraphStyle/docx-auto-p9",
        scope: "paragraph",
        paragraph: 1,
      },
    });
  });
});
