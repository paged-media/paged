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

// Property tests for compound.ts — the contour algebra and the ONE
// winding implementation in this repo: `orientForNonZeroHoles`, the step
// that makes a nested contour a HOLE under the engine's NON-ZERO fill.
//
// The generator builds a random LAMINAR family of rectangles (every two
// are either disjoint or strictly nested), in random order, each wound
// either way and started at any corner. The references never cast a ray:
// nesting depth is counted from the rectangles' own coordinates, and the
// non-zero region is the angle-summation winding number.

import { describe, expect, it } from "vitest";

import {
  contourDepths,
  contourRanges,
  contourSignedArea,
  ellipseToPath,
  flattenAnchorRun,
  makeCompoundTable,
  mergeCompound,
  orientForNonZeroHoles,
  pointInAnchorPath,
  reverseContour,
  splitCompound,
  type AnchorTable,
  type AnchorTriple,
  type Vec2,
} from "../src";
import {
  anchorRun,
  assertClose,
  assertTableClose,
  assertTrue,
  cornerOf,
  fc,
  magnitude,
  real,
  refSignedArea,
  refWindingNumber,
  smallAnchorTriple,
} from "./property-kit";

// ------------------------------------------------- the nested-rect family

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Node {
  /** Fractions of the slot left free on each side: l, t, r, b. */
  inset: [number, number, number, number];
  /** Children are laid out in a row (false) or a column (true). */
  column: boolean;
  /** Wind the rectangle clockwise (y-down) or the other way. */
  clockwise: boolean;
  /** Which corner the contour STARTS at — `contourDepths` probes with a
   *  contour's first anchor, so this moves the probe around. */
  startCorner: number;
  /** Sort key: the contours are emitted in key order, not tree order. */
  order: number;
  children: Node[];
}

const insetFraction = real(0.05, 0.3);

const node: fc.Memo<Node> = fc.memo((depth) =>
  fc.record({
    inset: fc.tuple(insetFraction, insetFraction, insetFraction, insetFraction),
    column: fc.boolean(),
    clockwise: fc.boolean(),
    startCorner: fc.integer({ min: 0, max: 3 }),
    order: fc.integer({ min: 0, max: 1000 }),
    children:
      depth <= 1
        ? fc.constant([] as Node[])
        : fc.array(node(depth - 1), { maxLength: 3 }),
  }),
);

interface Placed {
  box: Box;
  node: Node;
}

/** Lay `nodes` out side by side in `slot`; every node's box is strictly
 *  inside its slot, every child's slot is inside its parent's box. */
function layout(nodes: readonly Node[], slot: Box, column: boolean, out: Placed[]): void {
  const n = nodes.length;
  nodes.forEach((nd, i) => {
    const sx0 = column ? slot.x0 : slot.x0 + ((slot.x1 - slot.x0) * i) / n;
    const sx1 = column ? slot.x1 : slot.x0 + ((slot.x1 - slot.x0) * (i + 1)) / n;
    const sy0 = column ? slot.y0 + ((slot.y1 - slot.y0) * i) / n : slot.y0;
    const sy1 = column ? slot.y0 + ((slot.y1 - slot.y0) * (i + 1)) / n : slot.y1;
    const w = sx1 - sx0;
    const h = sy1 - sy0;
    const box: Box = {
      x0: sx0 + nd.inset[0] * w,
      y0: sy0 + nd.inset[1] * h,
      x1: sx1 - nd.inset[2] * w,
      y1: sy1 - nd.inset[3] * h,
    };
    out.push({ box, node: nd });
    layout(nd.children, box, nd.column, out);
  });
}

function rectContour(box: Box, clockwise: boolean, startCorner: number): AnchorTriple[] {
  // TL, TR, BR, BL — clockwise on a y-down page (positive shoelace).
  const corners: Vec2[] = [
    [box.x0, box.y0],
    [box.x1, box.y0],
    [box.x1, box.y1],
    [box.x0, box.y1],
  ];
  const ring = clockwise ? corners : [...corners].reverse();
  const k = startCorner % 4;
  return [...ring.slice(k), ...ring.slice(0, k)].map(cornerOf);
}

interface Family {
  table: AnchorTable;
  boxes: Box[];
  /** Brute-force nesting depth: how many OTHER boxes strictly contain
   *  this one — read off the coordinates, no ray, no flattening. */
  depths: number[];
}

const PAGE: Box = { x0: 0, y0: 0, x1: 1000, y1: 800 };

const family: fc.Arbitrary<Family> = fc
  .array(node(3), { minLength: 1, maxLength: 3 })
  .map((roots) => {
    const placed: Placed[] = [];
    layout(roots, PAGE, false, placed);
    // Stable sort by the random key: tree order is NOT emission order.
    const ordered = placed
      .map((p, i) => ({ p, i }))
      .sort((a, b) => a.p.node.order - b.p.node.order || a.i - b.i)
      .map(({ p }) => p);
    const anchors: AnchorTriple[] = [];
    const subpathStarts: number[] = [];
    for (const { box, node: nd } of ordered) {
      subpathStarts.push(anchors.length);
      anchors.push(...rectContour(box, nd.clockwise, nd.startCorner));
    }
    const boxes = ordered.map((p) => p.box);
    const contains = (outer: Box, inner: Box): boolean =>
      outer.x0 < inner.x0 &&
      outer.y0 < inner.y0 &&
      outer.x1 > inner.x1 &&
      outer.y1 > inner.y1;
    const depths = boxes.map(
      (b, i) => boxes.filter((o, j) => j !== i && contains(o, b)).length,
    );
    return {
      table: { anchors, subpathStarts, subpathOpen: boxes.map(() => false) },
      boxes,
      depths,
    };
  });

const ringsOf = (table: AnchorTable): Vec2[][] =>
  contourRanges(table.anchors.length, table.subpathStarts).map(([from, to]) =>
    table.anchors.slice(from, to).map((a): Vec2 => a.anchor),
  );

const signsOf = (table: AnchorTable): number[] =>
  ringsOf(table).map((ring) => Math.sign(refSignedArea(ring)));

/** A probe inside the page that is clear of every rectangle's edges. */
const probe = fc.tuple(
  real(0, 1000),
  real(0, 800),
);
const clearOf = (p: Vec2, boxes: readonly Box[]): boolean =>
  boxes.every(
    (b) =>
      Math.min(
        Math.abs(p[0] - b.x0),
        Math.abs(p[0] - b.x1),
        Math.abs(p[1] - b.y0),
        Math.abs(p[1] - b.y1),
      ) > 1e-6,
  );

// ------------------------------------------------------------ properties

describe("compound — contourDepths (properties)", () => {
  it("agrees with brute-force containment on nested rectangles", () => {
    fc.assert(
      fc.property(family, ({ table, depths }) => {
        expect(contourDepths(table)).toEqual(depths);
      }),
    );
  });

  it("does not depend on how the contours are wound", () => {
    fc.assert(
      fc.property(family, ({ table }) => {
        const flipped = mergeCompound(
          splitCompound(table).map((t) => ({
            ...t,
            anchors: reverseContour(t.anchors),
          })),
        );
        expect(contourDepths(flipped)).toEqual(contourDepths(table));
      }),
    );
  });

  it("counts concentric ellipses (curved contours) by size, in any order", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 20 }), {
          minLength: 1,
          maxLength: 6,
        }),
        real(5, 40),
        real(5, 40),
        (sizes, rx, ry) => {
          // Scale factors are distinct integers, so consecutive rings are
          // at least 5 % apart — far more than the κ / flattening error.
          const table = mergeCompound(
            sizes.map((k) => ellipseToPath(100, 100, rx * k, ry * k)),
          );
          expect(contourDepths(table)).toEqual(
            sizes.map((k) => sizes.filter((other) => other > k).length),
          );
        },
      ),
    );
  });
});

describe("compound — orientForNonZeroHoles (properties)", () => {
  it("winds the contours in ALTERNATING orientation by nesting depth", () => {
    fc.assert(
      fc.property(family, ({ table, depths }) => {
        const signs = signsOf(orientForNonZeroHoles(table));
        for (let i = 0; i < signs.length; i++) {
          assertTrue(signs[i] !== 0, `contour ${i} has no orientation`);
          const sameParity = (depths[i] - depths[0]) % 2 === 0;
          assertTrue(
            signs[i] === (sameParity ? signs[0] : -signs[0]),
            `contour ${i} (depth ${depths[i]}) winds ${signs[i]}, ` +
              `contour 0 (depth ${depths[0]}) winds ${signs[0]}`,
          );
        }
      }),
    );
  });

  it("makes the engine's NON-ZERO fill paint exactly the even-odd region", () => {
    // The purpose of the function, stated on the fill itself: after the
    // re-winding, the total winding number at any point is ±1 where the
    // even-odd rule says inside and 0 where it says outside — never ±2,
    // which is what a same-wound nested pair produces (the coin instead
    // of the doughnut).
    fc.assert(
      fc.property(family, probe, ({ table, boxes }, p) => {
        fc.pre(clearOf(p, boxes));
        const oriented = orientForNonZeroHoles(table);
        const winding = ringsOf(oriented).reduce(
          (sum, ring) => sum + refWindingNumber(p, ring),
          0,
        );
        const evenOdd = boxes.filter(
          (b) => p[0] > b.x0 && p[0] < b.x1 && p[1] > b.y0 && p[1] < b.y1,
        ).length % 2 === 1;
        assertTrue(
          Math.abs(winding) <= 1,
          `winding ${winding} at [${p[0]}, ${p[1]}] — a nested pair is wound the same way`,
        );
        expect(winding !== 0).toBe(evenOdd);
        // And the kernel's own even-odd test agrees with the count.
        expect(pointInAnchorPath(p, table.anchors, table.subpathStarts)).toBe(
          evenOdd,
        );
      }),
    );
  });

  it("is idempotent when contour 0 is an OUTER (even-depth) contour", () => {
    fc.assert(
      fc.property(family, ({ table, depths }) => {
        fc.pre(depths[0] % 2 === 0);
        const once = orientForNonZeroHoles(table);
        expect(orientForNonZeroHoles(once)).toEqual(once);
      }),
    );
  });

  it("keeps every contour's anchors, start point and bookkeeping — only direction changes", () => {
    fc.assert(
      fc.property(family, ({ table }) => {
        const oriented = orientForNonZeroHoles(table);
        expect(oriented.anchors).toHaveLength(table.anchors.length);
        if (table.subpathStarts.length > 1) {
          expect(oriented.subpathStarts).toEqual(table.subpathStarts);
          expect(oriented.subpathOpen).toEqual(table.subpathOpen);
        }
        const before = ringsOf(table);
        const after = ringsOf(oriented);
        before.forEach((ring, i) => {
          // A closed contour is reversed about its FIRST anchor.
          expect(after[i][0]).toEqual(ring[0]);
          const key = (r: Vec2[]) => r.map((v) => `${v[0]},${v[1]}`).sort();
          expect(key(after[i])).toEqual(key(ring));
        });
      }),
    );
  });

  it("leaves contour 0 exactly as authored when it is an OUTER (even-depth) contour", () => {
    fc.assert(
      fc.property(family, ({ table, depths }) => {
        fc.pre(depths[0] % 2 === 0);
        const oriented = orientForNonZeroHoles(table);
        const end = table.subpathStarts[1] ?? table.anchors.length;
        expect(oriented.anchors.slice(0, end)).toEqual(table.anchors.slice(0, end));
      }),
    );
  });

  // ------------------------------------------------------------------
  // DEFECT (compound.ts, orientForNonZeroHoles) — when contour 0 is
  // itself a HOLE it is flipped, and the function is no longer
  // idempotent: every further call reverses EVERY contour.
  //
  // The docstring promises "Contour 0 is the anchor of the convention and
  // is never flipped — the survivor of a 'make compound path' keeps its
  // own authored direction, so a caller that cached its anchor order does
  // not get a surprise", and `splitCompound` promises that windings are
  // kept "which is what makes make→release→make stable". compound.spec.ts
  // tests both titles — but only ever with the OUTER contour first.
  //
  // The code takes `base = sign(area of contour 0)` and wants
  // `depths[i] % 2 === 0 ? base : -base`. When contour 0 sits at an ODD
  // depth its own `want` is `-base` — the opposite of what it has — so it
  // is reversed. On the next call `base` is therefore negated, and every
  // contour's `want` with it: the whole table flips again, forever.
  // (`base` has to be contour 0's sign CORRECTED for contour 0's depth
  // parity.)
  //
  // Minimal counterexample: the two squares of compound.spec.ts in the
  // OTHER order, both authored clockwise —
  //   contour 0 = INNER (200,200)-(300,300), contour 1 = OUTER
  //   (100,100)-(400,400).
  //   EXPECTED: contour 0 comes back as authored,
  //             [(200,200), (300,200), (300,300), (200,300)],
  //             and orient(orient(t)) equals orient(t).
  //   ACTUAL:   contour 0 is [(200,200), (200,300), (300,300), (300,200)];
  //             a second call reverses BOTH contours again.
  //
  // The FILL is right after every call (the pair always alternates — the
  // properties above hold for every order). What breaks is the stated
  // contract: with the hole first in the selection, the survivor's anchor
  // order is reversed, and each make→release→make cycle reverses every
  // contour of the compound path once more — anchor indices a caller
  // cached are stale after each one.
  // ------------------------------------------------------------------
  const HOLE_FIRST: AnchorTable = {
    anchors: [
      ...rectContour({ x0: 200, y0: 200, x1: 300, y1: 300 }, true, 0),
      ...rectContour({ x0: 100, y0: 100, x1: 400, y1: 400 }, true, 0),
    ],
    subpathStarts: [0, 4],
    subpathOpen: [false, false],
  };

  it("(the defect's setup) contour 0 of HOLE_FIRST is the hole", () => {
    expect(contourDepths(HOLE_FIRST)).toEqual([1, 0]);
  });

  it.fails("DEFECT (minimal counterexample): contour 0 keeps its authored direction when it is the hole", () => {
    expect(orientForNonZeroHoles(HOLE_FIRST).anchors.slice(0, 4)).toEqual(
      HOLE_FIRST.anchors.slice(0, 4),
    );
  });

  it.fails("DEFECT (minimal counterexample): orienting twice is orienting once when contour 0 is the hole", () => {
    const once = orientForNonZeroHoles(HOLE_FIRST);
    expect(orientForNonZeroHoles(once)).toEqual(once);
  });

  it.fails("DEFECT: make → release → make is stable for any contour order", () => {
    fc.assert(
      fc.property(family, ({ table }) => {
        const made = makeCompoundTable(splitCompound(table));
        expect(makeCompoundTable(splitCompound(made))).toEqual(made);
      }),
    );
  });

  it.fails("DEFECT: contour 0 is never flipped, at any depth", () => {
    fc.assert(
      fc.property(family, ({ table }) => {
        const oriented = orientForNonZeroHoles(table);
        const end = table.subpathStarts[1] ?? table.anchors.length;
        expect(oriented.anchors.slice(0, end)).toEqual(table.anchors.slice(0, end));
      }),
    );
  });
});

describe("compound — contourSignedArea / reverseContour (properties)", () => {
  it("a rectangle's signed area is ±(width · height), by direction", () => {
    fc.assert(
      fc.property(family, ({ table, boxes }) => {
        const ranges = contourRanges(table.anchors.length, table.subpathStarts);
        ranges.forEach(([from, to], i) => {
          const b = boxes[i];
          const area = contourSignedArea(table.anchors.slice(from, to));
          const expected = (b.x1 - b.x0) * (b.y1 - b.y0);
          assertClose(Math.abs(area), expected, 1e-9 * expected + 1e-9, "|area|");
        });
      }),
    );
  });

  it("is the shoelace area of the contour's own flattening", () => {
    fc.assert(
      fc.property(anchorRun(2, 6, smallAnchorTriple), (anchors) => {
        const ring = flattenAnchorRun(anchors, { close: true });
        // `flattenAnchorRun(close)` repeats the start point at the end; the
        // reference closes the ring itself, and a repeated vertex adds 0.
        assertClose(
          contourSignedArea(anchors),
          refSignedArea(ring),
          1e-9 * magnitude(...ring) ** 2,
        );
      }),
    );
  });

  it("reversing a contour negates its signed area", () => {
    fc.assert(
      fc.property(anchorRun(2, 6, smallAnchorTriple), (anchors) => {
        assertClose(
          contourSignedArea(reverseContour(anchors)),
          -contourSignedArea(anchors),
          1e-9 * magnitude(...anchors.flatMap((a) => [a.anchor, a.left, a.right])) ** 2,
        );
      }),
    );
  });

  it("reverseContour is an involution, closed and open", () => {
    fc.assert(
      fc.property(anchorRun(0, 8), fc.boolean(), (anchors, closed) => {
        expect(
          reverseContour(reverseContour(anchors, { closed }), { closed }),
        ).toEqual(anchors);
      }),
    );
  });

  it("a CLOSED reversal keeps the first anchor first; an OPEN one swaps the ends; both swap the handles", () => {
    fc.assert(
      fc.property(anchorRun(1, 8), (anchors) => {
        const n = anchors.length;
        const closed = reverseContour(anchors);
        const open = reverseContour(anchors, { closed: false });
        expect(closed).toHaveLength(n);
        expect(open).toHaveLength(n);
        expect(closed[0].anchor).toEqual(anchors[0].anchor);
        expect(open[0].anchor).toEqual(anchors[n - 1].anchor);
        expect(open[n - 1].anchor).toEqual(anchors[0].anchor);
        for (let i = 0; i < n; i++) {
          const fromClosed = anchors[(n - i) % n];
          expect(closed[i]).toEqual({
            anchor: fromClosed.anchor,
            left: fromClosed.right,
            right: fromClosed.left,
          });
          const fromOpen = anchors[n - 1 - i];
          expect(open[i]).toEqual({
            anchor: fromOpen.anchor,
            left: fromOpen.right,
            right: fromOpen.left,
          });
        }
      }),
    );
  });

  it("a closed reversal traces the SAME curve, backwards", () => {
    fc.assert(
      fc.property(anchorRun(1, 6, smallAnchorTriple), (anchors) => {
        const forward = flattenAnchorRun(anchors, { close: true });
        const backward = flattenAnchorRun(reverseContour(anchors), { close: true });
        expect(backward).toHaveLength(forward.length);
        const tol = 1e-9 * magnitude(...forward);
        forward.forEach((p, i) => {
          const q = backward[forward.length - 1 - i];
          assertTrue(
            Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol,
            `sample ${i} differs: [${p}] vs [${q}]`,
          );
        });
      }),
    );
  });
});

describe("compound — contourRanges / merge / split (properties)", () => {
  /** A well-formed multi-contour table: 1..4 contours of 1..5 anchors. */
  const wellFormed: fc.Arbitrary<AnchorTable> = fc
    .array(
      fc.tuple(anchorRun(1, 5, smallAnchorTriple), fc.boolean()),
      { minLength: 1, maxLength: 4 },
    )
    .map((contours) => {
      const anchors: AnchorTriple[] = [];
      const subpathStarts: number[] = [];
      const subpathOpen: boolean[] = [];
      for (const [run, open] of contours) {
        subpathStarts.push(anchors.length);
        subpathOpen.push(open);
        anchors.push(...run);
      }
      return { anchors, subpathStarts, subpathOpen };
    });

  it("contourRanges tiles [0, anchorCount) in order", () => {
    fc.assert(
      fc.property(wellFormed, (table) => {
        const ranges = contourRanges(table.anchors.length, table.subpathStarts);
        expect(ranges).toHaveLength(table.subpathStarts.length);
        expect(ranges[0][0]).toBe(0);
        expect(ranges[ranges.length - 1][1]).toBe(table.anchors.length);
        for (let i = 0; i + 1 < ranges.length; i++) {
          expect(ranges[i][1]).toBe(ranges[i + 1][0]);
        }
        for (const [from, to] of ranges) assertTrue(to > from, "empty range");
      }),
    );
  });

  it("split then merge is the identity on a well-formed table", () => {
    fc.assert(
      fc.property(wellFormed, (table) => {
        const parts = splitCompound(table);
        expect(parts).toHaveLength(table.subpathStarts.length);
        for (const part of parts) expect(part.subpathStarts).toEqual([0]);
        expect(mergeCompound(parts)).toEqual(table);
      }),
    );
  });

  it("merge concatenates: counts add up, starts are the running totals, flags ride along", () => {
    fc.assert(
      fc.property(fc.array(wellFormed, { maxLength: 4 }), (tables) => {
        const merged = mergeCompound(tables);
        expect(merged.anchors).toEqual(tables.flatMap((t) => [...t.anchors]));
        let offset = 0;
        const starts: number[] = [];
        const open: boolean[] = [];
        for (const t of tables) {
          t.subpathStarts.forEach((s, i) => {
            starts.push(offset + s);
            open.push(t.subpathOpen?.[i] ?? false);
          });
          offset += t.anchors.length;
        }
        expect(merged.subpathStarts).toEqual(starts);
        expect(merged.subpathOpen).toEqual(open);
      }),
    );
  });

  it("makeCompoundTable is orientForNonZeroHoles after mergeCompound", () => {
    fc.assert(
      fc.property(family, ({ table }) => {
        const parts = splitCompound(table);
        assertTableClose(
          makeCompoundTable(parts),
          orientForNonZeroHoles(mergeCompound(parts)),
          0,
        );
      }),
    );
  });

  // ------------------------------------------------------------------
  // DEFECT (compound.ts — mergeCompound, splitCompound,
  // orientForNonZeroHoles) — the open/closed FLAG is read at the wrong
  // index once `contourRanges` has dropped an empty contour.
  //
  // `contourRanges` documents that "empty/degenerate ranges are dropped".
  // All three callers then iterate the SURVIVING ranges and read
  // `table.subpathOpen?.[i]` with the survivor's index `i` — which is the
  // ORIGINAL contour index only until the first drop. After it, every
  // later contour takes the flag of the contour before it.
  //
  // Minimal counterexample: 8 anchors, subpathStarts [0, 4, 4] (the
  // middle contour is empty), subpathOpen [false, true, false].
  //   The two real contours are [0,4) — closed — and [4,8) — closed (its
  //   flag is entry 2).
  //   EXPECTED: splitCompound → flags [false], [false].
  //   ACTUAL:   [false], [true] — the second square inherits the EMPTY
  //             contour's `open` flag and becomes an open path.
  //
  // Low severity: a table with a repeated start is malformed and neither
  // the SVG parser nor the anchor read is known to emit one. But the code
  // chose to tolerate such tables, and it then answers wrongly instead of
  // either refusing or staying aligned.
  // ------------------------------------------------------------------
  it.fails("DEFECT (minimal counterexample): flags stay with their contour when an empty contour is dropped", () => {
    const sq = (x: number) =>
      rectContour({ x0: x, y0: 0, x1: x + 10, y1: 10 }, true, 0);
    const table: AnchorTable = {
      anchors: [...sq(0), ...sq(20)],
      subpathStarts: [0, 4, 4],
      subpathOpen: [false, true, false],
    };
    expect(contourRanges(8, table.subpathStarts)).toEqual([
      [0, 4],
      [4, 8],
    ]);
    expect(splitCompound(table).map((t) => t.subpathOpen)).toEqual([[false], [false]]);
    expect(mergeCompound([table]).subpathOpen).toEqual([false, false]);
  });
});
