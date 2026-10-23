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

// matchTables: the native tables a pour built, found again by signature on
// a canvas whose story changed since — tables moved, deleted, cells edited.

import { describe, expect, it } from "bun:test";

import { matchTables, type LiveTable, type LoweredDoc } from "../src";

const para = (text: string) => ({
  kind: "paragraph" as const,
  runs: [{ text }],
  sourceIndex: 0,
});

/** A lowered table of one row: one cell per text. */
const table = (...texts: string[]) => ({
  kind: "table" as const,
  rows: 1,
  cols: texts.length,
  columnWidthsPt: [],
  cells: texts.map((t, col) => ({
    row: 0,
    col,
    rowSpan: 1,
    colSpan: 1,
    paragraphs: t
      .split("\n")
      .map((p) => ({ runs: [{ text: p }], sourceIndex: 0 })),
  })),
});

const ir = {
  swatches: [],
  styles: [],
  diagnostics: [],
  story: {
    blocks: [
      para("Intro"),
      table("Item", "Price"),
      para("Between"),
      table("Name", "City"),
      para("And"),
      table("Name", "Zip"),
    ],
  },
  section: {
    pageWidthPt: 612,
    pageHeightPt: 792,
    marginTopPt: 72,
    marginBottomPt: 72,
    marginLeftPt: 72,
    marginRightPt: 72,
    columns: 1,
    firstBlock: 0,
  },
} as unknown as LoweredDoc;

/** A live table of one row. */
const live = (id: string, ordinal: number, ...texts: string[]): LiveTable => ({
  id,
  story: 0,
  ordinal,
  rows: 1,
  cols: texts.length,
  cells: Object.fromEntries(texts.map((t, c) => [`0,${c}`, t])),
});

describe("matchTables @feat:plugin-doc.object-model", () => {
  it("pairs the tables where the pour put them", () => {
    const m = matchTables(ir, [
      live("a", 0, "Item", "Price"),
      live("b", 1, "Name", "City"),
      live("c", 2, "Name", "Zip"),
    ]);
    expect([...m]).toEqual([
      [1, "a"],
      [3, "b"],
      [5, "c"],
    ]);
  });

  it("finds tables after one before them was deleted and one was moved", () => {
    // The first table deleted, the last two swapped, a new table of the
    // same shape added after them (not where the first one was).
    const m = matchTables(ir, [
      live("c", 0, "Name", "Zip"),
      live("b", 1, "Name", "City"),
      live("new", 2, "x", "y"),
    ]);
    expect(m.get(1)).toBeUndefined();
    expect(m.get(3)).toBe("b");
    expect(m.get(5)).toBe("c");
  });

  it("pairs a table whose cells were all edited by its place", () => {
    const m = matchTables(ir, [
      live("a", 0, "Item", "Price"),
      live("b", 1, "Nom", "Ville"),
      live("c", 2, "Name", "Zip"),
    ]);
    expect(m.get(3)).toBe("b");
    // Its place empty: nothing else of its shape between its neighbours.
    const gone = matchTables(ir, [
      live("a", 0, "Item", "Price"),
      live("c", 1, "Name", "Zip"),
      live("d", 2, "Other", "Table"),
    ]);
    expect(gone.get(1)).toBe("a");
    expect(gone.get(3)).toBeUndefined();
    expect(gone.get(5)).toBe("c");
  });

  it("never pairs tables of another shape", () => {
    const m = matchTables(ir, [live("a", 0, "Item", "Price", "Extra")]);
    expect(m.size).toBe(0);
  });
});
