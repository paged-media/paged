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

// The editing aids' geometry (editor ADR "Editing aids and Proof view"):
// a frame's edge through its turn and its page, the baseline grid's lines
// from the document's grid preferences (and none when they would be a
// fill), and the box Proof view shows of a page.

import { describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { frameEdgePoints } from "../../src/overlays/frame-edges";
import {
  BASELINE_GRID_MIN_SPACING_PX,
  baselineGridLines,
} from "../../src/overlays/baseline-grid";
import { proofBox } from "../../src/overlays/proof-surface";

describe("frame edges", () => {
  test("an item's four corners through its transform, on its page", () => {
    covers("setting:view.frameEdges");
    // [top, left, bottom, right] = 10, 20, 50, 120 on a page at (0, 816).
    expect(
      frameEdgePoints(
        { bounds: [10, 20, 50, 120], itemTransform: null },
        {
          x: 0,
          y: 816,
        },
      ),
    ).toBe("20,826 120,826 120,866 20,866");
    // Turned a quarter about the origin: x' = −y, y' = x.
    expect(
      frameEdgePoints(
        { bounds: [0, 0, 10, 20], itemTransform: [0, 1, -1, 0, 100, 0] },
        { x: 0, y: 0 },
      ),
    ).toBe("100,0 100,20 90,20 90,0");
    // On the pasteboard (no page) nothing is drawn.
    expect(
      frameEdgePoints({ bounds: [0, 0, 1, 1], itemTransform: null }, undefined),
    ).toBeNull();
  });
});

describe("the baseline grid", () => {
  test("from its start every increment, from the top of the page or the top margin", () => {
    covers("setting:view.baselineGrid");
    expect(
      baselineGridLines(
        { baselineGridStart: 36, baselineGridDivision: 12 },
        84,
      ),
    ).toEqual([36, 48, 60, 72, 84]);
    expect(
      baselineGridLines(
        {
          baselineGridStart: 0,
          baselineGridDivision: 20,
          baselineGridRelativeTo: "TopMargin",
        },
        100,
        36,
      ),
    ).toEqual([36, 56, 76, 96]);
    // No preferences: InDesign's default grid (36 pt, every 12 pt).
    expect(baselineGridLines(null, 60)).toEqual([36, 48, 60]);
    // A nonsense increment falls back to the default.
    expect(
      baselineGridLines({ baselineGridDivision: 0, baselineGridStart: 0 }, 24),
    ).toEqual([0, 12, 24]);
    expect(BASELINE_GRID_MIN_SPACING_PX).toBeGreaterThan(1);
  });
});

describe("Proof view's box", () => {
  test("the trim, or the trim grown by the page's bleed", () => {
    const trim = { x: 0, y: 816, w: 612, h: 792 };
    const bleed = {
      selfId: "p",
      bleedTopPt: 9,
      bleedLeftPt: 9,
      bleedBottomPt: 9,
      bleedRightPt: 18,
    };
    expect(proofBox(trim, bleed, false)).toEqual(trim);
    expect(proofBox(trim, bleed, true)).toEqual({
      x: -9,
      y: 807,
      w: 639,
      h: 810,
    });
    expect(proofBox(trim, undefined, true)).toEqual(trim);
  });
});
