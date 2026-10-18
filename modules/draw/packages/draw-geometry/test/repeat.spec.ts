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
  affineReflect,
  affineRotate,
  affineTranslate,
  applyAffine,
  boundsCenter,
  contourSignedArea,
  fitPlacementsToPage,
  gridPlacements,
  mirrorAxisNormal,
  mirrorOriginFor,
  mirrorPlacements,
  radialCenterFor,
  radialPointAt,
  radialPlacements,
  radialStepDeg,
  rectAnchorTable,
  repeatExtent,
  transformAnchorTable,
  transformBounds,
  type AnchorTable,
  type RepeatBounds,
} from "../src/index";

const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;
const nearPoint = (
  p: readonly [number, number],
  q: readonly [number, number],
  tol = 1e-9,
) => near(p[0], q[0], tol) && near(p[1], q[1], tol);

/** A 100 × 100 box at (0, 0), corner anchors. */
const BOX: RepeatBounds = [0, 0, 100, 100];

const boxTable = (): AnchorTable => rectAnchorTable(BOX);

describe("draw-geometry — REPEAT placements (§12.4)", () => {
  describe("the affines (the engine's [a, b, c, d, tx, ty] column pairs)", () => {
    it("rotation turns +x toward +y — CLOCKWISE on a y-down page", () => {
      const m = affineRotate(90, [0, 0]);
      expect(nearPoint(applyAffine(m, 1, 0) as [number, number], [0, 1])).toBe(
        true,
      );
      expect(nearPoint(applyAffine(m, 0, 1) as [number, number], [-1, 0])).toBe(
        true,
      );
    });

    it("rotation about a centre leaves that centre fixed", () => {
      const m = affineRotate(37, [50, 70]);
      expect(nearPoint(applyAffine(m, 50, 70) as [number, number], [50, 70])).toBe(
        true,
      );
    });

    it("reflect(90) is a VERTICAL axis — a left↔right flip", () => {
      const m = affineReflect(90, [10, 0]);
      expect(nearPoint(applyAffine(m, 30, 5) as [number, number], [-10, 5])).toBe(
        true,
      );
      // Points ON the axis do not move.
      expect(nearPoint(applyAffine(m, 10, 99) as [number, number], [10, 99])).toBe(
        true,
      );
    });

    it("reflect(0) is a HORIZONTAL axis — a top↔bottom flip", () => {
      const m = affineReflect(0, [0, 20]);
      expect(nearPoint(applyAffine(m, 5, 30) as [number, number], [5, 10])).toBe(
        true,
      );
    });

    it("a reflection REVERSES contour winding — which is why a mirrored compound source is NOT re-wound", () => {
      const table = boxTable();
      const before = contourSignedArea(table.anchors);
      const after = contourSignedArea(
        transformAnchorTable(table, affineReflect(90, [0, 0])).anchors,
      );
      expect(Math.sign(after)).toBe(-Math.sign(before));
      // Both contours of a compound flip TOGETHER, so their RELATIVE
      // winding — the thing non-zero fill reads — is unchanged.
      expect(near(Math.abs(after), Math.abs(before))).toBe(true);
    });

    it("transformAnchorTable moves anchors AND both handles, keeping contour bookkeeping", () => {
      const table: AnchorTable = {
        anchors: [
          { anchor: [0, 0], left: [-5, 0], right: [5, 0] },
          { anchor: [10, 0], left: [5, 0], right: [15, 0] },
        ],
        subpathStarts: [0],
        subpathOpen: [true],
      };
      const out = transformAnchorTable(table, affineTranslate(3, 4));
      expect(out.anchors[0]).toEqual({
        anchor: [3, 4],
        left: [-2, 4],
        right: [8, 4],
      });
      expect(out.subpathStarts).toEqual([0]);
      expect(out.subpathOpen).toEqual([true]);
    });

    it("transformBounds re-hulls the four corners — a rotated box reports a BIGGER axis-aligned box", () => {
      const spun = transformBounds(BOX, affineRotate(45, [50, 50]));
      const side = 100 * Math.SQRT2;
      expect(near(spun[3] - spun[1], side, 1e-9)).toBe(true);
      expect(near(spun[2] - spun[0], side, 1e-9)).toBe(true);
    });
  });

  describe("radial", () => {
    it("the step DIVIDES BY count on a closed ring and by count-1 on an arc", () => {
      // A closed ring: 6 instances 60° apart, the last NOT on the first.
      expect(radialStepDeg(6, 360)).toBe(60);
      // A partial arc: the first and last sit exactly on the ends.
      expect(radialStepDeg(4, 180)).toBe(60);
      // One instance is the source alone.
      expect(radialStepDeg(1, 360)).toBe(0);
    });

    it("the centre is derived so the SOURCE NEVER MOVES", () => {
      const source = boundsCenter(BOX);
      const center = radialCenterFor(source, 120, -90);
      // The source sits ON the ring at the start angle.
      expect(nearPoint(radialPointAt(center, 120, -90), source, 1e-9)).toBe(true);
      // …and placement 0 is the identity, i.e. the source is not re-emitted.
      const placements = radialPlacements({
        count: 4,
        radiusPt: 120,
        startDeg: -90,
        sweepDeg: 360,
        rotateInstances: true,
        center,
      });
      expect(placements[0].matrix).toEqual([1, 0, 0, 1, 0, 0]);
      expect(placements).toHaveLength(4);
      expect(placements.map((p) => p.index)).toEqual([0, 1, 2, 3]);
    });

    it("rotateInstances ON puts every instance on the ring AND turns it", () => {
      const source = boundsCenter(BOX);
      const center = radialCenterFor(source, 100, 0);
      const placements = radialPlacements({
        count: 4,
        radiusPt: 100,
        startDeg: 0,
        sweepDeg: 360,
        rotateInstances: true,
        center,
      });
      // Instance 1 is a quarter turn about the centre.
      const p1 = applyAffine(placements[1].matrix, source[0], source[1]);
      expect(nearPoint(p1 as [number, number], radialPointAt(center, 100, 90))).toBe(
        true,
      );
      // A turn is not a translation: the box's axis-aligned hull grows
      // for a non-multiple-of-90 step…
      const odd = radialPlacements({
        count: 8,
        radiusPt: 100,
        startDeg: 0,
        sweepDeg: 360,
        rotateInstances: true,
        center,
      });
      const spun = transformBounds(BOX, odd[1].matrix);
      expect(spun[3] - spun[1]).toBeGreaterThan(100);
    });

    it("rotateInstances OFF slides the artwork round the ring WITHOUT turning it", () => {
      const source = boundsCenter(BOX);
      const center = radialCenterFor(source, 100, 0);
      const placements = radialPlacements({
        count: 8,
        radiusPt: 100,
        startDeg: 0,
        sweepDeg: 360,
        rotateInstances: false,
        center,
      });
      for (const p of placements.slice(1)) {
        // A pure translation: the 2×2 block is the identity.
        expect([p.matrix[0], p.matrix[1], p.matrix[2], p.matrix[3]]).toEqual([
          1, 0, 0, 1,
        ]);
      }
      const moved = transformBounds(BOX, placements[2].matrix);
      expect(near(moved[3] - moved[1], 100)).toBe(true);
    });
  });

  describe("grid", () => {
    it("is row-major, `columns × rows`, and cell (0,0) is the source", () => {
      const g = gridPlacements({
        columns: 3,
        rows: 2,
        stepX: 110,
        stepY: 120,
        flipColumns: false,
        flipRows: false,
        cellCenter: [50, 50],
      });
      expect(g).toHaveLength(6);
      expect(g[0]).toEqual({
        index: 0,
        col: 0,
        row: 0,
        matrix: [1, 0, 0, 1, 0, 0],
      });
      expect(g.map((p) => [p.col, p.row])).toEqual([
        [0, 0],
        [1, 0],
        [2, 0],
        [0, 1],
        [1, 1],
        [2, 1],
      ]);
      expect(g[4].matrix).toEqual([1, 0, 0, 1, 110, 120]);
    });

    it("a NEGATIVE spacing is a real overlap — the step shrinks below the source size", () => {
      const g = gridPlacements({
        columns: 2,
        rows: 1,
        stepX: 100 + -30,
        stepY: 100,
        flipColumns: false,
        flipRows: false,
        cellCenter: [50, 50],
      });
      const cell = transformBounds(BOX, g[1].matrix);
      // 70 < 100, so the second cell's box overlaps the first's.
      expect(cell[1]).toBe(70);
      expect(cell[1]).toBeLessThan(BOX[3]);
    });

    it("flipColumns mirrors ODD columns about their OWN cell centre", () => {
      const g = gridPlacements({
        columns: 2,
        rows: 1,
        stepX: 100,
        stepY: 100,
        flipColumns: true,
        flipRows: false,
        cellCenter: [50, 50],
      });
      // The flipped cell still occupies its own slot (the flip is about
      // the DESTINATION centre, not the source's).
      const cell = transformBounds(BOX, g[1].matrix);
      expect(nearPoint([cell[1], cell[0]], [100, 0])).toBe(true);
      expect(near(cell[3] - cell[1], 100)).toBe(true);
      // …and it really is mirrored: the left edge maps to the right one.
      const p = applyAffine(g[1].matrix, 0, 50) as [number, number];
      expect(nearPoint(p, [200, 50])).toBe(true);
    });

    it("flipRows and flipColumns together are a 180° turn of the odd/odd cell", () => {
      const g = gridPlacements({
        columns: 2,
        rows: 2,
        stepX: 100,
        stepY: 100,
        flipColumns: true,
        flipRows: true,
        cellCenter: [50, 50],
      });
      const oddOdd = g.find((p) => p.col === 1 && p.row === 1)!;
      const p = applyAffine(oddOdd.matrix, 0, 0) as [number, number];
      expect(nearPoint(p, [200, 200])).toBe(true);
      const q = applyAffine(oddOdd.matrix, 100, 100) as [number, number];
      expect(nearPoint(q, [100, 100])).toBe(true);
    });
  });

  describe("mirror", () => {
    it("emits exactly ONE reflection beside the identity", () => {
      const m = mirrorPlacements({ angleDeg: 90, origin: [100, 50] });
      expect(m).toHaveLength(2);
      expect(m[0].matrix).toEqual([1, 0, 0, 1, 0, 0]);
      expect(m[1].index).toBe(1);
      expect(m[1].col).toBe(1);
    });

    it("the normal is (sin θ, −cos θ): +offset moves a VERTICAL axis RIGHT and a HORIZONTAL one UP", () => {
      expect(nearPoint(mirrorAxisNormal(90), [1, 0])).toBe(true);
      expect(nearPoint(mirrorAxisNormal(0), [0, -1])).toBe(true);
      expect(nearPoint(mirrorOriginFor([50, 50], 90, 50), [100, 50])).toBe(true);
      expect(nearPoint(mirrorOriginFor([50, 50], 0, 50), [50, 0])).toBe(true);
    });

    it("an axis on the source's edge places the image immediately beside it", () => {
      const origin = mirrorOriginFor(boundsCenter(BOX), 90, 50);
      const m = mirrorPlacements({ angleDeg: 90, origin });
      const image = transformBounds(BOX, m[1].matrix);
      expect(nearPoint([image[1], image[3]], [100, 200])).toBe(true);
    });
  });

  describe("the artboard fit (RFI C-23)", () => {
    const page = { width: 612, height: 792 };

    it("keeps the SOURCE always, and drops instances whose box leaves the page", () => {
      const placements = [
        { index: 0, col: 0, row: 0, matrix: affineTranslate(0, 0) },
        { index: 1, col: 1, row: 0, matrix: affineTranslate(200, 0) },
        { index: 2, col: 2, row: 0, matrix: affineTranslate(900, 0) },
        { index: 3, col: 3, row: 0, matrix: affineTranslate(0, -400) },
      ];
      const fit = fitPlacementsToPage(placements, BOX, page);
      expect(fit.placed.map((p) => p.index)).toEqual([0, 1]);
      expect(fit.dropped.map((p) => p.index)).toEqual([2, 3]);
    });

    it("a null page (an unreadable rect) keeps EVERYTHING — the honest degrade", () => {
      const placements = [
        { index: 0, col: 0, row: 0, matrix: affineTranslate(0, 0) },
        { index: 1, col: 1, row: 0, matrix: affineTranslate(9000, 9000) },
      ];
      const fit = fitPlacementsToPage(placements, BOX, null);
      expect(fit.placed).toHaveLength(2);
      expect(fit.dropped).toHaveLength(0);
    });

    it("a ROTATED instance is fitted by its GROWN hull, not the source box", () => {
      // A 45° turn about a centre near the page edge: the hull is
      // 141 pt wide, so it leaves the page where the un-turned box
      // would not.
      const spun = affineRotate(45, [560, 100]);
      const fit = fitPlacementsToPage(
        [{ index: 1, col: 1, row: 0, matrix: spun }],
        [50, 520, 150, 600],
        page,
      );
      expect(fit.placed).toHaveLength(0);
      expect(fit.dropped).toHaveLength(1);
    });
  });

  describe("extent + the clip rect", () => {
    it("repeatExtent is the union of every placement's transformed box", () => {
      const ext = repeatExtent(
        [
          { index: 0, col: 0, row: 0, matrix: affineTranslate(0, 0) },
          { index: 1, col: 1, row: 0, matrix: affineTranslate(150, 0) },
          { index: 2, col: 0, row: 1, matrix: affineTranslate(0, 150) },
        ],
        BOX,
      );
      expect(ext).toEqual([0, 0, 250, 250]);
    });

    it("rectAnchorTable is one CLOSED corner contour in [top, left, bottom, right] order", () => {
      const t = rectAnchorTable([10, 20, 30, 40]);
      expect(t.subpathStarts).toEqual([0]);
      expect(t.subpathOpen).toEqual([false]);
      expect(t.anchors.map((a) => a.anchor)).toEqual([
        [20, 10],
        [40, 10],
        [40, 30],
        [20, 30],
      ]);
      // Corner anchors: both handles collapsed.
      expect(t.anchors[0].left).toEqual([20, 10]);
      expect(t.anchors[0].right).toEqual([20, 10]);
    });
  });
});
