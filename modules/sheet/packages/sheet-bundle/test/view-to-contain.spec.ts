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

// Sheet ADR 510 — the view a window frame keeps on leaving: what the grid
// showed must be on the page, and the page moves only as far as needed.

import { describe, expect, it } from "bun:test";

import { viewToContain } from "../src/lower";

const span = (a: number, b: number) =>
  Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe("viewToContain [sheet.lower.page]", () => {
  it("a grid window inside the page window keeps the view", () => {
    // The page shows rows 0–4; the grid (headings take room) scrolled to
    // rows 1–2 when Enter moved down: still on the page, nothing moves.
    expect(
      viewToContain(
        { row: 0, col: 0 },
        { rows: span(0, 4), cols: span(0, 2) },
        { rows: span(1, 2), cols: span(0, 1) },
      ),
    ).toEqual({ row: 0, col: 0 });
  });

  it("scrolled past the page's end, the page moves just enough", () => {
    expect(
      viewToContain(
        { row: 0, col: 0 },
        { rows: span(0, 4), cols: span(0, 2) },
        { rows: span(3, 6), cols: span(0, 1) },
      ),
    ).toEqual({ row: 2, col: 0 });
  });

  it("scrolled above the page, the page starts at the grid's first row", () => {
    expect(
      viewToContain(
        { row: 10, col: 3 },
        { rows: span(10, 14), cols: span(3, 5) },
        { rows: span(7, 9), cols: span(1, 2) },
      ),
    ).toEqual({ row: 7, col: 1 });
  });

  it("a grid larger than the page starts the page at the grid's first track", () => {
    expect(
      viewToContain(
        { row: 0, col: 0 },
        { rows: span(0, 2), cols: span(0, 1) },
        { rows: span(5, 20), cols: span(4, 9) },
      ),
    ).toEqual({ row: 5, col: 4 });
  });
});
