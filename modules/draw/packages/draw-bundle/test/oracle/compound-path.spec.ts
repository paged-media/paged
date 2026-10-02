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

// ORACLE — Compound Path > Make, and what it does to WINDING. The bundle's
// Make Compound Path command (`media.paged.draw.command.makeCompoundPath`:
// merge the selection's contours into the first selected element and
// re-wind them by NESTING DEPTH, because the engine fills non-zero) against
// ADOBE ILLUSTRATOR 30.1.0 (Object > Compound Path > Make), recorded
// 2026-10-02 by
//   scripts/illustrator/run-probe.sh scripts/illustrator/probes/compound-path.jsx \
//     packages/draw-bundle/test/fixtures/oracle/compound-path.illustrator.json
//
// 9 cases, all rectangles: a hole in a square from every combination of
// input directions and paint orders, three and four levels of nesting, two
// disjoint shapes, and two shapes that merely overlap.
//
// WHAT ILLUSTRATOR DOES — and it is not what `commands/compound-path.ts`
// says it does ("Illustrator describes a compound path as even-odd filled"):
//   * The fill rule stays NON-ZERO. `evenodd` is false on every subpath of
//     every case.
//   * Direction is rewritten by PAINT ORDER, not by nesting and not by what
//     the inputs were: the BACKMOST path becomes clockwise (`polarity`
//     positive), EVERY other path counter-clockwise. A clockwise hole is
//     reversed; a counter-clockwise outer shape is reversed; a hole that
//     lies BEHIND its outer shape is the one made clockwise.
//   * So one level of nesting is a hole (30000 of 40000), two levels an
//     island (31600), and two shapes that merely overlap knock their
//     overlap out (12800, not the union's 14800).
//   * And THREE levels deep is where non-zero and even-odd part company:
//     the innermost square has winding +1 −1 −1 −1 = −2, which a non-zero
//     fill PAINTS. Illustrator's four-deep compound paints 31600; an
//     even-odd reading of the same four contours paints 31200.
//
// WHAT THE BUNDLE DOES, against Illustrator:
//   AGREEMENT — the painted region is the same in 8 of 9 cases, holes,
//   islands and knocked-out overlaps included; one element is left, with
//   one contour per input.
//
//   DEFECT (parity) — nesting three levels deep. The bundle re-winds by
//   nesting depth, alternating, which reproduces EVEN-ODD: its four-deep
//   compound paints 31200 pt² where Illustrator's paints 31600 pt² — the
//   20 x 20 core is a hole here and solid there. `it.fails`. This one does
//   not move with the engine pin: the rule lives in draw-geometry's
//   `makeCompoundTable`.
//
//   CONVENTION — which way each contour runs. Same paint, different
//   directions, in 4 cases: the bundle keeps depth-0 contours as it finds
//   them and alternates inward; Illustrator makes the backmost clockwise
//   and everything else counter-clockwise (CONTOUR_DIRECTIONS).
//
//   CONVENTION — contour order: the bundle lists the survivor's contour
//   first, then the others in selection order (back to front here);
//   Illustrator lists front to back.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { CommandContribution } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { MAKE_COMPOUND_PATH_COMMAND_ID } from "../../src";
import { leafIds, onEngine, openOracleHost, pathsOf } from "./engine";
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
  windingOf,
  type OraclePath,
  type Winding,
} from "./oracle";

interface CompoundCase {
  id: string;
  input: { paths: OraclePath[] };
  parameters: Record<string, never>;
}

// --- the cases: a MIRROR of scripts/illustrator/probes/compound-path.jsx ----

const rect = (l: number, t: number, r: number, b: number, clockwise: boolean): OraclePath =>
  polygon(
    clockwise
      ? [
          [l, t],
          [r, t],
          [r, b],
          [l, b],
        ]
      : [
          [l, t],
          [l, b],
          [r, b],
          [r, t],
        ],
  );
const CW = true;
const CCW = false;
/** 40000 pt². */
const outer = (dir: boolean) => rect(100, 100, 300, 300, dir);
/** 10000 pt², strictly inside `outer`. */
const hole = (dir: boolean) => rect(150, 150, 250, 250, dir);
/** 1600 pt², strictly inside `hole`. */
const island = (dir: boolean) => rect(180, 180, 220, 220, dir);
/** 400 pt², strictly inside `island`. */
const core = (dir: boolean) => rect(190, 190, 210, 210, dir);

const of = (id: string, paths: OraclePath[]): CompoundCase => ({
  id,
  input: { paths },
  parameters: {},
});
const COMPOUND_PATH_CASES: CompoundCase[] = [
  of("nested-cw-cw", [outer(CW), hole(CW)]),
  of("nested-cw-ccw", [outer(CW), hole(CCW)]),
  of("nested-ccw-ccw", [outer(CCW), hole(CCW)]),
  of("nested-hole-behind-cw-cw", [hole(CW), outer(CW)]),
  of("three-deep-cw-cw-cw", [outer(CW), hole(CW), island(CW)]),
  of("four-deep-cw-cw-cw-cw", [outer(CW), hole(CW), island(CW), core(CW)]),
  of("disjoint-cw-ccw", [rect(100, 100, 180, 180, CW), rect(220, 100, 300, 180, CCW)]),
  of("overlap-cw-cw", [rect(100, 100, 200, 180, CW), rect(150, 140, 260, 220, CW)]),
  of("overlap-cw-ccw", [rect(100, 100, 200, 180, CW), rect(150, 140, 260, 220, CCW)]),
];

/** What Illustrator's compound path PAINTS (its own rule: non-zero). */
const ILLUSTRATOR_PAINTS: Record<string, number> = {
  "nested-cw-cw": 30000,
  "nested-cw-ccw": 30000,
  "nested-ccw-ccw": 30000,
  "nested-hole-behind-cw-cw": 30000,
  "three-deep-cw-cw-cw": 31600,
  "four-deep-cw-cw-cw-cw": 31600, // even-odd would be 31200
  "disjoint-cw-ccw": 12800,
  "overlap-cw-cw": 12800, // the union would be 14800
  "overlap-cw-ccw": 12800,
};

/** DEFECT (parity) — bundle 31200 vs Illustrator 31600. */
const BUNDLE_IS_EVEN_ODD = new Set(["four-deep-cw-cw-cw-cw"]);

/** CONVENTION — each contour's direction, `[bundle, Illustrator]`, with
 *  the contours ordered largest first (ties: leftmost first). */
const CONTOUR_DIRECTIONS: Record<string, [Winding[], Winding[]]> = {
  "nested-cw-cw": [
    ["cw", "ccw"],
    ["cw", "ccw"],
  ],
  "nested-cw-ccw": [
    ["cw", "ccw"],
    ["cw", "ccw"],
  ],
  "nested-ccw-ccw": [
    ["ccw", "cw"],
    ["cw", "ccw"],
  ],
  "nested-hole-behind-cw-cw": [
    ["ccw", "cw"],
    ["ccw", "cw"],
  ],
  "three-deep-cw-cw-cw": [
    ["cw", "ccw", "cw"],
    ["cw", "ccw", "ccw"],
  ],
  "four-deep-cw-cw-cw-cw": [
    ["cw", "ccw", "cw", "ccw"],
    ["cw", "ccw", "ccw", "ccw"],
  ],
  "disjoint-cw-ccw": [
    ["cw", "cw"],
    ["cw", "ccw"],
  ],
  "overlap-cw-cw": [
    ["ccw", "cw"],
    ["ccw", "cw"],
  ],
  "overlap-cw-ccw": [
    ["ccw", "cw"],
    ["ccw", "cw"],
  ],
};

const largestFirst = (paths: readonly OraclePath[]): OraclePath[] =>
  [...paths].sort(
    (a, b) =>
      Math.abs(signedArea(b)) - Math.abs(signedArea(a)) || pathBounds(a)[0] - pathBounds(b)[0],
  );
const directions = (paths: readonly OraclePath[]): Winding[] =>
  largestFirst(paths).map((p) => windingOf(signedArea(p)));

const FIXTURE = loadOracle<Record<string, never>>("compound-path");
const RECORDED = new Map(FIXTURE.cases.map((c) => [c.id, c]));

describe("oracle — compound path winding", () => {
  let h: HeadlessHost;
  const bundleResults = new Map<string, { leavesGone: number; paths: OraclePath[] }>();

  beforeAll(async () => {
    h = await openOracleHost();
  });
  afterAll(() => h?.dispose());

  /** The bundle's answer to one case: select the inputs in paint order
   *  (the first, backmost, is the survivor), run the recorded Make
   *  command, read the survivor's contours. */
  async function bundle(c: CompoundCase) {
    const cached = bundleResults.get(c.id);
    if (cached) return cached;
    const make = h.contributions.find(
      (x) => x.kind === "command" && x.id === MAKE_COMPOUND_PATH_COMMAND_ID,
    )!.value as CommandContribution;
    const result = await onEngine(h, c.input.paths, async (run) => {
      const before = (await leafIds(h)).length;
      await h.host.selection.set(run.ids);
      await make.handler({} as never, undefined as never);
      run.took(1); // Make is ONE batch — one undo step
      await h.host.selection.set([]);
      return {
        leavesGone: before - (await leafIds(h)).length,
        paths: await pathsOf(h, run.ids[0]),
      };
    });
    bundleResults.set(c.id, result);
    return result;
  }

  describe("the recording", () => {
    it("says who made it", () => {
      expect(FIXTURE.produced_by.app).toBe("Adobe Illustrator");
      expect(FIXTURE.produced_by.version).toMatch(/^\d+\.\d+/);
      expect(FIXTURE.produced_by.script).toBe("scripts/illustrator/probes/compound-path.jsx");
    });

    it("has exactly this spec's cases (probe and spec have not drifted)", () => {
      expect(
        FIXTURE.cases.map((c) => ({
          id: c.id,
          input: c.input,
          parameters: c.parameters,
        })),
      ).toEqual(COMPOUND_PATH_CASES);
      const ids = COMPOUND_PATH_CASES.map((c) => c.id);
      expect(Object.keys(ILLUSTRATOR_PAINTS)).toEqual(ids);
      expect(Object.keys(CONTOUR_DIRECTIONS)).toEqual(ids);
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

  describe("Illustrator's rule", () => {
    it("ONE compound path, one subpath per input, nothing moved", () => {
      for (const c of FIXTURE.cases) {
        const got = c.measured.paths;
        expect(got, c.id).toHaveLength(c.input.paths.length);
        for (const p of got) expect(p.compound, c.id).toBe(0);
        // Subpaths come back FRONT to back; the geometry is the inputs'.
        const inputs = [...c.input.paths].reverse();
        got.forEach((p, i) => {
          expect(boundsDiff(p.bounds, pathBounds(inputs[i])), `${c.id} subpath ${i}`).toBe(0);
          expect(p.anchors, `${c.id} subpath ${i}`).toHaveLength(4);
        });
      }
    });

    it("the fill rule stays NON-ZERO — never even-odd", () => {
      for (const c of FIXTURE.cases) {
        for (const p of c.measured.paths) {
          expect(p.evenodd, c.id).toBe(false);
        }
      }
    });

    it("direction follows PAINT ORDER: the backmost path clockwise, every other counter-clockwise — whatever the inputs were", () => {
      for (const c of FIXTURE.cases) {
        const got = c.measured.paths; // front to back
        const back = got[got.length - 1];
        expect(back.winding, `${c.id}: backmost`).toBe("cw");
        expect(back.polarity, `${c.id}: backmost`).toBe("positive");
        for (const p of got.slice(0, -1)) {
          expect(p.winding, `${c.id}: not backmost`).toBe("ccw");
          expect(p.polarity, `${c.id}: not backmost`).toBe("negative");
        }
        expect(directions(got), c.id).toEqual(CONTOUR_DIRECTIONS[c.id][1]);
      }
    });

    it("what that rule paints: a hole, an island, a knocked-out overlap — and a SOLID core three levels deep", () => {
      for (const c of FIXTURE.cases) {
        expect(paintedArea(c.measured.paths, "nonzero"), c.id).toBeCloseTo(
          ILLUSTRATOR_PAINTS[c.id],
          6,
        );
      }
      // The one case where the rule is not even-odd in disguise.
      const four = RECORDED.get("four-deep-cw-cw-cw-cw")!.measured.paths;
      expect(paintedArea(four, "nonzero")).toBeCloseTo(31600, 6);
      expect(paintedArea(four, "evenodd")).toBeCloseTo(31200, 6);
      // And overlapping is not nesting, yet the overlap still goes.
      const overlap = RECORDED.get("overlap-cw-cw")!.measured.paths;
      expect(paintedArea(overlap, "nonzero")).toBeCloseTo(14800 - 2000, 6);
    });
  });

  describe("bundle vs Adobe Illustrator", () => {
    for (const c of COMPOUND_PATH_CASES) {
      const defect = BUNDLE_IS_EVEN_ODD.has(c.id);
      const test = defect ? it.fails : it;
      test(`${c.id}: paints what Illustrator's compound path paints${defect ? " — DEFECT (parity): bundle 31200 (even-odd), Illustrator 31600 (non-zero)" : ""}`, async () => {
        const ours = await bundle(c);
        // The engine fills non-zero.
        expect(
          relDiff(paintedArea(ours.paths, "nonzero"), ILLUSTRATOR_PAINTS[c.id]),
        ).toBeLessThan(AREA_REL_TOL);
      });
    }

    it("the same structure: one element left, one closed contour per input, nothing moved", async () => {
      for (const c of COMPOUND_PATH_CASES) {
        const ours = await bundle(c);
        expect(ours.leavesGone, c.id).toBe(c.input.paths.length - 1);
        expect(ours.paths, c.id).toHaveLength(c.input.paths.length);
        const want = largestFirst(RECORDED.get(c.id)!.measured.paths);
        largestFirst(ours.paths).forEach((p, i) => {
          expect(p.closed, c.id).toBe(true);
          expect(p.anchors, c.id).toHaveLength(4);
          expect(boundsDiff(pathBounds(p), pathBounds(want[i])), c.id).toBeLessThan(
            BOUNDS_ABS_TOL,
          );
        });
      }
    });

    it("DEFECT pinned — the bundle's rule IS even-odd: it paints the even-odd region of the inputs in every case", async () => {
      for (const c of COMPOUND_PATH_CASES) {
        const ours = await bundle(c);
        const painted = paintedArea(ours.paths, "nonzero");
        expect(relDiff(painted, paintedArea(c.input.paths, "evenodd")), c.id).toBeLessThan(
          AREA_REL_TOL,
        );
      }
      // Which is Illustrator's region too, until the nesting is 3 deep.
      const ours = await bundle(COMPOUND_PATH_CASES.find((c) => BUNDLE_IS_EVEN_ODD.has(c.id))!);
      expect(paintedArea(ours.paths, "nonzero")).toBeCloseTo(31200, 6);
      expect(ILLUSTRATOR_PAINTS["four-deep-cw-cw-cw-cw"]).toBe(31600);
    });

    it("CONVENTION — contour directions: by nesting depth here, by paint order there", async () => {
      let differing = 0;
      for (const c of COMPOUND_PATH_CASES) {
        const [oursWant, theirsWant] = CONTOUR_DIRECTIONS[c.id];
        expect(directions((await bundle(c)).paths), `${c.id}: bundle`).toEqual(oursWant);
        expect(directions(RECORDED.get(c.id)!.measured.paths), `${c.id}: Illustrator`).toEqual(
          theirsWant,
        );
        if (String(oursWant) !== String(theirsWant)) differing++;
      }
      expect(differing).toBe(4);
    });

    it("CONVENTION — contour order: the survivor first and back to front here, front to back there", async () => {
      const c = COMPOUND_PATH_CASES.find((x) => x.id === "three-deep-cw-cw-cw")!;
      const sizes = (paths: readonly OraclePath[]) => paths.map((p) => Math.abs(signedArea(p)));
      expect(sizes((await bundle(c)).paths)).toEqual([40000, 10000, 1600]);
      expect(sizes(RECORDED.get(c.id)!.measured.paths)).toEqual([1600, 10000, 40000]);
    });
  });
});
