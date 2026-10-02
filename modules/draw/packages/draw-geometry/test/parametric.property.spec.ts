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

// Property tests for parametric.ts — the insert-shape generators.

import { describe, expect, it } from "vitest";

import {
  arcPath,
  flattenAnchorRun,
  isCornerAnchor,
  polarGridPaths,
  rectGridPaths,
  spiralPath,
  type AnchorTable,
  type Vec2,
} from "../src";
import {
  angleRad,
  assertClose,
  assertTrue,
  assertVecClose,
  fc,
  real,
  smallVec2,
} from "./property-kit";

const radius = real(0.5, 300);
const TAU = 2 * Math.PI;
const EMPTY: AnchorTable = { anchors: [], subpathStarts: [], subpathOpen: [] };

/** A signed sweep clear of 0 and of the quarter-turn multiples where the
 *  slice count steps. */
const sweep = fc
  .tuple(real(0.05, 3 * TAU), fc.boolean())
  .map(([m, neg]) => (neg ? -m : m))
  .filter((s) => {
    const quarters = Math.min(Math.abs(s), TAU) / (Math.PI / 2);
    return Math.abs(quarters - Math.round(quarters)) > 0.02 || Math.abs(s) > TAU;
  });

const bad = fc.constantFrom(Number.NaN, Infinity, -Infinity);

describe("parametric — arcPath (properties)", () => {
  it("starts at the start angle, ends a (clamped) sweep later, and every anchor is ON the ellipse", () => {
    fc.assert(
      fc.property(smallVec2, radius, radius, angleRad, sweep, fc.boolean(), (c, rx, ry, start, sw, closed) => {
        const t = arcPath(c[0], c[1], rx, ry, start, sw, closed);
        const clamped = Math.sign(sw) * Math.min(Math.abs(sw), TAU);
        const at = (th: number): Vec2 => [c[0] + rx * Math.cos(th), c[1] + ry * Math.sin(th)];
        const tol = 1e-9 * Math.max(1, rx, ry, Math.abs(c[0]), Math.abs(c[1]));
        expect(t.subpathStarts).toEqual([0]);
        expect(t.subpathOpen).toEqual([!closed]);
        expect(t.anchors).toHaveLength(Math.ceil(Math.abs(clamped) / (Math.PI / 2)) + 1);
        assertVecClose(t.anchors[0].anchor, at(start), tol, "first anchor");
        assertVecClose(t.anchors[t.anchors.length - 1].anchor, at(start + clamped), tol, "last anchor");
        for (const a of t.anchors) {
          assertClose(
            Math.hypot((a.anchor[0] - c[0]) / rx, (a.anchor[1] - c[1]) / ry),
            1,
            1e-9,
            "anchor radial ratio",
          );
        }
      }),
    );
  });

  it("follows the ellipse between its anchors (to the κ error) and turns the way the sweep's sign says", () => {
    fc.assert(
      fc.property(smallVec2, radius, radius, angleRad, sweep, (c, rx, ry, start, sw) => {
        const t = arcPath(c[0], c[1], rx, ry, start, sw);
        const clamped = Math.sign(sw) * Math.min(Math.abs(sw), TAU);
        const n = t.anchors.length - 1;
        for (const p of flattenAnchorRun(t.anchors, { samplesPerSegment: 8 })) {
          assertClose(Math.hypot((p[0] - c[0]) / rx, (p[1] - c[1]) / ry), 1, 3e-4, "radial ratio");
        }
        // Slice midpoints, against the ellipse at the middle angle.
        for (let i = 0; i < n; i++) {
          const a = t.anchors[i];
          const b = t.anchors[i + 1];
          const mid: Vec2 = [
            (a.anchor[0] + 3 * a.right[0] + 3 * b.left[0] + b.anchor[0]) / 8,
            (a.anchor[1] + 3 * a.right[1] + 3 * b.left[1] + b.anchor[1]) / 8,
          ];
          const th = start + ((i + 0.5) * clamped) / n;
          assertVecClose(
            mid,
            [c[0] + rx * Math.cos(th), c[1] + ry * Math.sin(th)],
            3e-4 * Math.max(rx, ry),
            `slice ${i} midpoint`,
          );
        }
      }),
    );
  });

  it("its two ends are corners outward; its interior anchors are smooth", () => {
    fc.assert(
      fc.property(smallVec2, radius, radius, angleRad, sweep, (c, rx, ry, start, sw) => {
        const { anchors } = arcPath(c[0], c[1], rx, ry, start, sw);
        const last = anchors.length - 1;
        expect(anchors[0].left).toEqual(anchors[0].anchor);
        expect(anchors[last].right).toEqual(anchors[last].anchor);
        const tol = 1e-9 * Math.max(1, rx, ry, Math.abs(c[0]), Math.abs(c[1]));
        for (let i = 1; i < last; i++) {
          const a = anchors[i];
          assertVecClose(
            a.left,
            [2 * a.anchor[0] - a.right[0], 2 * a.anchor[1] - a.right[1]],
            tol,
            `anchor ${i} handles`,
          );
        }
      }),
    );
  });

  it("a sweep of a full turn or more closes onto its own start", () => {
    fc.assert(
      fc.property(smallVec2, radius, radius, angleRad, real(TAU, 5 * TAU), fc.boolean(), (c, rx, ry, start, m, neg) => {
        const { anchors } = arcPath(c[0], c[1], rx, ry, start, neg ? -m : m);
        expect(anchors).toHaveLength(5);
        assertVecClose(
          anchors[4].anchor,
          anchors[0].anchor,
          1e-9 * Math.max(1, rx, ry, Math.abs(c[0]), Math.abs(c[1])),
        );
      }),
    );
  });

  it("degenerate input is an empty table, never a throw", () => {
    const nonPositive = real(-50, 0);
    fc.assert(
      fc.property(smallVec2, radius, angleRad, sweep, nonPositive, bad, (c, r, start, sw, zero, nan) => {
        expect(arcPath(c[0], c[1], zero, r, start, sw)).toEqual(EMPTY);
        expect(arcPath(c[0], c[1], r, zero, start, sw)).toEqual(EMPTY);
        expect(arcPath(c[0], c[1], r, r, start, 0)).toEqual(EMPTY);
        expect(arcPath(nan, c[1], r, r, start, sw)).toEqual(EMPTY);
        expect(arcPath(c[0], c[1], r, nan, start, sw)).toEqual(EMPTY);
        expect(arcPath(c[0], c[1], r, r, nan, sw)).toEqual(EMPTY);
        expect(arcPath(c[0], c[1], r, r, start, nan)).toEqual(EMPTY);
      }),
    );
  });
});

describe("parametric — spiralPath (properties)", () => {
  const decay = real(0.3, 3);
  const turns = real(0.25, 6);
  const perTurn = fc.integer({ min: 2, max: 24 });

  it("puts anchor i at angle i·2π/n and radius r0·decay^(i/n)", () => {
    fc.assert(
      fc.property(smallVec2, radius, decay, turns, perTurn, (c, r0, d, tn, n) => {
        const t = spiralPath(c[0], c[1], r0, d, tn, n);
        expect(t.subpathStarts).toEqual([0]);
        expect(t.subpathOpen).toEqual([true]);
        expect(t.anchors).toHaveLength(Math.max(1, Math.round(tn * n)) + 1);
        t.anchors.forEach((a, i) => {
          const th = (i * TAU) / n;
          const r = r0 * Math.pow(d, i / n);
          assertVecClose(
            a.anchor,
            [c[0] + r * Math.cos(th), c[1] + r * Math.sin(th)],
            1e-9 * Math.max(1, r, Math.abs(c[0]), Math.abs(c[1])),
            `anchor ${i}`,
          );
        });
      }),
    );
  });

  it("is smooth through every interior anchor and a corner at both ends", () => {
    fc.assert(
      fc.property(smallVec2, radius, decay, turns, perTurn, (c, r0, d, tn, n) => {
        const { anchors } = spiralPath(c[0], c[1], r0, d, tn, n);
        const last = anchors.length - 1;
        expect(anchors[0].left).toEqual(anchors[0].anchor);
        expect(anchors[last].right).toEqual(anchors[last].anchor);
        for (let i = 1; i < last; i++) {
          const a = anchors[i];
          const r = Math.hypot(a.anchor[0] - c[0], a.anchor[1] - c[1]);
          assertVecClose(
            a.left,
            [2 * a.anchor[0] - a.right[0], 2 * a.anchor[1] - a.right[1]],
            1e-9 * Math.max(1, r, Math.abs(c[0]), Math.abs(c[1])),
            `anchor ${i} handles`,
          );
        }
      }),
    );
  });

  it("with decay 1 is a circle of radius r0, to the κ error", () => {
    fc.assert(
      fc.property(smallVec2, radius, turns, fc.integer({ min: 4, max: 24 }), (c, r0, tn, n) => {
        const { anchors } = spiralPath(c[0], c[1], r0, 1, tn, n);
        for (const p of flattenAnchorRun(anchors, { samplesPerSegment: 8 })) {
          assertClose(Math.hypot(p[0] - c[0], p[1] - c[1]) / r0, 1, 3e-4, "radius ratio");
        }
      }),
    );
  });

  it("between anchors stays within 1 % of the true spiral (8+ anchors per turn)", () => {
    // The handle rule is the arc rule with the spiral's own tangent. For
    // a moderately tight spiral (radius changing by at most ×2 per turn)
    // at 8 or more anchors per turn, the cubic's midpoint is within 1 %
    // of the radius of the analytic spiral at the middle angle.
    fc.assert(
      fc.property(
        radius,
        real(0.5, 2),
        fc.integer({ min: 8, max: 24 }),
        (r0, d, n) => {
          const { anchors } = spiralPath(0, 0, r0, d, 2, n);
          for (let i = 0; i + 1 < anchors.length; i++) {
            const a = anchors[i];
            const b = anchors[i + 1];
            const mid: Vec2 = [
              (a.anchor[0] + 3 * a.right[0] + 3 * b.left[0] + b.anchor[0]) / 8,
              (a.anchor[1] + 3 * a.right[1] + 3 * b.left[1] + b.anchor[1]) / 8,
            ];
            const th = ((i + 0.5) * TAU) / n;
            const r = r0 * Math.pow(d, (i + 0.5) / n);
            assertVecClose(mid, [r * Math.cos(th), r * Math.sin(th)], 0.01 * r, `segment ${i}`);
          }
        },
      ),
    );
  });

  it("degenerate input is an empty table, never a throw", () => {
    const nonPositive = real(-50, 0);
    fc.assert(
      fc.property(radius, nonPositive, bad, (r, zero, nan) => {
        expect(spiralPath(0, 0, zero, 0.8, 3, 8)).toEqual(EMPTY);
        expect(spiralPath(0, 0, r, zero, 3, 8)).toEqual(EMPTY);
        expect(spiralPath(0, 0, r, 0.8, zero, 8)).toEqual(EMPTY);
        expect(spiralPath(0, 0, r, 0.8, 3, 1)).toEqual(EMPTY);
        expect(spiralPath(nan, 0, r, 0.8, 3, 8)).toEqual(EMPTY);
        expect(spiralPath(0, 0, r, nan, 3, 8)).toEqual(EMPTY);
        expect(spiralPath(0, 0, r, 0.8, nan, 8)).toEqual(EMPTY);
      }),
    );
  });
});

describe("parametric — rectGridPaths (properties)", () => {
  const box = fc
    .tuple(
      fc.integer({ min: -200, max: 200 }),
      fc.integer({ min: -200, max: 200 }),
      real(1, 400),
      real(1, 400),
    )
    .map(([top, left, h, w]) => [top, left, top + h, left + w] as [number, number, number, number]);
  const cells = fc.integer({ min: 1, max: 12 });

  it("is rows+1 horizontal lines then cols+1 vertical ones, evenly spaced, border included", () => {
    fc.assert(
      fc.property(box, cells, cells, (bounds, rows, cols) => {
        const [top, left, bottom, right] = bounds;
        const lines = rectGridPaths(bounds, rows, cols);
        expect(lines).toHaveLength(rows + 1 + cols + 1);
        const tol = 1e-9 * Math.max(1, ...bounds.map(Math.abs));
        lines.forEach((line, k) => {
          expect(line.anchors).toHaveLength(2);
          expect(line.subpathOpen).toEqual([true]);
          for (const a of line.anchors) assertTrue(isCornerAnchor(a), "a grid line has handles");
          const [p, q] = line.anchors.map((a) => a.anchor);
          if (k <= rows) {
            const y = top + ((bottom - top) * k) / rows;
            assertVecClose(p, [left, y], tol, `horizontal ${k} start`);
            assertVecClose(q, [right, y], tol, `horizontal ${k} end`);
          } else {
            const j = k - rows - 1;
            const x = left + ((right - left) * j) / cols;
            assertVecClose(p, [x, top], tol, `vertical ${j} start`);
            assertVecClose(q, [x, bottom], tol, `vertical ${j} end`);
          }
        });
      }),
    );
  });

  it("degenerate bounds or counts below 1 are an empty list", () => {
    fc.assert(
      fc.property(box, cells, real(-5, 0.99), bad, (bounds, n, few, nan) => {
        const [top, left, bottom, right] = bounds;
        expect(rectGridPaths(bounds, few, n)).toEqual([]);
        expect(rectGridPaths(bounds, n, few)).toEqual([]);
        expect(rectGridPaths([bottom, left, top, right], n, n)).toEqual([]);
        expect(rectGridPaths([top, right, bottom, left], n, n)).toEqual([]);
        expect(rectGridPaths([top, left, top, right], n, n)).toEqual([]);
        expect(rectGridPaths(bounds, nan, n)).toEqual([]);
        expect(rectGridPaths([nan, left, bottom, right], n, n)).toEqual([]);
      }),
    );
  });

  // ------------------------------------------------------------------
  // DEFECT (parametric.ts, rectGridPaths) — a NON-INTEGER row or column
  // count draws a grid with no closing border.
  //
  // The docstring promises the lines "INCLUDING the border". The loops
  // run `for (i = 0; i <= rows; i++)` over integer `i` and place line i
  // at `top + h·i/rows`. With rows = 2.5 that is i = 0, 1, 2 at 0, 0.4h,
  // 0.8h — the bottom edge is never reached. `polarGridPaths`, its
  // sibling, floors both of its counts first.
  //
  // Minimal counterexample: rectGridPaths([0, 0, 10, 10], 2.5, 2)
  //   EXPECTED: the last horizontal line at y = 10 (the bottom border).
  //   ACTUAL:   horizontals at y = 0, 4, 8 — the box is left open.
  //
  // Low severity TODAY: the one caller (draw-bundle insert-shapes) passes
  // integer defaults.
  // ------------------------------------------------------------------
  it.fails("DEFECT (minimal counterexample): a fractional row count still closes the border", () => {
    const lines = rectGridPaths([0, 0, 10, 10], 2.5, 2);
    const horizontals = lines.filter((l) => l.anchors[0].anchor[1] === l.anchors[1].anchor[1]);
    expect(Math.max(...horizontals.map((l) => l.anchors[0].anchor[1]))).toBe(10);
  });
});

describe("parametric — polarGridPaths (properties)", () => {
  const count = real(0, 12.9);

  it("is ⌊rings⌋ concentric circles (outermost = r) then ⌊radials⌋ spokes to the rim", () => {
    fc.assert(
      fc.property(smallVec2, radius, count, count, (c, r, rings, radials) => {
        const nRings = Math.floor(rings);
        const nRadials = Math.floor(radials);
        const out = polarGridPaths(c[0], c[1], r, rings, radials);
        if (nRings < 1 && nRadials < 1) {
          expect(out).toEqual([]);
          return;
        }
        expect(out).toHaveLength(nRings + nRadials);
        const tol = 1e-9 * Math.max(1, r, Math.abs(c[0]), Math.abs(c[1]));
        for (let i = 0; i < nRings; i++) {
          const ring = out[i];
          expect(ring.anchors).toHaveLength(4);
          expect(ring.subpathOpen).toEqual([false]);
          for (const a of ring.anchors) {
            assertClose(
              Math.hypot(a.anchor[0] - c[0], a.anchor[1] - c[1]),
              (r * (i + 1)) / nRings,
              tol,
              `ring ${i} radius`,
            );
          }
        }
        for (let j = 0; j < nRadials; j++) {
          const spoke = out[nRings + j];
          expect(spoke.subpathOpen).toEqual([true]);
          const th = (TAU * j) / nRadials;
          assertVecClose(spoke.anchors[0].anchor, c, 0, `spoke ${j} hub`);
          assertVecClose(
            spoke.anchors[1].anchor,
            [c[0] + r * Math.cos(th), c[1] + r * Math.sin(th)],
            tol,
            `spoke ${j} rim`,
          );
        }
      }),
    );
  });

  it("a non-positive radius or non-finite input is an empty list", () => {
    fc.assert(
      fc.property(real(-50, 0), bad, (zero, nan) => {
        expect(polarGridPaths(0, 0, zero, 3, 6)).toEqual([]);
        expect(polarGridPaths(0, 0, nan, 3, 6)).toEqual([]);
        expect(polarGridPaths(nan, 0, 10, 3, 6)).toEqual([]);
        expect(polarGridPaths(0, 0, 10, nan, 6)).toEqual([]);
        expect(polarGridPaths(0, 0, 10, 3, nan)).toEqual([]);
      }),
    );
  });
});
