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

import { describe, expect, it } from "vitest";

import {
  contourDepths,
  contourRanges,
  contourSignedArea,
  makeCompoundTable,
  mergeCompound,
  orientByPaintOrder,
  orientForNonZeroHoles,
  pointInAnchorPath,
  reverseContour,
  splitCompound,
  type AnchorTable,
  type AnchorTriple,
} from "../src/index";
import { refWindingNumber } from "./property-kit";

/** A corner-anchor quad (both handles collapsed onto the anchor). */
const quad = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): AnchorTriple[] =>
  (
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ] as [number, number][]
  ).map((p) => ({
    anchor: [p[0], p[1]] as [number, number],
    left: [p[0], p[1]] as [number, number],
    right: [p[0], p[1]] as [number, number],
  }));

const table = (anchors: AnchorTriple[]): AnchorTable => ({
  anchors,
  subpathStarts: [0],
  subpathOpen: [false],
});

const OUTER = quad(100, 100, 400, 400);
const INNER = quad(200, 200, 300, 300);

describe("draw-geometry — compound-path contour algebra", () => {
  describe("contourRanges", () => {
    it("treats an EMPTY subpathStarts as the single-contour case", () => {
      expect(contourRanges(4, [])).toEqual([[0, 4]]);
      expect(contourRanges(4, [0])).toEqual([[0, 4]]);
    });

    it("splits at the recorded boundaries and drops empty ranges", () => {
      expect(contourRanges(8, [0, 4])).toEqual([
        [0, 4],
        [4, 8],
      ]);
      // A boundary at the very end contributes nothing.
      expect(contourRanges(4, [0, 4])).toEqual([[0, 4]]);
      expect(contourRanges(0, [])).toEqual([]);
    });
  });

  describe("contourSignedArea", () => {
    it("measures the enclosed area and reports the winding in the SIGN", () => {
      expect(contourSignedArea(OUTER)).toBeCloseTo(90000, 6);
      expect(contourSignedArea(reverseContour(OUTER))).toBeCloseTo(-90000, 6);
      // Under two anchors there is no area to speak of.
      expect(contourSignedArea(OUTER.slice(0, 1))).toBe(0);
    });
  });

  describe("reverseContour", () => {
    it("keeps a CLOSED contour's first anchor and reverses the rest", () => {
      const r = reverseContour(OUTER);
      expect(r.map((a) => a.anchor)).toEqual([
        [100, 100],
        [100, 400],
        [400, 400],
        [400, 100],
      ]);
    });

    it("swaps each anchor's handles — the outgoing one becomes incoming", () => {
      const curved: AnchorTriple[] = [
        { anchor: [0, 0], left: [-1, -1], right: [1, 1] },
        { anchor: [10, 0], left: [9, 1], right: [11, -1] },
      ];
      expect(reverseContour(curved, { closed: false })).toEqual([
        { anchor: [10, 0], left: [11, -1], right: [9, 1] },
        { anchor: [0, 0], left: [1, 1], right: [-1, -1] },
      ]);
    });

    it("reverses an OPEN contour outright (its endpoints do swap)", () => {
      const r = reverseContour(OUTER, { closed: false });
      expect(r.map((a) => a.anchor)).toEqual([
        [100, 400],
        [400, 400],
        [400, 100],
        [100, 100],
      ]);
    });
  });

  describe("contourDepths", () => {
    it("reports 0 for an outer boundary and 1 for a contour inside it", () => {
      expect(contourDepths(mergeCompound([table(OUTER), table(INNER)]))).toEqual(
        [0, 1],
      );
      // Order-independent: nesting is a relation, not a position.
      expect(contourDepths(mergeCompound([table(INNER), table(OUTER)]))).toEqual(
        [1, 0],
      );
    });

    it("reports 0 for both when the contours are merely DISJOINT", () => {
      expect(
        contourDepths(mergeCompound([table(OUTER), table(quad(500, 500, 600, 600))])),
      ).toEqual([0, 0]);
    });

    it("counts an island inside a hole as depth 2", () => {
      const merged = mergeCompound([
        table(OUTER),
        table(INNER),
        table(quad(220, 220, 260, 260)),
      ]);
      expect(contourDepths(merged)).toEqual([0, 1, 2]);
    });
  });

  describe("orientForNonZeroHoles — the reason a hole is a hole", () => {
    it("flips an odd-depth contour so NON-ZERO carves it out", () => {
      // Authored the SAME way round: non-zero would paint a solid disc.
      const merged = mergeCompound([table(OUTER), table(INNER)]);
      expect(Math.sign(contourSignedArea(merged.anchors.slice(0, 4)))).toBe(
        Math.sign(contourSignedArea(merged.anchors.slice(4, 8))),
      );
      const ring = orientForNonZeroHoles(merged);
      const outer = contourSignedArea(ring.anchors.slice(0, 4));
      const inner = contourSignedArea(ring.anchors.slice(4, 8));
      expect(Math.sign(outer)).toBe(-Math.sign(inner));
      expect(ring.subpathStarts).toEqual([0, 4]);
    });

    it("never flips contour 0 — the survivor keeps its authored direction", () => {
      const merged = mergeCompound([table(reverseContour(OUTER)), table(INNER)]);
      const ring = orientForNonZeroHoles(merged);
      expect(ring.anchors.slice(0, 4)).toEqual(merged.anchors.slice(0, 4));
      expect(
        Math.sign(contourSignedArea(ring.anchors.slice(4, 8))),
      ).toBe(-Math.sign(contourSignedArea(ring.anchors.slice(0, 4))));
    });

    it("leaves an ALREADY-correct pair untouched (idempotent)", () => {
      const ring = orientForNonZeroHoles(
        mergeCompound([table(OUTER), table(INNER)]),
      );
      expect(orientForNonZeroHoles(ring)).toEqual(ring);
    });

    it("re-winds a depth-2 island back to the OUTER direction", () => {
      const ring = orientForNonZeroHoles(
        mergeCompound([
          table(OUTER),
          table(INNER),
          table(quad(220, 220, 260, 260)),
        ]),
      );
      const signs = [
        Math.sign(contourSignedArea(ring.anchors.slice(0, 4))),
        Math.sign(contourSignedArea(ring.anchors.slice(4, 8))),
        Math.sign(contourSignedArea(ring.anchors.slice(8, 12))),
      ];
      expect(signs).toEqual([signs[0], -signs[0], signs[0]]);
    });

    it("passes a single contour straight through", () => {
      expect(orientForNonZeroHoles(table(OUTER))).toEqual(table(OUTER));
    });
  });

  describe("mergeCompound / splitCompound", () => {
    it("concatenates anchors and extends subpathStarts", () => {
      const merged = mergeCompound([table(OUTER), table(INNER)]);
      expect(merged.anchors).toHaveLength(8);
      expect(merged.subpathStarts).toEqual([0, 4]);
      expect(merged.subpathOpen).toEqual([false, false]);
    });

    it("flattens a COMPOUND input's own contours into the result", () => {
      const ring = makeCompoundTable([table(OUTER), table(INNER)]);
      const merged = mergeCompound([ring, table(quad(500, 500, 600, 600))]);
      expect(merged.subpathStarts).toEqual([0, 4, 8]);
      expect(merged.anchors).toHaveLength(12);
    });

    it("carries per-contour openness through the merge", () => {
      const open: AnchorTable = {
        anchors: OUTER,
        subpathStarts: [0],
        subpathOpen: [true],
      };
      expect(mergeCompound([open, table(INNER)]).subpathOpen).toEqual([
        true,
        false,
      ]);
    });

    it("splits back into one table per contour", () => {
      const ring = makeCompoundTable([table(OUTER), table(INNER)]);
      const parts = splitCompound(ring);
      expect(parts).toHaveLength(2);
      expect(parts[0].anchors).toEqual(ring.anchors.slice(0, 4));
      expect(parts[1].anchors).toEqual(ring.anchors.slice(4, 8));
      expect(parts.every((p) => p.subpathStarts.length === 1)).toBe(true);
    });

    it("make → release → make is STABLE (the round-trip)", () => {
      const ring = makeCompoundTable([table(OUTER), table(INNER)]);
      const again = makeCompoundTable(splitCompound(ring));
      expect(again).toEqual(ring);
    });
  });

  describe("the region the ring describes", () => {
    it("even-odd point-in-path agrees: inside the hole is OUTSIDE the shape", () => {
      const ring = makeCompoundTable([table(OUTER), table(INNER)]);
      // In the band between the contours ⇒ painted.
      expect(
        pointInAnchorPath([150, 150], ring.anchors, ring.subpathStarts),
      ).toBe(true);
      // In the hole ⇒ not painted.
      expect(
        pointInAnchorPath([250, 250], ring.anchors, ring.subpathStarts),
      ).toBe(false);
      // Outside everything ⇒ not painted.
      expect(
        pointInAnchorPath([50, 50], ring.anchors, ring.subpathStarts),
      ).toBe(false);
    });
  });

  // Illustrator's Make Compound Path, recorded (draw-bundle's
  // `test/oracle/compound-path.spec.ts`): non-zero, the backmost path one
  // way, every other path the other. These are the recorded cases'
  // geometry, read as windings at probe points.
  describe("orientByPaintOrder — Illustrator's Make Compound Path rule", () => {
    const signAt = (t: AnchorTable, i: number): number => {
      const [from, to] = contourRanges(t.anchors.length, t.subpathStarts)[i];
      return Math.sign(contourSignedArea(t.anchors.slice(from, to)));
    };
    const signs = (t: AnchorTable): number[] =>
      contourRanges(t.anchors.length, t.subpathStarts).map((_, i) => signAt(t, i));
    /** Non-zero winding at `p` (angle summation over the corner rings). */
    const windingAt = (t: AnchorTable, p: [number, number]): number =>
      contourRanges(t.anchors.length, t.subpathStarts).reduce(
        (sum, [from, to]) =>
          sum + refWindingNumber(p, t.anchors.slice(from, to).map((a) => a.anchor)),
        0,
      );

    // The oracle's four-deep case: every square drawn clockwise, the
    // outer one backmost.
    const OUT = quad(100, 100, 300, 300);
    const HOLE = quad(150, 150, 250, 250);
    const ISLAND = quad(180, 180, 220, 220);
    const CORE = quad(190, 190, 210, 210);

    it("four levels deep, the CORE paints (−2): Illustrator's 31 600 — where the depth rule makes it a hole (even-odd's 31 200)", () => {
      const tables = [OUT, HOLE, ISLAND, CORE].map(table);
      const paint = orientByPaintOrder(mergeCompound(tables), 0);
      expect(signs(paint)).toEqual([1, -1, -1, -1]);
      expect(windingAt(paint, [120, 120])).toBe(1); // the outer band
      expect(windingAt(paint, [160, 160])).toBe(0); // the hole
      expect(windingAt(paint, [185, 185])).toBe(-1); // the island
      expect(windingAt(paint, [200, 200])).toBe(-2); // the core: SOLID
      // Image Trace's rule, on the same contours, is unchanged: it
      // alternates, and the core is a hole.
      const depth = makeCompoundTable(tables);
      expect(signs(depth)).toEqual([1, -1, 1, -1]);
      expect(windingAt(depth, [200, 200])).toBe(0);
    });

    it("two shapes that merely OVERLAP: the overlap is knocked out, whichever way either was drawn", () => {
      const BACK = quad(100, 100, 200, 180);
      const FRONT = quad(150, 140, 260, 220);
      for (const [back, front] of [
        [BACK, FRONT],
        [BACK, reverseContour(FRONT)],
        [reverseContour(BACK), FRONT],
      ]) {
        const paint = orientByPaintOrder(mergeCompound([table(back), table(front)]), 0);
        expect(windingAt(paint, [175, 160])).toBe(0); // in both
        expect(windingAt(paint, [120, 120])).not.toBe(0); // back only
        expect(windingAt(paint, [240, 200])).not.toBe(0); // front only
      }
    });

    it("the backmost need not be contour 0: a hole BEHIND its outer shape keeps its direction, and the outer one turns", () => {
      // The survivor (OUTER) is merged first; the hole is the path behind.
      const paint = orientByPaintOrder(mergeCompound([table(OUTER), table(INNER)]), 1);
      expect(paint.anchors.slice(4)).toEqual(INNER);
      expect(paint.anchors.slice(0, 4)).toEqual(reverseContour(OUTER));
      // Still a hole.
      expect(windingAt(paint, [150, 150])).toBe(-1);
      expect(windingAt(paint, [250, 250])).toBe(0);
    });

    it("make → release → make keeps every direction, even when the release RESTACKS the pieces", () => {
      // Hole behind its outer shape: the hole (contour 1) is backmost.
      const made = orientByPaintOrder(mergeCompound([table(OUTER), table(INNER)]), 1);
      // A release inserts the hole's piece ON TOP, so the second make
      // finds the OUTER shape behind — contour 0 is the backmost now.
      const again = orientByPaintOrder(mergeCompound(splitCompound(made)), 0);
      expect(again).toEqual(made);
    });

    it("keeps the backmost path's OWN direction (Illustrator makes it clockwise; no pixel differs)", () => {
      const paint = orientByPaintOrder(
        mergeCompound([table(reverseContour(OUTER)), table(reverseContour(INNER))]),
        0,
      );
      expect(signs(paint)).toEqual([-1, 1]);
    });

    it("an OPEN contour that turns is reversed as an open run — its endpoints swap, its flag stays", () => {
      const open: AnchorTable = { anchors: INNER, subpathStarts: [0], subpathOpen: [true] };
      const paint = orientByPaintOrder(mergeCompound([table(OUTER), open]), 0);
      expect(paint.subpathOpen).toEqual([false, true]);
      expect(paint.anchors.slice(0, 4)).toEqual(OUTER);
      expect(paint.anchors.slice(4)).toEqual(reverseContour(INNER, { closed: false }));
    });

    it("an EMPTY contour is dropped, and `backmost` counts the contours that remain", () => {
      const t: AnchorTable = {
        anchors: [...OUTER, ...INNER],
        subpathStarts: [0, 4, 4],
        subpathOpen: [false, true, false],
      };
      // Contour 1 of the two that remain is INNER: the path behind.
      const paint = orientByPaintOrder(t, 1);
      expect(paint.subpathStarts).toEqual([0, 4]);
      expect(paint.subpathOpen).toEqual([false, false]);
      expect(paint.anchors.slice(4)).toEqual(INNER);
      expect(paint.anchors.slice(0, 4)).toEqual(reverseContour(OUTER));
    });

    it("leaves a ZERO-AREA contour alone", () => {
      const t = mergeCompound([table(OUTER), table(OUTER.slice(0, 2))]);
      expect(contourSignedArea(OUTER.slice(0, 2))).toBe(0);
      expect(orientByPaintOrder(t, 0)).toEqual(t);
    });

    it("passes a single contour straight through, and refuses a `backmost` that names no contour", () => {
      expect(orientByPaintOrder(table(OUTER), 0)).toEqual(table(OUTER));
      const empty: AnchorTable = { anchors: [], subpathStarts: [] };
      expect(orientByPaintOrder(empty, 0)).toBe(empty);
      const two = mergeCompound([table(OUTER), table(INNER)]);
      for (const bad of [2, -1, 0.5, Number.NaN]) {
        expect(() => orientByPaintOrder(two, bad)).toThrow(RangeError);
      }
      expect(() => orientByPaintOrder(table(OUTER), 1)).toThrow(RangeError);
    });
  });
});
