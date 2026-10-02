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

// Property tests for svg-path.ts — SVG path data ⇄ the anchor model.
//
// Two independent references:
//   · `lowerReference` — the SVG path grammar's SEMANTICS written out a
//     second time (pen tracking, relative coordinates, H/V, the S and T
//     reflections, quadratic elevation, the pen's return on Z) producing
//     only absolute M / L / C / Z. The kernel parsing the original string
//     and the kernel parsing the lowered one must build the same table.
//   · the round trip itself — parse → serialize → parse must be a FIXED
//     POINT, stated three ways below (exact input, canonical table,
//     arbitrary input after one normalising pass).

import { describe, expect, it } from "vitest";

import {
  parsePathData,
  quadToCubic,
  serializePathData,
  type AnchorTable,
  type Vec2,
} from "../src";
import {
  assertTableClose,
  assertTrue,
  assertVecClose,
  canonicalTable,
  fc,
  gridCoord,
  refEvalCubic,
  unit,
  vec2,
} from "./property-kit";

// ----------------------------------------------------- the command model

type Cmd =
  | { k: "M" | "L" | "T"; rel: boolean; x: number; y: number }
  | { k: "H" | "V"; rel: boolean; v: number }
  | { k: "C"; rel: boolean; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { k: "S"; rel: boolean; x2: number; y2: number; x: number; y: number }
  | { k: "Q"; rel: boolean; x1: number; y1: number; x: number; y: number }
  | {
      k: "A";
      rel: boolean;
      rx: number;
      ry: number;
      rot: number;
      large: boolean;
      sweep: boolean;
      x: number;
      y: number;
    }
  | { k: "Z"; rel: boolean };

function render(cmds: readonly Cmd[]): string {
  return cmds
    .map((c) => {
      const letter = c.rel ? c.k.toLowerCase() : c.k;
      switch (c.k) {
        case "M":
        case "L":
        case "T":
          return `${letter} ${c.x} ${c.y}`;
        case "H":
        case "V":
          return `${letter} ${c.v}`;
        case "C":
          return `${letter} ${c.x1} ${c.y1} ${c.x2} ${c.y2} ${c.x} ${c.y}`;
        case "S":
          return `${letter} ${c.x2} ${c.y2} ${c.x} ${c.y}`;
        case "Q":
          return `${letter} ${c.x1} ${c.y1} ${c.x} ${c.y}`;
        case "A":
          return `${letter} ${c.rx} ${c.ry} ${c.rot} ${c.large ? 1 : 0} ${c.sweep ? 1 : 0} ${c.x} ${c.y}`;
        case "Z":
          return letter;
      }
    })
    .join(" ");
}

/** A path is a moveto followed by anything. Coordinates come from a tiny
 *  integer box so anchors COLLIDE: closing returns, repeated points and
 *  zero-length segments are the cases worth generating. */
function pathOf(
  n: fc.Arbitrary<number>,
  kinds: readonly Cmd["k"][],
  options: { relative: boolean },
): fc.Arbitrary<Cmd[]> {
  const rel = options.relative ? fc.boolean() : fc.constant(false);
  const byKind: Record<Cmd["k"], fc.Arbitrary<Cmd>> = {
    M: fc.record({ k: fc.constant("M" as const), rel, x: n, y: n }),
    L: fc.record({ k: fc.constant("L" as const), rel, x: n, y: n }),
    T: fc.record({ k: fc.constant("T" as const), rel, x: n, y: n }),
    H: fc.record({ k: fc.constant("H" as const), rel, v: n }),
    V: fc.record({ k: fc.constant("V" as const), rel, v: n }),
    C: fc.record({ k: fc.constant("C" as const), rel, x1: n, y1: n, x2: n, y2: n, x: n, y: n }),
    S: fc.record({ k: fc.constant("S" as const), rel, x2: n, y2: n, x: n, y: n }),
    Q: fc.record({ k: fc.constant("Q" as const), rel, x1: n, y1: n, x: n, y: n }),
    A: fc.record({
      k: fc.constant("A" as const),
      rel,
      rx: fc.integer({ min: 1, max: 6 }),
      ry: fc.integer({ min: 1, max: 6 }),
      rot: fc.constantFrom(0, 30, 45, 90),
      large: fc.boolean(),
      sweep: fc.boolean(),
      x: n,
      y: n,
    }),
    Z: fc.record({ k: fc.constant("Z" as const), rel }),
  };
  const first: fc.Arbitrary<Cmd> = fc.record({
    k: fc.constant("M" as const),
    rel,
    x: n,
    y: n,
  });
  return fc
    .tuple(first, fc.array(fc.oneof(...kinds.map((k) => byKind[k])), { maxLength: 10 }))
    .map(([head, tail]) => [head, ...tail]);
}

const smallInt = fc.integer({ min: -4, max: 4 });
/** A 2×2 lattice: nearly every point is a repeat of an earlier one, so
 *  closing returns and stacked anchors are the NORM, not the exception. */
const tinyInt = fc.integer({ min: 0, max: 1 });

const ALL: Cmd["k"][] = ["M", "L", "H", "V", "C", "S", "Q", "T", "A", "Z", "Z"];
const NO_ARC: Cmd["k"][] = ["M", "L", "H", "V", "C", "S", "Q", "T", "Z", "Z"];
const EXACT: Cmd["k"][] = ["M", "L", "H", "V", "C", "Z", "Z"];

// ------------------------------------------------ the reference lowering

/**
 * REFERENCE semantics of the path grammar, lowering every command to
 * absolute `M` / `L` / `C` / `Z` text. Arcs are not handled (they have
 * their own spec file); everything else is.
 */
function lowerReference(cmds: readonly Cmd[]): string {
  const out: string[] = [];
  let pen: Vec2 = [0, 0];
  let start: Vec2 = [0, 0];
  let lastCubicCtrl: Vec2 | null = null;
  let lastQuadCtrl: Vec2 | null = null;
  let needMove = false; // a Z was seen: the next drawing command re-opens at `start`

  const abs = (rel: boolean, x: number, y: number): Vec2 =>
    rel ? [pen[0] + x, pen[1] + y] : [x, y];
  const open = () => {
    if (needMove) {
      out.push(`M ${start[0]} ${start[1]}`);
      needMove = false;
    }
  };
  const cubicTo = (c1: Vec2, c2: Vec2, to: Vec2) => {
    open();
    out.push(`C ${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${to[0]} ${to[1]}`);
    pen = to;
  };
  const lineTo = (to: Vec2) => {
    open();
    out.push(`L ${to[0]} ${to[1]}`);
    pen = to;
  };
  const elevate = (q: Vec2, to: Vec2): [Vec2, Vec2] => [
    [pen[0] + (2 / 3) * (q[0] - pen[0]), pen[1] + (2 / 3) * (q[1] - pen[1])],
    [to[0] + (2 / 3) * (q[0] - to[0]), to[1] + (2 / 3) * (q[1] - to[1])],
  ];

  for (const c of cmds) {
    switch (c.k) {
      case "M": {
        const to = abs(c.rel, c.x, c.y);
        out.push(`M ${to[0]} ${to[1]}`);
        pen = to;
        start = to;
        needMove = false;
        lastCubicCtrl = null;
        lastQuadCtrl = null;
        break;
      }
      case "L":
        lineTo(abs(c.rel, c.x, c.y));
        lastCubicCtrl = null;
        lastQuadCtrl = null;
        break;
      case "H":
        lineTo([c.rel ? pen[0] + c.v : c.v, pen[1]]);
        lastCubicCtrl = null;
        lastQuadCtrl = null;
        break;
      case "V":
        lineTo([pen[0], c.rel ? pen[1] + c.v : c.v]);
        lastCubicCtrl = null;
        lastQuadCtrl = null;
        break;
      case "C": {
        const c1 = abs(c.rel, c.x1, c.y1);
        const c2 = abs(c.rel, c.x2, c.y2);
        cubicTo(c1, c2, abs(c.rel, c.x, c.y));
        lastCubicCtrl = c2;
        lastQuadCtrl = null;
        break;
      }
      case "S": {
        const c1: Vec2 = lastCubicCtrl
          ? [2 * pen[0] - lastCubicCtrl[0], 2 * pen[1] - lastCubicCtrl[1]]
          : pen;
        const c2 = abs(c.rel, c.x2, c.y2);
        cubicTo(c1, c2, abs(c.rel, c.x, c.y));
        lastCubicCtrl = c2;
        lastQuadCtrl = null;
        break;
      }
      case "Q": {
        const q = abs(c.rel, c.x1, c.y1);
        const to = abs(c.rel, c.x, c.y);
        const [c1, c2] = elevate(q, to);
        cubicTo(c1, c2, to);
        lastQuadCtrl = q;
        lastCubicCtrl = null;
        break;
      }
      case "T": {
        const q: Vec2 = lastQuadCtrl
          ? [2 * pen[0] - lastQuadCtrl[0], 2 * pen[1] - lastQuadCtrl[1]]
          : pen;
        const to = abs(c.rel, c.x, c.y);
        const [c1, c2] = elevate(q, to);
        cubicTo(c1, c2, to);
        lastQuadCtrl = q;
        lastCubicCtrl = null;
        break;
      }
      case "A":
        throw new Error("lowerReference does not lower arcs");
      case "Z":
        if (!needMove) out.push("Z");
        pen = start;
        needMove = true;
        lastCubicCtrl = null;
        lastQuadCtrl = null;
        break;
    }
  }
  return out.join(" ");
}

// ------------------------------------------------------------- helpers

const same = (a: Vec2, b: Vec2): boolean => a[0] === b[0] && a[1] === b[1];

const roundTrip = (table: AnchorTable): AnchorTable =>
  parsePathData(serializePathData(table));

// ------------------------------------------------------------ properties

describe("svg-path — the grammar's semantics (properties)", () => {
  it("relative commands, H/V, the S/T reflections and Q elevation all lower to the same table as absolute M/L/C/Z", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          pathOf(smallInt, NO_ARC, { relative: true }),
          pathOf(tinyInt, NO_ARC, { relative: true }),
        ),
        (cmds) => {
          assertTableClose(
            parsePathData(render(cmds)),
            parsePathData(lowerReference(cmds)),
            1e-9,
          );
        },
      ),
    );
  });

  it("repeated argument groups are implicit repeats of the command (and of L after M)", () => {
    const pair = fc.tuple(smallInt, smallInt);
    fc.assert(
      fc.property(pair, fc.array(pair, { minLength: 1, maxLength: 5 }), fc.boolean(), (head, tail, rel) => {
        const m = rel ? "m" : "M";
        const l = rel ? "l" : "L";
        const flat = tail.map((p) => p.join(" ")).join(" ");
        const explicit = `${m} ${head.join(" ")} ` + tail.map((p) => `${l} ${p.join(" ")}`).join(" ");
        const expected = parsePathData(explicit);
        assertTableClose(parsePathData(`${m} ${head.join(" ")} ${flat}`), expected, 0, "after M");
        assertTableClose(parsePathData(`${m} ${head.join(" ")} ${l} ${flat}`), expected, 0, "after L");
      }),
    );
  });

  it("commas, whitespace and no separator at all are the same path", () => {
    // `M1-2` is `M 1 -2` and `.5.5` is `0.5 0.5`: a sign or a second dot
    // starts a new number.
    const num = fc.oneof(
      fc.integer({ min: -9, max: 9 }),
      fc.integer({ min: -99, max: 99 }).map((n) => n / 10),
    );
    const compact = (n: number): string => {
      const text = String(n);
      return text.startsWith("0.") ? text.slice(1) : text.replace(/^-0\./, "-.");
    };
    fc.assert(
      fc.property(fc.array(fc.tuple(num, num), { minLength: 2, maxLength: 6 }), (pts) => {
        const spaced =
          `M ${pts[0][0]} ${pts[0][1]} ` +
          pts.slice(1).map((p) => `L ${p[0]} ${p[1]}`).join(" ");
        const commas =
          `M${pts[0][0]},${pts[0][1]}` +
          pts.slice(1).map((p) => `L${p[0]},${p[1]}`).join("");
        // Tightest legal form: a separator only where two numbers would
        // otherwise fuse (the second neither signed nor dot-led).
        const glue = (a: number, b: number): string => {
          const right = compact(b);
          const fuses =
            right[0] !== "-" && !(right[0] === "." && compact(a).includes("."));
          return compact(a) + (fuses ? " " : "") + right;
        };
        const tight =
          `M${glue(pts[0][0], pts[0][1])}` +
          pts.slice(1).map((p) => `L${glue(p[0], p[1])}`).join("");
        const expected = parsePathData(spaced);
        assertTableClose(parsePathData(commas), expected, 0, "commas");
        assertTableClose(parsePathData(tight), expected, 0, `tight form ${tight}`);
      }),
    );
  });

  it("quadToCubic's cubic IS the quadratic, at every parameter", () => {
    fc.assert(
      fc.property(vec2, vec2, vec2, unit, (p0, q, p1, t) => {
        const { right, left } = quadToCubic(p0, q, p1);
        const u = 1 - t;
        const quad: Vec2 = [
          u * u * p0[0] + 2 * u * t * q[0] + t * t * p1[0],
          u * u * p0[1] + 2 * u * t * q[1] + t * t * p1[1],
        ];
        assertVecClose(refEvalCubic([p0, right, left, p1], t), quad, 1e-9 * 1000);
      }),
    );
  });

  it("never throws on junk, and always answers a self-consistent table", () => {
    const soup = fc.string({
      unit: fc.constantFrom(..."MmLlHhVvCcSsQqTtAaZz0123456789.-+, xyz"),
      maxLength: 40,
    });
    fc.assert(
      fc.property(soup, (d) => {
        const table = parsePathData(d);
        const n = table.anchors.length;
        expect(table.subpathOpen).toHaveLength(table.subpathStarts.length);
        if (n === 0) {
          expect(table.subpathStarts).toEqual([]);
          return;
        }
        expect(table.subpathStarts[0]).toBe(0);
        for (let i = 1; i < table.subpathStarts.length; i++) {
          assertTrue(
            table.subpathStarts[i] > table.subpathStarts[i - 1] &&
              table.subpathStarts[i] < n,
            `subpathStarts ${JSON.stringify(table.subpathStarts)} for ${n} anchors`,
          );
        }
        for (const a of table.anchors) {
          for (const p of [a.anchor, a.left, a.right]) {
            assertTrue(Number.isFinite(p[0]) && Number.isFinite(p[1]), `non-finite in ${d}`);
          }
        }
        // And whatever it parsed, it can write and read back.
        expect(() => roundTrip(table)).not.toThrow();
      }),
    );
  });
});

describe("svg-path — parse → serialize → parse is a fixed point (properties)", () => {
  it("EXACT: for path data with ≤ 3 decimals, serialize ∘ parse reads back the very same table", () => {
    // Absolute M/L/H/V/C/Z over multiples of 1/8: nothing is rounded, so
    // the round trip must reproduce every anchor and handle to the bit —
    // INCLUDING a contour that ends on its own start, which this property
    // excluded while that was a pinned defect (see the block below).
    fc.assert(
      fc.property(
        fc.oneof(
          pathOf(gridCoord, EXACT, { relative: false }),
          pathOf(tinyInt, EXACT, { relative: false }),
        ),
        (cmds) => {
          const table = parsePathData(render(cmds));
          assertTableClose(roundTrip(table), table, 0);
        },
      ),
    );
  });

  it("CANONICAL: any well-formed table survives serialize → parse to the bit", () => {
    fc.assert(
      fc.property(canonicalTable, (table) => {
        assertTableClose(roundTrip(table), table, 0);
      }),
    );
  });

  it("ANY input: one round trip normalises, and the result is a fixed point of the next", () => {
    // Relative commands, quadratics and arcs produce coordinates with
    // more than 3 decimals; the first serialize ROUNDS them (and may
    // straighten a hair-curved segment or fold a now-coincident closing
    // anchor). After that pass nothing may change again: same table, same
    // text.
    fc.assert(
      fc.property(
        fc.oneof(
          pathOf(smallInt, ALL, { relative: true }),
          pathOf(tinyInt, ALL, { relative: true }),
        ),
        (cmds) => {
          const once = roundTrip(parsePathData(render(cmds)));
          const twice = roundTrip(once);
          assertTableClose(twice, once, 0);
          expect(serializePathData(twice)).toBe(serializePathData(once));
        },
      ),
    );
  });

  it("rounding moves no coordinate by more than half a unit in the last place", () => {
    fc.assert(
      fc.property(canonicalTable, fc.integer({ min: 0, max: 6 }), vec2, (table, precision, shift) => {
        // Shift by an arbitrary double so there IS something to round.
        const moved: AnchorTable = {
          ...table,
          anchors: table.anchors.map((a) => ({
            anchor: [a.anchor[0] + shift[0], a.anchor[1] + shift[1]] as [number, number],
            left: [a.left[0] + shift[0], a.left[1] + shift[1]] as [number, number],
            right: [a.right[0] + shift[0], a.right[1] + shift[1]] as [number, number],
          })),
        };
        const text = serializePathData(moved, precision);
        for (const token of text.split(" ")) {
          if (/^[MLCZ]$/.test(token)) continue;
          const decimals = token.includes(".") ? token.split(".")[1].length : 0;
          assertTrue(decimals <= precision, `"${token}" has more than ${precision} decimals`);
          assertTrue(token !== "-0", "emitted a negative zero");
        }
        const back = parsePathData(text);
        expect(back.anchors).toHaveLength(moved.anchors.length);
        const half = 0.5 * 10 ** -precision + 1e-9;
        back.anchors.forEach((a, i) => {
          assertTrue(
            Math.abs(a.anchor[0] - moved.anchors[i].anchor[0]) <= half &&
              Math.abs(a.anchor[1] - moved.anchors[i].anchor[1]) <= half,
            `anchor ${i} moved by more than ${half}`,
          );
        });
      }),
    );
  });

  it("a coordinate that rounds to zero from below is written `0`, never `-0`", () => {
    // −0.0004 at 3 decimals is −0.000, which `Number` reads as −0 and
    // `toString` would print as "0" — but only after the explicit −0
    // guard: `(-0.0004).toFixed(3)` is the string "-0.000".
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 1, max: 499 }),
        fc.integer({ min: -20, max: 20 }),
        (precision, thousandths, other) => {
          // A negative value strictly inside the last place's rounding
          // band: it rounds to (negative) zero.
          const tiny = -(thousandths / 1000) * 10 ** -precision;
          const text = serializePathData(
            {
              anchors: [
                { anchor: [tiny, other], left: [tiny, other], right: [tiny, other] },
                { anchor: [other, tiny], left: [other, tiny], right: [other, tiny] },
              ],
              subpathStarts: [0],
              subpathOpen: [true],
            },
            precision,
          );
          expect(text).toBe(`M 0 ${other} L ${other} 0`);
        },
      ),
    );
  });

  it("an empty table serializes to the empty string, and back", () => {
    expect(serializePathData({ anchors: [], subpathStarts: [] })).toBe("");
    expect(parsePathData("")).toEqual({ anchors: [], subpathStarts: [], subpathOpen: [] });
  });
});

// --------------------------------------------------------------------
// DEFECTS (svg-path.ts) — FIXED ones stay as the record and as the
// regression tests (`it("FIXED DEFECT …")`).
// --------------------------------------------------------------------
describe("svg-path — DEFECTS", () => {
  // ------------------------------------------------------------------
  // (1) ARC FLAGS WRITTEN WITHOUT A SEPARATOR WERE MISREAD — and the rest
  //     of the path with them. FIXED.
  //
  // The SVG grammar makes each arc flag a SINGLE character, `0` or `1`,
  // with the separator after it optional: `a5 5 0 1110 0` is rx 5, ry 5,
  // rotation 0, large-arc 1, sweep 1, then (10, 0). The tokenizer read
  // numbers greedily, so `1110` became ONE number, 1110: the large-arc
  // flag was "1110 ≠ 0", the sweep flag the next number, and every
  // argument after it was shifted by two.
  //
  // This is not an exotic spelling. It is what SVGO emits by default, so
  // it is how the arcs of an optimised icon set are written — a circle
  // comes out as `M12 2a10 10 0 100 20 10 10 0 000-20z`.
  //
  // Minimal counterexample:
  //   parsePathData("M0 0a5 5 0 1110 0")
  //   EXPECTED: the same 3 anchors as "M0 0a5 5 0 1 1 10 0" — a half
  //             circle from (0,0) over (5,−5) to (10,0).
  //   WAS:      ONE anchor at (0,0). The arc was read as large=1110,
  //             sweep=0, end = (missing, missing) = (0,0) relative, i.e.
  //             zero length, and was dropped without a word.
  //
  // THE FIX: the tokenizer counts its position in an arc's argument list
  // and takes ONE character at the fourth and fifth argument of every
  // group of seven.
  // ------------------------------------------------------------------
  it("FIXED DEFECT (1, minimal counterexample): compact arc flags read like spaced ones", () => {
    assertTableClose(
      parsePathData("M0 0a5 5 0 1110 0"),
      parsePathData("M0 0a5 5 0 1 1 10 0"),
      0,
    );
  });

  it("FIXED DEFECT (1): an SVGO-minified circle icon is a circle", () => {
    const minified = parsePathData("M12 2a10 10 0 100 20 10 10 0 000-20z");
    const spaced = parsePathData("M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0 -20z");
    expect(spaced.anchors.length).toBeGreaterThanOrEqual(4);
    assertTableClose(minified, spaced, 0);
  });

  it("FIXED DEFECT (1): a flag is ONE character wherever it stands — glued, comma'd, repeated", () => {
    const spaced = parsePathData("M0 0 a5 5 0 0 1 10 0 a5 5 0 1 0 -10 0");
    // Both flags and the number after them in one run of digits…
    assertTableClose(parsePathData("M0 0a5 5 0 0110 0a5 5 0 10-10 0"), spaced, 0);
    // …a comma between the flags only…
    assertTableClose(parsePathData("M0 0a5 5 0 0,110 0a5 5 0 1,0-10 0"), spaced, 0);
    // …and the implicit repeat of the command: the second group's flags
    // are the 11th and 12th argument, counted through the first group.
    assertTableClose(parsePathData("M0 0a5 5 0 0110 0 5 5 0 10-10 0"), spaced, 0);
    // A flag is not a number: `0.5` after the rotation is the flag 0 and
    // then `.5`, so this arc ends at (0.5, 3) — not at (3, <missing>).
    assertTableClose(
      parsePathData("M0 0a5 5 0 10.5 3"),
      parsePathData("M0 0a5 5 0 1 0 .5 3"),
      0,
    );
    // Outside an arc nothing changed: `10` is still ten.
    expect(parsePathData("M10 10L110 0").anchors.map((a) => a.anchor)).toEqual([
      [10, 10],
      [110, 0],
    ]);
  });

  it("FIXED DEFECT (1): property — arc flags need no separator", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9 }),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        (r, large, sweep, x, y) => {
          const f = `${large ? 1 : 0}${sweep ? 1 : 0}`;
          assertTableClose(
            parsePathData(`M0 0a${r} ${r} 0 ${f}${x} ${y}`),
            parsePathData(`M0 0a${r} ${r} 0 ${f[0]} ${f[1]} ${x} ${y}`),
            0,
          );
        },
      ),
    );
  });

  // ------------------------------------------------------------------
  // (2) THE TWO-ARC CIRCLE DOES NOT CLOSE ONTO ITS START.
  //
  // `Z` folds a trailing anchor that restates the subpath start, moving
  // its incoming handle onto the start anchor — but only when the
  // coordinates are `===`. An arc's last anchor is the point
  // `arcToCubics` recomputed, not the end point in the path data (see
  // svg-arc's defect block), so it is an ulp off and the fold is skipped.
  //
  // Minimal counterexample: the canonical way to write a circle,
  //   "M 0 5 a 5 5 0 1 0 10 0 a 5 5 0 1 0 -10 0 Z"
  //   EXPECTED: 4 anchors, the first one SMOOTH (its `left` handle is the
  //             closing quarter's control point, (0, 2.239)).
  //   ACTUAL:   5 anchors — the fifth at (0, 4.999999999999999) — and the
  //             first is a CORNER (`left` collapsed onto (0,5)).
  //
  // In the editor that is two stacked anchors at the seam of every circle
  // imported this way, and a seam that kinks when either is moved.
  // ------------------------------------------------------------------
  it.fails("DEFECT (2, minimal counterexample): a two-arc circle parses to four smooth anchors", () => {
    const circle = parsePathData("M 0 5 a 5 5 0 1 0 10 0 a 5 5 0 1 0 -10 0 Z");
    expect(circle.anchors).toHaveLength(4);
    expect(same(circle.anchors[0].left, circle.anchors[0].anchor)).toBe(false);
  });

  // ------------------------------------------------------------------
  // (3) THE ROUND TRIP ATE AN ANCHOR from a closed contour whose last
  //     anchor sits on its first — one per cycle. FIXED.
  //
  // `serializePathData` omits a closed contour's straight closing segment
  // ("`Z` implies it"). When that segment has ZERO length — the last
  // anchor coincides with the first — what that left behind was
  // `… L x0 y0 Z`, which `parsePathData` reads as "an explicit return to
  // the start" and folds away. The serializer wrote a form its own
  // parser understood differently.
  //
  // Minimal counterexample: "M 0 0 L 1 0 L 0 0 L 0 0 Z"
  //   parse      → 3 anchors (0,0) (1,0) (0,0), closed
  //   serialize  → WAS "M 0 0 L 1 0 L 0 0 Z"
  //   parse      → WAS 2 anchors
  //   EXPECTED: parse(serialize(t)) deep-equals t.
  //   WAS:      one anchor fewer; with k stacked anchors, k cycles each
  //             removed one.
  //
  // Low severity: the outline was unchanged, and a curved incoming handle
  // was carried over onto the start anchor correctly. What was lost is
  // the anchor COUNT, so an SVG export → import was not anchor-faithful
  // for such a contour (anchor indices shifted).
  //
  // THE FIX, and the one that was NOT taken. The note that stood here
  // said "always emitting the closing segment is table-equivalent and
  // fixes it". Checked over 200 000 random tables, that is TRUE of this
  // parser: both forms read back as the same table, and both are fixed
  // points. But it is not free — it restates the start point of every
  // closed contour with a straight closing edge (`… L 0 10 L 0 0 Z` for
  // a rectangle), which changes the text of every polygon the exporter
  // writes and hands every OTHER reader a duplicate node at the seam. So
  // the closing segment is written out only where leaving it implicit is
  // what loses the anchor: when the last anchor PRINTS as the start
  // point. Every other contour serializes byte-for-byte as it did
  // (svg-path.spec.ts pins "M 0 0 L 10 0 L 10 10 Z").
  // ------------------------------------------------------------------
  it("FIXED DEFECT (3, minimal counterexample): a contour ending on its own start survives the round trip", () => {
    const table = parsePathData("M 0 0 L 1 0 L 0 0 L 0 0 Z");
    expect(table.anchors).toHaveLength(3);
    expect(serializePathData(table)).toBe("M 0 0 L 1 0 L 0 0 L 0 0 Z");
    assertTableClose(roundTrip(table), table, 0);
  });

  it("FIXED DEFECT (3): the closing segment is written out ONLY for a stacked close", () => {
    // The rectangle keeps the compact form: `Z` draws its last edge.
    expect(serializePathData(parsePathData("M 0 0 L 10 0 L 10 10 L 0 10 Z"))).toBe(
      "M 0 0 L 10 0 L 10 10 L 0 10 Z",
    );
    // Two anchors that only ROUND to the same text stack just the same:
    // (0.0004, 0) prints as "0 0" at three decimals.
    const hair: AnchorTable = {
      anchors: [
        { anchor: [0, 0], left: [0, 0], right: [0, 0] },
        { anchor: [1, 0], left: [1, 0], right: [1, 0] },
        { anchor: [0.0004, 0], left: [0.0004, 0], right: [0.0004, 0] },
      ],
      subpathStarts: [0],
      subpathOpen: [false],
    };
    expect(serializePathData(hair)).toBe("M 0 0 L 1 0 L 0 0 L 0 0 Z");
    expect(roundTrip(hair).anchors).toHaveLength(3);
    // …and at a precision that tells them apart, they do not.
    expect(serializePathData(hair, 4)).toBe("M 0 0 L 1 0 L 0.0004 0 Z");
    // A closed contour of ONE anchor has nothing to stack on.
    expect(serializePathData(parsePathData("M 3 4 Z"))).toBe("M 3 4 Z");
  });

  it("FIXED DEFECT (3): property — serialize ∘ parse is the identity on exact path data", () => {
    fc.assert(
      fc.property(pathOf(tinyInt, EXACT, { relative: false }), (cmds) => {
        const table = parsePathData(render(cmds));
        assertTableClose(roundTrip(table), table, 0);
      }),
    );
  });
});
