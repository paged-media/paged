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

// Property tests for repeat.ts — the placement algebra of radial / grid /
// mirror repeats.

import { describe, expect, it } from "vitest";

import {
  affineReflect,
  affineRotate,
  affineTranslate,
  applyAffine,
  boundsCenter,
  composeAffine,
  dist,
  fitPlacementsToPage,
  gridPlacements,
  mirrorAxisNormal,
  mirrorOriginFor,
  mirrorPlacements,
  radialCenterFor,
  radialPlacements,
  radialPointAt,
  radialStepDeg,
  rectAnchorTable,
  repeatExtent,
  transformAnchorTable,
  transformBounds,
  type Affine,
  type RepeatBounds,
  type RepeatPlacement,
  type Vec2,
} from "../src";
import {
  angleDeg,
  assertClose,
  assertTrue,
  assertVecClose,
  canonicalTable,
  fc,
  real,
  smallVec2,
  vec2,
} from "./property-kit";

const DEG = Math.PI / 180;
const det = (m: Affine): number => m[0] * m[3] - m[1] * m[2];
const at = (m: Affine, p: Vec2): Vec2 => applyAffine(m, p[0], p[1]);
const scaleOf = (...pts: Vec2[]): number =>
  Math.max(1, ...pts.flatMap((p) => [Math.abs(p[0]), Math.abs(p[1])]));

const bounds: fc.Arbitrary<RepeatBounds> = fc
  .tuple(
    fc.integer({ min: -300, max: 300 }),
    fc.integer({ min: -300, max: 300 }),
    real(1, 200),
    real(1, 200),
  )
  .map(([top, left, h, w]) => [top, left, top + h, left + w] as RepeatBounds);

const radiusPt = real(1, 400);
const count = fc.integer({ min: 1, max: 24 });

/** Any isometry the module can build, for the bounds properties. */
const placementMatrix: fc.Arbitrary<Affine> = fc.oneof(
  fc.tuple(angleDeg, smallVec2).map(([d, c]) => affineRotate(d, c)),
  fc.tuple(angleDeg, smallVec2).map(([d, c]) => affineReflect(d, c)),
  smallVec2.map(([dx, dy]) => affineTranslate(dx, dy)),
);

describe("repeat — the affines (properties)", () => {
  it("affineTranslate moves every point by the offset", () => {
    fc.assert(
      fc.property(vec2, vec2, (d, p) => {
        assertVecClose(at(affineTranslate(d[0], d[1]), p), [p[0] + d[0], p[1] + d[1]], 0);
      }),
    );
  });

  it("affineRotate fixes its centre, preserves distances and orientation", () => {
    fc.assert(
      fc.property(angleDeg, smallVec2, vec2, vec2, (deg, c, p, q) => {
        const m = affineRotate(deg, c);
        const tol = 1e-9 * scaleOf(c, p, q);
        assertVecClose(at(m, c), c, tol, "centre");
        assertClose(dist(at(m, p), at(m, q)), dist(p, q), tol, "distance");
        assertClose(det(m), 1, 1e-12, "determinant");
      }),
    );
  });

  it("a POSITIVE angle turns +x toward +y (clockwise on a y-down page)", () => {
    fc.assert(
      fc.property(real(1, 179), smallVec2, radiusPt, (deg, c, r) => {
        const moved = at(affineRotate(deg, c), [c[0] + r, c[1]]);
        assertVecClose(
          moved,
          [c[0] + r * Math.cos(deg * DEG), c[1] + r * Math.sin(deg * DEG)],
          1e-9 * scaleOf(c, [r, r]),
        );
        assertTrue(moved[1] > c[1], "a positive rotation moved +x UP the page");
      }),
    );
  });

  it("rotations about one centre add their angles", () => {
    fc.assert(
      fc.property(angleDeg, angleDeg, smallVec2, vec2, (a, b, c, p) => {
        assertVecClose(
          at(composeAffine(affineRotate(a, c), affineRotate(b, c)), p),
          at(affineRotate(a + b, c), p),
          1e-9 * scaleOf(c, p),
        );
      }),
    );
  });

  it("affineReflect is an involution with determinant −1 that fixes its axis", () => {
    fc.assert(
      fc.property(angleDeg, smallVec2, vec2, real(-500, 500), (deg, c, p, along) => {
        const m = affineReflect(deg, c);
        const tol = 1e-9 * scaleOf(c, p, [along, along]);
        assertVecClose(at(m, at(m, p)), p, tol, "twice");
        assertClose(det(m), -1, 1e-12, "determinant");
        const onAxis: Vec2 = [c[0] + along * Math.cos(deg * DEG), c[1] + along * Math.sin(deg * DEG)];
        assertVecClose(at(m, onAxis), onAxis, tol, "a point on the axis");
      }),
    );
  });

  it("a reflection's image is the mirror image: same distance to the axis, on the other side", () => {
    fc.assert(
      fc.property(angleDeg, smallVec2, vec2, (deg, c, p) => {
        const image = at(affineReflect(deg, c), p);
        const ux = Math.cos(deg * DEG);
        const uy = Math.sin(deg * DEG);
        const side = (q: Vec2): number => (q[0] - c[0]) * uy - (q[1] - c[1]) * ux;
        const along = (q: Vec2): number => (q[0] - c[0]) * ux + (q[1] - c[1]) * uy;
        const tol = 1e-9 * scaleOf(c, p);
        assertClose(side(image), -side(p), tol, "signed distance to the axis");
        assertClose(along(image), along(p), tol, "position along the axis");
      }),
    );
  });

  it("deg 90 is a left↔right flip, deg 0 a top↔bottom flip", () => {
    fc.assert(
      fc.property(smallVec2, vec2, (c, p) => {
        const tol = 1e-9 * scaleOf(c, p);
        assertVecClose(at(affineReflect(90, c), p), [2 * c[0] - p[0], p[1]], tol, "vertical axis");
        assertVecClose(at(affineReflect(0, c), p), [p[0], 2 * c[1] - p[1]], tol, "horizontal axis");
      }),
    );
  });
});

describe("repeat — tables and bounds (properties)", () => {
  it("transformAnchorTable maps every anchor and handle, and keeps the bookkeeping", () => {
    fc.assert(
      fc.property(canonicalTable, placementMatrix, (table, m) => {
        const out = transformAnchorTable(table, m);
        expect(out.subpathStarts).toEqual(table.subpathStarts);
        expect(out.subpathOpen).toEqual(table.subpathOpen);
        expect(out.subpathStarts).not.toBe(table.subpathStarts);
        out.anchors.forEach((a, i) => {
          for (const key of ["anchor", "left", "right"] as const) {
            assertVecClose(a[key], at(m, table.anchors[i][key]), 0, `anchors[${i}].${key}`);
          }
        });
      }),
    );
  });

  it("transforming twice is transforming once by the composition", () => {
    fc.assert(
      fc.property(canonicalTable, placementMatrix, placementMatrix, (table, first, second) => {
        const stepwise = transformAnchorTable(transformAnchorTable(table, first), second);
        const composed = transformAnchorTable(table, composeAffine(second, first));
        stepwise.anchors.forEach((a, i) => {
          for (const key of ["anchor", "left", "right"] as const) {
            assertVecClose(a[key], composed.anchors[i][key], 1e-6, `anchors[${i}].${key}`);
          }
        });
      }),
    );
  });

  it("transformBounds is the TIGHT axis-aligned box of the four mapped corners", () => {
    fc.assert(
      fc.property(bounds, placementMatrix, (b, m) => {
        const [top, left, bottom, right] = transformBounds(b, m);
        const source: Vec2[] = [
          [b[1], b[0]],
          [b[3], b[0]],
          [b[3], b[2]],
          [b[1], b[2]],
        ];
        const corners = source.map((c) => at(m, c));
        expect(top).toBe(Math.min(...corners.map((c) => c[1])));
        expect(bottom).toBe(Math.max(...corners.map((c) => c[1])));
        expect(left).toBe(Math.min(...corners.map((c) => c[0])));
        expect(right).toBe(Math.max(...corners.map((c) => c[0])));
        // …which is the box of the clip rect built from the same bounds.
        const rect = transformAnchorTable(rectAnchorTable(b), m);
        expect(Math.min(...rect.anchors.map((a) => a.anchor[0]))).toBe(left);
        expect(Math.max(...rect.anchors.map((a) => a.anchor[1]))).toBe(bottom);
      }),
    );
  });

  it("an isometry keeps a box's centre in step and never shrinks its box below the source's shorter side", () => {
    fc.assert(
      fc.property(bounds, placementMatrix, (b, m) => {
        const moved = transformBounds(b, m);
        const tol = 1e-9 * Math.max(1, ...b.map(Math.abs), ...moved.map(Math.abs));
        assertVecClose(boundsCenter(moved), at(m, boundsCenter(b)), tol, "centre");
        const shorter = Math.min(b[2] - b[0], b[3] - b[1]);
        assertTrue(
          moved[2] - moved[0] >= shorter - tol && moved[3] - moved[1] >= shorter - tol,
          "a rotated box is smaller than the source",
        );
      }),
    );
  });

  it("rectAnchorTable is the closed corner rectangle of its bounds", () => {
    fc.assert(
      fc.property(bounds, (b) => {
        const t = rectAnchorTable(b);
        expect(t.subpathStarts).toEqual([0]);
        expect(t.subpathOpen).toEqual([false]);
        expect(t.anchors.map((a) => a.anchor)).toEqual([
          [b[1], b[0]],
          [b[3], b[0]],
          [b[3], b[2]],
          [b[1], b[2]],
        ]);
        for (const a of t.anchors) {
          expect(a.left).toEqual(a.anchor);
          expect(a.right).toEqual(a.anchor);
        }
      }),
    );
  });
});

describe("repeat — radial (properties)", () => {
  const sweepDeg = fc.oneof(
    fc.constantFrom(360, 180, 90, 270, -360, 720),
    real(-400, 400),
  );

  it("a closed ring divides its sweep by the count; a partial arc by count − 1", () => {
    fc.assert(
      fc.property(count, sweepDeg, (n, sweep) => {
        const step = radialStepDeg(n, sweep);
        if (n < 2) {
          expect(step).toBe(0);
        } else if (Math.abs(sweep) >= 360) {
          assertClose(step * n, sweep, 1e-9 * Math.abs(sweep), "n steps");
        } else {
          assertClose(step * (n - 1), sweep, 1e-9 * Math.max(1, Math.abs(sweep)), "n − 1 steps");
        }
      }),
    );
  });

  it("radialCenterFor is the inverse of radialPointAt: the source stays where it is", () => {
    fc.assert(
      fc.property(vec2, radiusPt, angleDeg, (source, r, start) => {
        const center = radialCenterFor(source, r, start);
        assertVecClose(radialPointAt(center, r, start), source, 1e-9 * scaleOf(source, [r, r]));
        assertClose(dist(center, source), r, 1e-9 * scaleOf(source, [r, r]), "radius");
      }),
    );
  });

  it("places `count` instances: the source untouched, instance k on the ring k steps on — rotated or not", () => {
    fc.assert(
      fc.property(count, radiusPt, angleDeg, sweepDeg, smallVec2, fc.boolean(), (n, r, start, sweep, source, rotate) => {
        const center = radialCenterFor(source, r, start);
        const placements = radialPlacements({
          count: n,
          radiusPt: r,
          startDeg: start,
          sweepDeg: sweep,
          rotateInstances: rotate,
          center,
        });
        expect(placements).toHaveLength(n);
        expect(placements[0]).toEqual({ index: 0, col: 0, row: 0, matrix: [1, 0, 0, 1, 0, 0] });
        const step = radialStepDeg(n, sweep);
        const tol = 1e-9 * scaleOf(source, center, [r, r]);
        placements.forEach((p, k) => {
          expect([p.index, p.col, p.row]).toEqual([k, k, 0]);
          // Where the SOURCE'S CENTRE lands is the same in both modes.
          assertVecClose(
            at(p.matrix, source),
            radialPointAt(center, r, start + k * step),
            tol,
            `instance ${k}`,
          );
          if (k === 0) return;
          if (rotate) {
            assertVecClose(at(p.matrix, center), center, tol, `instance ${k} ring centre`);
            assertClose(det(p.matrix), 1, 1e-12);
          } else {
            expect(p.matrix.slice(0, 4)).toEqual([1, 0, 0, 1]);
          }
        });
      }),
    );
  });

  it("rounds a fractional count and never places fewer than the source", () => {
    fc.assert(
      fc.property(real(-5, 12), (n) => {
        const placements = radialPlacements({
          count: n,
          radiusPt: 50,
          startDeg: 0,
          sweepDeg: 360,
          rotateInstances: true,
          center: [0, 0],
        });
        expect(placements).toHaveLength(Math.max(1, Math.round(n)));
      }),
    );
  });
});

describe("repeat — grid (properties)", () => {
  const cells = fc.integer({ min: 1, max: 8 });
  const stepPt = real(-300, 300);

  it("is columns × rows placements in row-major order, each carrying the cell centre to its own cell", () => {
    fc.assert(
      fc.property(cells, cells, stepPt, stepPt, fc.boolean(), fc.boolean(), smallVec2, (columns, rows, stepX, stepY, flipColumns, flipRows, cellCenter) => {
        const placements = gridPlacements({
          columns,
          rows,
          stepX,
          stepY,
          flipColumns,
          flipRows,
          cellCenter,
        });
        expect(placements).toHaveLength(columns * rows);
        placements.forEach((p, i) => {
          const col = i % columns;
          const row = Math.floor(i / columns);
          expect([p.index, p.col, p.row]).toEqual([i, col, row]);
          // A flip is about the DESTINATION cell's centre, so the centre
          // itself lands on the plain lattice point regardless.
          assertVecClose(
            at(p.matrix, cellCenter),
            [cellCenter[0] + col * stepX, cellCenter[1] + row * stepY],
            1e-9 * scaleOf(cellCenter, [col * stepX, row * stepY]),
            `cell (${col}, ${row})`,
          );
          const flips = (flipColumns && col % 2 === 1 ? 1 : 0) + (flipRows && row % 2 === 1 ? 1 : 0);
          assertClose(det(p.matrix), flips === 1 ? -1 : 1, 1e-12, `cell (${col}, ${row}) orientation`);
        });
        assertVecClose(at(placements[0].matrix, [7, -3]), [7, -3], 0, "the source cell");
      }),
    );
  });

  it("a column flip mirrors left↔right about the cell centre, a row flip top↔bottom", () => {
    fc.assert(
      fc.property(stepPt, stepPt, smallVec2, smallVec2, (stepX, stepY, cellCenter, offset) => {
        const placements = gridPlacements({
          columns: 2,
          rows: 2,
          stepX,
          stepY,
          flipColumns: true,
          flipRows: true,
          cellCenter,
        });
        const p: Vec2 = [cellCenter[0] + offset[0], cellCenter[1] + offset[1]];
        const tol = 1e-9 * scaleOf(cellCenter, offset, [stepX, stepY]);
        const expected = (col: number, row: number): Vec2 => [
          cellCenter[0] + col * stepX + (col === 1 ? -offset[0] : offset[0]),
          cellCenter[1] + row * stepY + (row === 1 ? -offset[1] : offset[1]),
        ];
        placements.forEach((pl) => {
          assertVecClose(at(pl.matrix, p), expected(pl.col, pl.row), tol, `cell (${pl.col}, ${pl.row})`);
        });
      }),
    );
  });
});

describe("repeat — mirror (properties)", () => {
  it("is the source plus ONE reflection, and reflecting twice is the source again", () => {
    fc.assert(
      fc.property(angleDeg, smallVec2, vec2, (angle, origin, p) => {
        const placements = mirrorPlacements({ angleDeg: angle, origin });
        expect(placements).toHaveLength(2);
        expect(placements[0]).toEqual({ index: 0, col: 0, row: 0, matrix: [1, 0, 0, 1, 0, 0] });
        expect([placements[1].index, placements[1].col, placements[1].row]).toEqual([1, 1, 0]);
        const m = placements[1].matrix;
        assertVecClose(at(m, at(m, p)), p, 1e-9 * scaleOf(origin, p));
        assertVecClose(at(m, origin), origin, 1e-9 * scaleOf(origin));
      }),
    );
  });

  it("the axis normal is a unit vector square to the axis: right for a vertical axis, up for a horizontal one", () => {
    fc.assert(
      fc.property(angleDeg, (angle) => {
        const n = mirrorAxisNormal(angle);
        assertClose(Math.hypot(n[0], n[1]), 1, 1e-12, "length");
        assertClose(n[0] * Math.cos(angle * DEG) + n[1] * Math.sin(angle * DEG), 0, 1e-12, "dot with the axis");
      }),
    );
    assertVecClose(mirrorAxisNormal(90), [1, 0], 1e-12);
    assertVecClose(mirrorAxisNormal(0), [0, -1], 1e-12);
  });

  it("an axis `offset` off the centre throws the mirror image 2·offset along the normal", () => {
    fc.assert(
      fc.property(angleDeg, smallVec2, real(-300, 300), (angle, center, offset) => {
        const origin = mirrorOriginFor(center, angle, offset);
        const n = mirrorAxisNormal(angle);
        const image = at(mirrorPlacements({ angleDeg: angle, origin })[1].matrix, center);
        assertVecClose(
          image,
          [center[0] + 2 * offset * n[0], center[1] + 2 * offset * n[1]],
          1e-9 * scaleOf(center, [offset, offset]),
        );
      }),
    );
  });
});

describe("repeat — the artboard fit and the extent (properties)", () => {
  const placements: fc.Arbitrary<RepeatPlacement[]> = fc
    .array(placementMatrix, { maxLength: 8 })
    .map((ms) => [
      { index: 0, col: 0, row: 0, matrix: [1, 0, 0, 1, 0, 0] as Affine },
      ...ms.map((matrix, i) => ({ index: i + 1, col: i + 1, row: 0, matrix })),
    ]);
  const page = fc.record({
    width: real(10, 1000),
    height: real(10, 1000),
  });

  it("splits the placements: nothing lost, nothing doubled, the source always kept", () => {
    fc.assert(
      fc.property(placements, bounds, page, (ps, b, pg) => {
        const { placed, dropped } = fitPlacementsToPage(ps, b, pg);
        expect([...placed, ...dropped].map((p) => p.index).sort((x, y) => x - y)).toEqual(
          ps.map((p) => p.index),
        );
        expect(placed.some((p) => p.index === 0)).toBe(true);
        const inside = (p: RepeatPlacement): boolean => {
          const [top, left, bottom, right] = transformBounds(b, p.matrix);
          return left >= 0 && top >= 0 && right <= pg.width && bottom <= pg.height;
        };
        for (const p of placed) if (p.index !== 0) assertTrue(inside(p), `placed ${p.index} is off the page`);
        for (const p of dropped) assertTrue(!inside(p), `dropped ${p.index} was on the page`);
      }),
    );
  });

  it("an unreadable page keeps everything", () => {
    fc.assert(
      fc.property(placements, bounds, (ps, b) => {
        expect(fitPlacementsToPage(ps, b, null)).toEqual({ placed: ps, dropped: [] });
      }),
    );
  });

  it("the extent is the union of every instance's box, and the source box alone when there is nothing else", () => {
    fc.assert(
      fc.property(placements, bounds, (ps, b) => {
        const [top, left, bottom, right] = repeatExtent(ps, b);
        const boxes = ps.map((p) => transformBounds(b, p.matrix));
        expect(top).toBe(Math.min(...boxes.map((x) => x[0])));
        expect(left).toBe(Math.min(...boxes.map((x) => x[1])));
        expect(bottom).toBe(Math.max(...boxes.map((x) => x[2])));
        expect(right).toBe(Math.max(...boxes.map((x) => x[3])));
        expect(repeatExtent([], b)).toEqual(b);
        expect(repeatExtent(ps.slice(0, 1), b)).toEqual(b);
      }),
    );
  });
});
