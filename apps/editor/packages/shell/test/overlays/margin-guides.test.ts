/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

import { describe, expect, test } from "bun:test";

import { marginGuides } from "../../src/overlays/margin-guides";

const letter = { selfId: "p1", sizePt: [612, 792] as [number, number] };

describe("margin guides", () => {
  test("a page without margins or columns draws nothing", () => {
    expect(marginGuides(letter)).toEqual({ box: null, columns: [] });
  });

  test("the margin box sits inside the page's margins", () => {
    const g = marginGuides({
      ...letter,
      marginTopPt: 48,
      marginLeftPt: 36,
      marginBottomPt: 60,
      marginRightPt: 24,
    });
    expect(g.box).toEqual({ x: 36, y: 48, w: 552, h: 684 });
    expect(g.columns).toEqual([]);
  });

  test("two columns mark both edges of their gutter", () => {
    const g = marginGuides({
      ...letter,
      marginTopPt: 48,
      marginLeftPt: 48,
      marginBottomPt: 48,
      marginRightPt: 48,
      columnCount: 2,
      columnGutterPt: 18,
    });
    // (516 - 18) / 2 = 249 pt a column.
    expect(g.columns).toEqual([297, 315]);
  });

  test("three columns without a gutter share one edge each", () => {
    const g = marginGuides({ ...letter, columnCount: 3 });
    expect(g.box).toEqual({ x: 0, y: 0, w: 612, h: 792 });
    expect(g.columns).toEqual([204, 408]);
  });
});
