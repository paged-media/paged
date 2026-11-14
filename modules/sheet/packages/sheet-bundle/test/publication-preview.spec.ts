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

// Sheet ADR 532 — how a selection lands in its frame: the counts the bar
// warns with and the window a fitted range prints.

import { describe, expect, it } from "bun:test";

import { HEADING_INDEX, type LoweredContent } from "../../sheet-host-model/src";
import { blockOf, fittedWindow, previewOf } from "../src/publication-preview";

const frame = { top: 0, left: 0, bottom: 9, right: 3 };

describe("publication preview", () => {
  it("a selection inside the window fits", () => {
    const p = previewOf([frame], { top: 1, left: 1, bottom: 3, right: 2 });
    expect(p).toMatchObject({
      printedRows: 3,
      printedCols: 2,
      overflowRows: 0,
      overflowCols: 0,
      fits: true,
    });
  });

  it("counts rows below and columns right of the window as overflow", () => {
    const p = previewOf([frame], { top: 8, left: 2, bottom: 12, right: 5 });
    expect(p).toMatchObject({
      printedRows: 2,
      printedCols: 2,
      overflowRows: 3,
      overflowCols: 2,
      beforeRows: 0,
      beforeCols: 0,
      fits: false,
    });
  });

  it("counts rows above and columns left of a scrolled window apart from overflow", () => {
    const scrolled = { top: 20, left: 3, bottom: 39, right: 8 };
    const p = previewOf([scrolled], { top: 18, left: 1, bottom: 21, right: 4 });
    expect(p).toMatchObject({
      printedRows: 2,
      printedCols: 2,
      beforeRows: 2,
      beforeCols: 2,
      overflowRows: 0,
      overflowCols: 0,
      fits: false,
    });
  });

  it("a chain prints its frames' rows in turn; a row between two frames prints nowhere", () => {
    const chain = [
      { top: 0, left: 0, bottom: 9, right: 3 },
      { top: 11, left: 0, bottom: 20, right: 3 },
    ];
    expect(
      previewOf(chain, { top: 5, left: 0, bottom: 15, right: 0 }),
    ).toMatchObject({ printedRows: 10, overflowRows: 1 });
    expect(
      previewOf(chain, { top: 18, left: 0, bottom: 25, right: 0 }),
    ).toMatchObject({ printedRows: 3, overflowRows: 5 });
  });

  it("blockOf reads a grid selection's current area", () => {
    expect(blockOf({ anchorRow: 2, anchorCol: 1, rows: 3, cols: 2 })).toEqual({
      top: 2,
      left: 1,
      bottom: 4,
      right: 2,
    });
  });

  it("a fitted range prints the whole tracks that fit its box, after a printed heading", () => {
    const content = {
      cols: [
        { index: HEADING_INDEX, widthPt: 20 },
        { index: 1, widthPt: 50 },
        { index: 2, widthPt: 50 },
        { index: 3, widthPt: 50 },
      ],
      rows: [
        { index: HEADING_INDEX, heightPt: 15, cells: [] },
        { index: 4, heightPt: 15, cells: [] },
        { index: 5, heightPt: 15, cells: [] },
        { index: 6, heightPt: 30, cells: [] },
      ],
      rules: { h: [], v: [] },
      merges: [],
    } as unknown as LoweredContent;
    // 120 × 50 pt: columns B and C (20 + 50 + 50), rows 5 and 6 (15 + 15 + 15).
    expect(fittedWindow(content, { widthPt: 120, heightPt: 50 })).toEqual({
      top: 4,
      left: 1,
      bottom: 5,
      right: 2,
    });
    // No box read yet: all of it.
    expect(fittedWindow(content, undefined)).toEqual({
      top: 4,
      left: 1,
      bottom: 6,
      right: 3,
    });
    // A box smaller than one track still prints that track (it overflows).
    expect(fittedWindow(content, { widthPt: 10, heightPt: 5 })).toEqual({
      top: 4,
      left: 1,
      bottom: 4,
      right: 1,
    });
  });
});
