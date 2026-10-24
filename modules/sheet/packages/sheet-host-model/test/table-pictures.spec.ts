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

// W2.3 (sheet ADR 526) — pictures over a placed table: an image frame at
// the anchor cell in the table's own column widths plus the offset, the
// image placed by its data URI; an image in a cell scales with its column.

import { describe, expect, it } from "bun:test";

import {
  tablePictureBox,
  tablePictureOps,
  type LoweredContent,
  type LoweredPicture,
} from "../src";

const content = {
  cols: [
    { index: 4, widthPt: 40 },
    { index: 5, widthPt: 60 },
  ],
  rows: [
    { index: 1, heightPt: 15, cells: [] },
    { index: 2, heightPt: 20, cells: [] },
  ],
  rules: { h: [], v: [] },
  merges: [],
  styles: [],
} as unknown as LoweredContent;

const pic: LoweredPicture = {
  id: "xl/drawings/drawing1.xml#0",
  row: 2,
  col: 5,
  dx: 3,
  dy: 2,
  wPt: 50,
  hPt: 30,
  inCell: false,
  uri: "data:image/png;base64,AA==",
};

describe("pictures over a page table [sheet.xlsx.pictures]", () => {
  it("places a picture at its anchor cell plus its offset", () => {
    expect(tablePictureBox(content, [40, 60], [100, 50], pic)).toEqual([
      117, 93, 147, 143,
    ]);
    // Wider table columns move it (an image in a cell also widens).
    expect(tablePictureBox(content, [80, 120], [0, 0], pic)).toEqual([
      17, 86, 47, 136,
    ]);
    expect(
      tablePictureBox(content, [80, 120], [0, 0], { ...pic, inCell: true }),
    ).toEqual([17, 86, 47, 186]);
    expect(
      tablePictureBox(content, [40, 60], [0, 0], { ...pic, col: 9 }),
    ).toBeNull();
  });

  it("emits a frame and its image per picture", () => {
    const ops = tablePictureOps(
      { ...content, pictures: [pic, { ...pic, col: 9 }] },
      [40, 60],
      "p1" as never,
      [0, 0],
    );
    expect(ops.map((o) => o.op)).toEqual([
      "insertFrame",
      "bindCreated",
      "placeImage",
    ]);
    expect(ops[2]).toEqual({
      op: "placeImage",
      args: {
        elementId: "$h:pic0",
        uri: "data:image/png;base64,AA==",
        fit: "ContentToFrame",
      },
    });
  });
});
