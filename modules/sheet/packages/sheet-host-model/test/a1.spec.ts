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

// A1 addressing, the sheet packages' one implementation: column letters,
// cells and ranges as text, both ways, inside Excel's grid.

import { describe, expect, it } from "bun:test";

import {
  a1OfCell,
  a1OfRange,
  cellOfA1,
  columnIndex,
  columnLetters,
  MAX_COL,
  MAX_ROW,
  rectOfA1,
} from "../src";

describe("A1 addressing", () => {
  it("column letters and indexes are each other's inverse over the grid", () => {
    expect([0, 25, 26, 27, 701, 702, MAX_COL].map(columnLetters)).toEqual([
      "A",
      "Z",
      "AA",
      "AB",
      "ZZ",
      "AAA",
      "XFD",
    ]);
    for (const col of [0, 1, 25, 26, 51, 52, 701, 702, 703, 8508, MAX_COL]) {
      expect(columnIndex(columnLetters(col))).toBe(col);
    }
    expect(columnIndex("aa")).toBe(26);
    expect(columnIndex("XFE")).toBeNull();
    expect(columnIndex("")).toBeNull();
    expect(columnIndex("ABCD")).toBeNull();
    expect(columnIndex("A1")).toBeNull();
  });

  it("a cell reads with or without dollars, in either case, inside the grid", () => {
    expect(cellOfA1("A1")).toEqual({ row: 0, col: 0 });
    expect(cellOfA1(" $c$14 ")).toEqual({ row: 13, col: 2 });
    expect(cellOfA1("XFD1048576")).toEqual({ row: MAX_ROW, col: MAX_COL });
    for (const bad of ["XFE1", "A0", "A1048577", "A1:B2", "A", "1", "S!A1"]) {
      expect(cellOfA1(bad)).toBeNull();
    }
  });

  it("a cell and a range write as A1 text", () => {
    expect(a1OfCell(0, 0)).toBe("A1");
    expect(a1OfCell(13, 2)).toBe("C14");
    expect(a1OfRange(0, 0)).toBe("A1");
    expect(a1OfRange(1, 1, 1, 1)).toBe("B2");
    expect(a1OfRange(9, 26, 10, 27)).toBe("AA10:AB11");
    expect(a1OfRange(0, 0, MAX_ROW, MAX_COL)).toBe("A1:XFD1048576");
  });

  it("a range reads to its corners in order, sheet prefix and dollars aside", () => {
    expect(rectOfA1("B2:D10")).toEqual({
      top: 1,
      left: 1,
      bottom: 9,
      right: 3,
    });
    expect(rectOfA1("$D$10:b2")).toEqual({
      top: 1,
      left: 1,
      bottom: 9,
      right: 3,
    });
    expect(rectOfA1("Sheet1!$C$3")).toEqual({
      top: 2,
      left: 2,
      bottom: 2,
      right: 2,
    });
    expect(rectOfA1("'Q1 Sales'!A1:B2")).toEqual({
      top: 0,
      left: 0,
      bottom: 1,
      right: 1,
    });
    for (const bad of ["nope", "", "A1:B2:C3", "A1:", "A0:B2", "XFE1"]) {
      expect(rectOfA1(bad)).toBeNull();
    }
    // Writing what was read gives the range back.
    const r = rectOfA1("AA10:AB11")!;
    expect(a1OfRange(r.top, r.left, r.bottom, r.right)).toBe("AA10:AB11");
  });
});
