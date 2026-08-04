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
  orientForNonZeroHoles,
  pointInAnchorPath,
  reverseContour,
  splitCompound,
  type AnchorTable,
  type AnchorTriple,
} from "../src/index";

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
});
