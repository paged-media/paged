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

// ORACLE — the four Pathfinder BOOLEANS. The engine's `pathfinderBoolean
// { kept, others, kind }` (union / subtract / intersect / exclude) against
// set algebra and against ADOBE ILLUSTRATOR 30.1.0 (Effect > Pathfinder >
// Add / Subtract / Intersect / Exclude on a group, then Expand Appearance),
// recorded 2026-10-02 by
//   scripts/illustrator/run-probe.sh scripts/illustrator/probes/pathfinder-boolean.jsx \
//     packages/draw-bundle/test/fixtures/oracle/pathfinder-boolean.illustrator.json
//
// 8 cases: the four verbs on two overlapping rectangles, and on a circle cut
// by a rectangle. `input.paths[0]` is the BACK object and `kept`;
// `input.paths[1]` is in FRONT. "subtract" is back minus front.
//
// WHAT ILLUSTRATOR SAID, against set algebra:
//   * The painted area is the set operation's: 14800 / 6000 / 2000 / 12800
//     on the rectangles, exactly. On the circle the four results are each
//     within 0.1 pt² of inclusion–exclusion on the input cubics.
//   * Subtract is back − front.
//   * EXCLUDE is TWO separate simple paths (front-only, back-only) — not a
//     compound path, and not an outline with a hole.
//   * Not predicted by anything: every Pathfinder result is COUNTER-
//     clockwise (`polarity` negative, `area` negative) — the opposite of
//     Offset Path and Outline Stroke, whose results are all clockwise. The
//     inputs here were clockwise.
//   * Curves are cut at the crossings and kept as cubics: the circle's
//     union has 7 anchors and 4 curved segments.
//
// WHAT THE ENGINE DOES, against Illustrator (engine pin: canvas-wasm 0.65.0):
//   AGREEMENT — painted area and bounds in all 8 cases, and anchor count and
//   path count too (largest area gap 0.25 pt², on the circle's union).
//
//   FIXED in 0.65.0 — direction. Every result is counter-clockwise, as
//   Illustrator's are (RFI C-81). On 0.64.0 the rectangles came back
//   clockwise and the circle mixed.
//
//   CONVENTION — EXCLUDE's container. Since 0.65.0 the engine's pieces ARE
//   Illustrator's: the two disjoint shapes, wound the same way, Σ|area| =
//   the painted area (12800 / 7637.6). On 0.64.0 it was the union's
//   outline with the overlap as a hole (Σ|area| 16800). What remains is
//   that the engine keeps both pieces in ONE element (a compound path)
//   where Illustrator leaves two objects a user can move apart.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { pathfinderMutationFor } from "../../src";
import { onEngine, openOracleHost, pathsOf } from "./engine";
import {
  AREA_REL_TOL,
  BOUNDS_ABS_TOL,
  boundsDiff,
  loadOracle,
  paintedArea,
  pathBounds,
  polygon,
  relDiff,
  signedArea,
  summarize,
  windingOf,
  type OraclePath,
  type ShapeSummary,
} from "./oracle";

type Kind = "union" | "subtract" | "intersect" | "exclude";
interface BooleanParameters {
  kind: Kind;
}
interface BooleanCase {
  id: string;
  input: { paths: OraclePath[] };
  parameters: BooleanParameters;
}

// --- the cases: a MIRROR of scripts/illustrator/probes/pathfinder-boolean.jsx

/** Back: [100,100]-[200,180], 8000 pt². */
const RECT_A = polygon([
  [100, 100],
  [200, 100],
  [200, 180],
  [100, 180],
]);
/** Front: [150,140]-[260,220], 8800 pt². Overlap 50 x 40 = 2000. */
const RECT_B = polygon([
  [150, 140],
  [260, 140],
  [260, 220],
  [150, 220],
]);
/** Radius 50 about (160,160): four cubics, clockwise from the east point. */
const K = 27.614237;
const CIRCLE: OraclePath = {
  closed: true,
  anchors: [
    { anchor: [210, 160], left: [210, 160 - K], right: [210, 160 + K] },
    { anchor: [160, 210], left: [160 + K, 210], right: [160 - K, 210] },
    { anchor: [110, 160], left: [110, 160 + K], right: [110, 160 - K] },
    { anchor: [160, 110], left: [160 - K, 110], right: [160 + K, 110] },
  ],
};
const RECT_C = polygon([
  [150, 130],
  [260, 130],
  [260, 190],
  [150, 190],
]);
const KINDS = ["union", "subtract", "intersect", "exclude"] as const;

const PATHFINDER_BOOLEAN_CASES: BooleanCase[] = [
  ...KINDS.map((kind) => ({
    id: `rects-${kind}`,
    input: { paths: [RECT_A, RECT_B] },
    parameters: { kind },
  })),
  ...KINDS.map((kind) => ({
    id: `circle-rect-${kind}`,
    input: { paths: [CIRCLE, RECT_C] },
    parameters: { kind },
  })),
];

// --- reference 1: set algebra ----------------------------------------------
// Both inputs are clockwise, so a NON-ZERO fill of the pair paints their
// union and an EVEN-ODD fill paints their symmetric difference. Everything
// else is inclusion–exclusion on those two numbers and |back|.
function byDefinition(c: BooleanCase): number {
  const [back] = c.input.paths;
  const union = paintedArea(c.input.paths, "nonzero");
  const exclude = paintedArea(c.input.paths, "evenodd");
  const overlap = union - exclude;
  switch (c.parameters.kind) {
    case "union":
      return union;
    case "exclude":
      return exclude;
    case "intersect":
      return overlap;
    case "subtract":
      return paintedArea([back]) - overlap;
  }
}

/** Bounds. The circle meets y = 130 and y = 190 at x = 160 ± 40. */
const BOUNDS: Record<string, [number, number, number, number]> = {
  "rects-union": [100, 100, 260, 220],
  "rects-subtract": [100, 100, 200, 180],
  "rects-intersect": [150, 140, 200, 180],
  "rects-exclude": [100, 100, 260, 220],
  "circle-rect-union": [110, 110, 260, 210],
  "circle-rect-subtract": [110, 110, 200, 210],
  "circle-rect-intersect": [150, 130, 210, 190],
  "circle-rect-exclude": [110, 110, 260, 210],
};

const FIXTURE = loadOracle<BooleanParameters>("pathfinder-boolean");
const RECORDED = new Map(FIXTURE.cases.map((c) => [c.id, c]));
const theirs = (id: string): ShapeSummary => summarize(RECORDED.get(id)!.measured.paths);

describe("oracle — pathfinder booleans", () => {
  let h: HeadlessHost;
  const engineResults = new Map<
    string,
    { elements: number; paths: OraclePath[]; shape: ShapeSummary }
  >();

  beforeAll(async () => {
    h = await openOracleHost();
  });
  afterAll(() => h?.dispose());

  /** The engine's answer to one case, measured once: every path of every
   *  element the op leaves behind. */
  async function engine(c: BooleanCase) {
    const cached = engineResults.get(c.id);
    if (cached) return cached;
    const result = await onEngine(h, c.input.paths, async (run) => {
      const [back, front] = run.ids;
      await run.apply(pathfinderMutationFor(back, [front], c.parameters.kind));
      const left = await run.created();
      const paths: OraclePath[] = [];
      for (const id of left) paths.push(...(await pathsOf(h, id)));
      return { elements: left.length, paths, shape: summarize(paths) };
    });
    engineResults.set(c.id, result);
    return result;
  }

  describe("the recording", () => {
    it("says who made it", () => {
      expect(FIXTURE.produced_by.app).toBe("Adobe Illustrator");
      expect(FIXTURE.produced_by.version).toMatch(/^\d+\.\d+/);
      expect(FIXTURE.produced_by.script).toBe(
        "scripts/illustrator/probes/pathfinder-boolean.jsx",
      );
    });

    it("has exactly this spec's cases (probe and spec have not drifted)", () => {
      expect(
        FIXTURE.cases.map((c) => ({
          id: c.id,
          input: c.input,
          parameters: c.parameters,
        })),
      ).toEqual(PATHFINDER_BOOLEAN_CASES);
      const ids = PATHFINDER_BOOLEAN_CASES.map((c) => c.id);
      expect(Object.keys(BOUNDS)).toEqual(ids);
    });

    it("is self-consistent: Illustrator's area and bounds and the probe's winding match the anchors it recorded", () => {
      for (const c of FIXTURE.cases) {
        for (const p of c.measured.paths) {
          const signed = signedArea(p);
          expect(relDiff(Math.abs(signed), p.area), `${c.id} area`).toBeLessThan(AREA_REL_TOL);
          expect(boundsDiff(pathBounds(p), p.bounds), `${c.id} bounds`).toBeLessThan(
            BOUNDS_ABS_TOL,
          );
          expect(windingOf(signed), `${c.id} winding`).toBe(p.winding);
        }
      }
    });
  });

  describe("Illustrator vs set algebra", () => {
    it("every case paints the set operation that was ASKED for, within its bounds", () => {
      for (const c of PATHFINDER_BOOLEAN_CASES) {
        const got = theirs(c.id);
        expect(relDiff(got.fillArea, byDefinition(c)), `${c.id} area`).toBeLessThan(AREA_REL_TOL);
        expect(boundsDiff(got.bounds, BOUNDS[c.id]), `${c.id} bounds`).toBeLessThan(
          BOUNDS_ABS_TOL,
        );
      }
      // The rectangles are exact; subtract is back − front (8000 − 2000),
      // not front − back (8800 − 2000).
      expect(theirs("rects-union").area).toBe(14800);
      expect(theirs("rects-subtract").area).toBe(6000);
      expect(theirs("rects-intersect").area).toBe(2000);
      expect(theirs("rects-exclude").area).toBe(12800);
    });

    it("what set algebra does not predict: the structure and the direction of the result", () => {
      for (const c of FIXTURE.cases) {
        const got = theirs(c.id);
        // Plain, simple, closed paths — never a compound path…
        expect(got.allClosed, c.id).toBe(true);
        for (const p of c.measured.paths) expect(p.compound, c.id).toBeUndefined();
        expect(Math.abs(got.area - got.fillArea), c.id).toBeLessThan(0.2);
        // …one of them, except EXCLUDE, which is the two disjoint pieces
        // (front-only first, back-only second)…
        expect(got.paths, c.id).toBe(c.parameters.kind === "exclude" ? 2 : 1);
        // …and all COUNTER-clockwise, from clockwise inputs.
        for (const p of c.measured.paths) {
          expect(p.winding, c.id).toBe("ccw");
          expect(p.polarity, c.id).toBe("negative");
        }
      }
      expect(RECORDED.get("rects-exclude")!.measured.paths.map((p) => p.area)).toEqual([
        6800, 6000,
      ]);
      // Curves are cut at the crossings and stay cubics.
      expect(theirs("circle-rect-union").anchors).toBe(7);
      expect(theirs("circle-rect-union").curvedSegments).toBe(4);
      expect(theirs("circle-rect-intersect").anchors).toBe(5);
      expect(theirs("circle-rect-intersect").curvedSegments).toBe(2);
    });
  });

  describe("engine vs set algebra", () => {
    for (const c of PATHFINDER_BOOLEAN_CASES) {
      it(`${c.id}: painted area and bounds`, async () => {
        const ours = (await engine(c)).shape;
        expect(ours.allClosed).toBe(true);
        expect(relDiff(ours.fillArea, byDefinition(c))).toBeLessThan(AREA_REL_TOL);
        expect(boundsDiff(ours.bounds, BOUNDS[c.id])).toBeLessThan(BOUNDS_ABS_TOL);
      });
    }
  });

  describe("engine vs Adobe Illustrator", () => {
    for (const c of PATHFINDER_BOOLEAN_CASES) {
      it(`${c.id}: painted area, bounds, path count, anchor count`, async () => {
        const ours = (await engine(c)).shape;
        const want = theirs(c.id);
        expect(ours.allClosed).toBe(want.allClosed);
        expect(relDiff(ours.fillArea, want.fillArea)).toBeLessThan(AREA_REL_TOL);
        expect(boundsDiff(ours.bounds, want.bounds)).toBeLessThan(BOUNDS_ABS_TOL);
        expect(ours.paths).toBe(want.paths);
        expect(ours.anchors).toBe(want.anchors);
        expect(ours.curvedSegments).toBe(want.curvedSegments);
      });
    }

    it("CONVENTION — exclude: the engine keeps Illustrator's two pieces in ONE element; Illustrator leaves two objects", async () => {
      for (const id of ["rects-exclude", "circle-rect-exclude"]) {
        const c = PATHFINDER_BOOLEAN_CASES.find((x) => x.id === id)!;
        const { elements, paths, shape: ours } = await engine(c);
        const want = theirs(id);
        const exclude = paintedArea(c.input.paths, "evenodd");
        // Engine: one element, two subpaths wound the SAME way — the two
        // disjoint pieces, no hole. Σ|area| is the painted area.
        expect(elements, id).toBe(1);
        expect(ours.paths, id).toBe(2);
        expect(new Set(ours.windings).size, id).toBe(1);
        expect(relDiff(ours.area, exclude), id).toBeLessThan(AREA_REL_TOL);
        // Illustrator: the same two pieces, the same way round.
        expect(want.paths, id).toBe(2);
        expect(new Set(want.windings).size, id).toBe(1);
        expect(relDiff(want.area, exclude), id).toBeLessThan(AREA_REL_TOL);
        // Either way the same pixels, under either fill rule.
        expect(relDiff(paintedArea(paths, "evenodd"), exclude), id).toBeLessThan(AREA_REL_TOL);
        expect(relDiff(paintedArea(paths, "nonzero"), exclude), id).toBeLessThan(AREA_REL_TOL);
      }
    });

    it("direction — FIXED in 0.65.0: every path counter-clockwise, as Illustrator's", async () => {
      for (const c of PATHFINDER_BOOLEAN_CASES) {
        expect(new Set((await engine(c)).shape.windings), `${c.id}: engine`).toEqual(new Set(["ccw"]));
        expect(new Set(theirs(c.id).windings), `${c.id}: Illustrator`).toEqual(new Set(["ccw"]));
      }
    });
  });
});
