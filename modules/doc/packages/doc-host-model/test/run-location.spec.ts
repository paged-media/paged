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

// bodyRunLocation: which native paragraph a lowered body run landed in, per
// section story, and the text around it — the pour's own count, read back.

import { describe, expect, it } from "bun:test";

import {
  bodyRunLocation,
  cellRunLocation,
  nativePlaces,
  tableLocation,
  type LoweredBlock,
  type LoweredDoc,
} from "../src";

const para = (...texts: string[]) => ({
  kind: "paragraph" as const,
  runs: texts.map((text) => ({ text })),
  sourceIndex: 0,
});

const section = (firstBlock: number, story?: number) => ({
  pageWidthPt: 612,
  pageHeightPt: 792,
  marginTopPt: 72,
  marginBottomPt: 72,
  marginLeftPt: 72,
  marginRightPt: 72,
  columns: 1,
  firstBlock,
  ...(story !== undefined ? { story } : {}),
});

describe("bodyRunLocation @feat:plugin-doc.object-model", () => {
  const ir = {
    swatches: [],
    styles: [],
    diagnostics: [],
    story: {
      blocks: [
        para("Dear ", "«Name»", ","),
        {
          kind: "paragraph",
          runs: [{ text: "split" }, { text: "here" }],
          sourceIndex: 1,
          segments: [{ at: 5 }],
        },
        { kind: "table", rows: 1, cols: 1, columnWidthsPt: [], cells: [] },
        para("Grüße ", "x"),
        para("second section"),
      ],
    },
    section: section(0),
    sections: [section(0, 0), section(4, 1)],
  } as unknown as LoweredDoc;

  it("counts native paragraphs: segments take one, a table its host", () => {
    expect(bodyRunLocation(ir, 0, 1)).toEqual({
      story: 0,
      paragraph: 0,
      paragraphText: "Dear «Name»,",
      prefix: "Dear ",
      text: "«Name»",
    });
    // block 0 (0), block 1 split once (1, 2), the table in a new paragraph
    // (3), and the text after it continues in the table's host (3).
    expect(bodyRunLocation(ir, 3, 1)).toMatchObject({
      story: 0,
      paragraph: 3,
      prefix: "Grüße ",
      text: "x",
    });
  });

  it("restarts in each section's own story", () => {
    expect(bodyRunLocation(ir, 4, 0)).toMatchObject({
      story: 1,
      paragraph: 0,
      text: "second section",
    });
  });

  it("answers null for a table, a split paragraph, a missing block or run", () => {
    expect(bodyRunLocation(ir, 2, 0)).toBeNull();
    expect(bodyRunLocation(ir, 1, 0)).toBeNull();
    expect(bodyRunLocation(ir, 9, 0)).toBeNull();
    expect(bodyRunLocation(ir, 0, 3)).toBeNull();
  });
});

describe("nativePlaces, tableLocation, cellRunLocation @feat:plugin-doc.object-model", () => {
  const table = (cells: string[][][]) => ({
    kind: "table" as const,
    rows: 1,
    cols: cells.length,
    columnWidthsPt: [],
    cells: cells.map((paragraphs, col) => ({
      row: 0,
      col,
      rowSpan: 1,
      colSpan: 1,
      paragraphs: paragraphs.map((runs) => ({
        runs: runs.map((text) => ({ text })),
        sourceIndex: 0,
      })),
    })),
  });
  const flow = { ...table([]), flow: [para("tall")] };

  it("a table takes the story's last paragraph when it is empty", () => {
    const places = nativePlaces([
      table([]),
      para("after"),
      para(""),
      table([]),
      para("a", "b"),
      table([]),
      table([]),
      flow,
      para("end"),
    ] as unknown as LoweredBlock[]);
    expect(places).toEqual([
      { paragraph: 0, table: 0 }, // the fresh story's empty paragraph
      { paragraph: 0 }, // continues in the host
      { paragraph: 1 }, // empty: the next table takes it
      { paragraph: 1, table: 1 },
      { paragraph: 1 },
      { paragraph: 2, table: 2 },
      { paragraph: 3, table: 3 }, // a host is never empty
      null, // poured as text, joining the host
      { paragraph: 4 },
    ]);
  });

  const ir = {
    swatches: [],
    styles: [],
    diagnostics: [],
    story: {
      blocks: [
        para("Price list"),
        table([[["Item"]], [["Line ", "one"], ["Grüße"]]]),
        para("Dear ", "«Name»"),
      ],
    },
    section: section(0),
  } as unknown as LoweredDoc;

  it("locates a table and a run of one of its cells", () => {
    expect(tableLocation(ir, 1)).toEqual({ story: 0, table: 0, tables: 1 });
    expect(tableLocation(ir, 0)).toBeNull();
    expect(cellRunLocation(ir, 1, 1, 1, 0)).toEqual({
      story: 0,
      table: 0,
      tables: 1,
      row: 0,
      col: 1,
      cellText: "Line one\nGrüße",
      prefix: "Line one\n",
      text: "Grüße",
    });
    expect(cellRunLocation(ir, 1, 1, 0, 1)).toMatchObject({
      prefix: "Line ",
      text: "one",
    });
    expect(cellRunLocation(ir, 1, 2, 0, 0)).toBeNull();
    expect(cellRunLocation(ir, 1, 0, 0, 1)).toBeNull();
    expect(cellRunLocation(ir, 0, 0, 0, 0)).toBeNull();
    // The paragraph after the table continues in its host paragraph.
    expect(bodyRunLocation(ir, 2, 1)).toMatchObject({ paragraph: 1 });
  });
});
