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

// Doc ADR 623 — the pictures of the read-back paragraphs reach the
// save-back: one entry per kept paragraph of the stories (trailing empty
// paragraphs past the poured count dropped, as the merged body drops them),
// and per paragraph of each cell read with its paragraphs.

import { describe, expect, it } from "bun:test";

import { readPictures } from "../src/save-structure";

const placement: [number, number, number, number, number, number] = [
  0.72, 0, 0, 0.72, -36, 0,
];
const picture = { frameId: "u1", offset: 0, placement };
const para = (text: string, pictures?: unknown[]) => ({
  runs: [{ text }],
  ...(pictures ? { pictures } : {}),
});

describe("[plugin-doc.picture-crop] pictures read back for the save", () => {
  it("lists the pictures per kept paragraph, in story order", () => {
    const contents = [
      { paragraphs: [para("a", [picture]), para("b"), para("")] },
      { paragraphs: [para("c", [picture, picture])] },
    ];
    const read = readPictures(contents, [2, 1], []);
    expect(read.body).toEqual([[picture], [], [picture, picture]]);
    expect(read.cells).toEqual([]);
  });

  it("lists a cell's pictures per paragraph, and skips a cell read as text only", () => {
    const read = readPictures(
      [{ paragraphs: [para("t")] }],
      [1],
      [
        {
          block: 1,
          cell: 0,
          text: "x",
          paragraphs: [para("x", [picture])],
        },
        { block: 1, cell: 1, text: "y" },
      ],
    );
    expect(read.cells).toEqual([
      { block: 1, cell: 0, paragraphs: [[picture]] },
    ]);
  });

  it("a host that does not read pictures lists none", () => {
    expect(readPictures([{ paragraphs: [para("a")] }], [1], []).body).toEqual([
      [],
    ]);
  });
});
