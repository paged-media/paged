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
// fill) and a frame's own grid (engine ADR 1306), the hidden characters'
// marks as text runs and the pages they are read for, and the box Proof
// view shows of a page.

import { describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { frameEdgePoints } from "../../src/overlays/frame-edges";
import {
  BASELINE_GRID_MIN_SPACING_PX,
  baselineGridLines,
  frameGridLines,
} from "../../src/overlays/baseline-grid";
import {
  HIDDEN_CHARACTER_GLYPHS,
  hiddenCharacterRuns,
  pagesInView,
} from "../../src/overlays/hidden-characters";
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

describe("a frame's own baseline grid", () => {
  test("from its first line every increment down to the frame's bottom, in its own coordinates", () => {
    covers("setting:view.baselineGrid");
    // A frame 200..300 pt, its grid 5 pt below its top, every 13 pt.
    expect(
      frameGridLines({ bounds: [200, 20, 300, 200], start: 5, increment: 13 }),
    ).toEqual([205, 218, 231, 244, 257, 270, 283, 296]);
    // A first line above the frame's top (a page-relative grid) starts
    // inside it.
    expect(
      frameGridLines({ bounds: [100, 0, 130, 50], start: -14, increment: 12 }),
    ).toEqual([110, 122]);
    expect(
      frameGridLines({ bounds: [0, 0, 10, 10], start: 0, increment: 0 }),
    ).toEqual([]);
  });
});

describe("hidden characters", () => {
  test("a line's marks are two runs: the spaces centred in their width, the rest where they stand", () => {
    covers("setting:view.hiddenCharacters");
    const runs = hiddenCharacterRuns([
      { kind: "space", x: 30, width: 4 },
      { kind: "tab", x: 60, width: 20 },
      { kind: "space", x: 90, width: 3 },
      { kind: "forcedLineBreak", x: 120, width: 0 },
      { kind: "paragraphEnd", x: 140, width: 0 },
      { kind: "storyEnd", x: 150, width: 0 },
    ]);
    expect(runs.centred).toEqual({ text: "··", xs: [32, 91.5] });
    expect(runs.start).toEqual({ text: "»¬¶#", xs: [60, 120, 140, 150] });
    // InDesign's marks for the five the strategy names.
    expect(
      ["space", "tab", "paragraphEnd", "forcedLineBreak", "storyEnd"].map(
        (k) => HIDDEN_CHARACTER_GLYPHS[k as "space"],
      ),
    ).toEqual(["·", "»", "¶", "¬", "#"]);
  });

  test("only the pages in view are read", () => {
    const rects = new Map([
      ["p1" as never, { x: 0, y: 0, w: 612, h: 792 }],
      ["p2" as never, { x: 0, y: 816, w: 612, h: 792 }],
      ["p3" as never, { x: 0, y: 1632, w: 612, h: 792 }],
    ]);
    // At 100 %, a 1000 × 600 viewport over the first page's foot and the
    // second page's head (document y 700 to 1300).
    const camera = { scale: 1, tx: 0, ty: -700 };
    expect(pagesInView(rects, camera, [1000, 600])).toEqual(["p1", "p2"]);
    expect(pagesInView(rects, { ...camera, ty: -1700 }, [1000, 600])).toEqual([
      "p3",
    ]);
    // An unmeasured viewport: every page.
    expect(pagesInView(rects, camera, [0, 0])).toEqual(["p1", "p2", "p3"]);
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
