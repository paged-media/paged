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

// ORACLE — Outline Stroke. The engine's `outlineStroke { elementId, width,
// cap, join, miterLimit }` against the stroke's closed-form definition and
// against ADOBE ILLUSTRATOR 30.1.0 (Object > Path > Outline Stroke),
// recorded 2026-10-02 by
//   scripts/illustrator/run-probe.sh scripts/illustrator/probes/outline-stroke.jsx \
//     packages/draw-bundle/test/fixtures/oracle/outline-stroke.illustrator.json
//
// 11 cases: butt / round / square caps × miter / round / bevel joins on an
// open 3-point path (width 20), plus two miter-limit cases on a sharper one.
//
// WHAT ILLUSTRATOR SAID, against the definition:
//   * It IS the definition: 4000 / 3996.365 / 3990 for miter / round / bevel,
//     +400 for square caps, bounds exact. Miter limit is the same rule as
//     Offset Path's (ratio 1.6667: mitered at limit 2, bevelled at 1.5).
//   * Round caps and joins are cubic arcs, so a round cap pair adds 314.247,
//     not π·10² = 314.159 (+0.03 % of the disc), and the bounds overshoot by
//     0.0005 pt.
//   * The result is ONE SIMPLE closed path — it does not overlap itself —
//     and it is clockwise, like every Offset Path result.
//   * Not predicted: the sharp-corner cases land on a coarse grid. The miter
//     tip is at y = 83.333496 (exact 83.3333…) and the area is 3999.980,
//     not 4000.
//
// WHAT THE ENGINE DOES, against Illustrator (engine pin: canvas-wasm 0.64.0):
//   AGREEMENT on what gets painted: the painted area and the bounds match in
//   all 11 cases (largest gap 0.02 pt² on the round caps), cap, join and
//   miter limit all honoured. Both results are clockwise.
//
//   CONVENTION — the engine's outline OVERLAPS ITSELF. It is the raw stroke
//   expansion: the inner side of the corner is drawn as a loop through the
//   source vertex, so that region has winding 2. Under the engine's non-zero
//   fill that paints correctly, and core says so. The consequences are
//   pinned below with both numbers:
//     - signed area exceeds painted area by the loop (10 pt² on the 126.87°
//       corner, 85.33 pt² on the sharp one); Illustrator's are equal;
//     - under an EVEN-ODD fill the loop becomes a hole — the same outline
//       paints 3990 instead of 4000;
//     - the anchor count is higher: 9 vs 6 (butt/miter), 13 vs 6
//       (square/miter), see ENGINE_VS_ILLUSTRATOR_ANCHORS.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { outlineStrokeMutationFor } from "../../src";
import { onEngine, openOracleHost, pathsOf } from "./engine";
import {
  AREA_REL_TOL,
  BOUNDS_ABS_TOL,
  boundsDiff,
  loadOracle,
  paintedArea,
  pathBounds,
  relDiff,
  signedArea,
  summarize,
  windingOf,
  type OraclePath,
  type ShapeSummary,
  type Vec2,
} from "./oracle";

type Cap = "butt" | "round" | "square";
type Join = "miter" | "round" | "bevel";
interface OutlineParameters {
  width: number;
  cap: Cap;
  join: Join;
  miterLimit: number;
}
interface OutlineCase {
  id: string;
  input: { paths: OraclePath[] };
  parameters: OutlineParameters;
}

// --- the cases: a MIRROR of scripts/illustrator/probes/outline-stroke.jsx ---

const openPolyline = (points: readonly Vec2[]): OraclePath => ({
  closed: false,
  anchors: points.map((p) => ({
    anchor: [p[0], p[1]],
    left: [p[0], p[1]],
    right: [p[0], p[1]],
  })),
});

/** Two 100 pt segments (a 3-4-5 leg, then a horizontal); the corner turns
 *  by 53.13° (interior 126.87°, miter ratio 1.118). */
const BENT: Vec2[] = [
  [100, 180],
  [160, 100],
  [260, 100],
];
/** Two 3-4-5 legs meeting at 73.74° — miter ratio 1/sin(36.87°) = 1.6667. */
const SHARP: Vec2[] = [
  [100, 180],
  [160, 100],
  [220, 180],
];
const WIDTH = 20;

const OUTLINE_STROKE_CASES: OutlineCase[] = [
  ...(["butt", "round", "square"] as const).flatMap((cap) =>
    (["miter", "round", "bevel"] as const).map((join) => ({
      id: `${cap}-${join}`,
      input: { paths: [openPolyline(BENT)] },
      parameters: { width: WIDTH, cap, join, miterLimit: 4 },
    })),
  ),
  {
    id: "sharp-butt-miter-limit1_5",
    input: { paths: [openPolyline(SHARP)] },
    parameters: { width: WIDTH, cap: "butt", join: "miter", miterLimit: 1.5 },
  },
  {
    id: "sharp-butt-miter-limit2",
    input: { paths: [openPolyline(SHARP)] },
    parameters: { width: WIDTH, cap: "butt", join: "miter", miterLimit: 2 },
  },
];

// --- reference 1: the definition -------------------------------------------
// A stroke of width w = 2h along a polyline of length L, turning by t at its
// one corner, paints  w·L − h²·tan(t/2)  (the two rectangles overlap on the
// inside) plus the join's fill of the outside gap:
//     miter h²·tan(t/2)   round ½·h²·t   bevel ½·h²·sin(t)
// plus the caps:  butt 0 · square 2·w·h · round π·h².
//
// BENT: w·L = 4000, t = 53.13° (0.9273 rad), tan(t/2) = ½, sin t = 0.8.
//     miter 4000 · round 4000 − 50 + 46.365 = 3996.365 · bevel 4000 − 50 + 40 = 3990
//     square +400 · round +100π
// SHARP: t = 106.26°, tan(t/2) = 4/3, sin t = 0.96.
//     miter 4000 · bevelled (limit 1.5 < 1.6667) 4000 − 133.333 + 48 = 3914.667
//
// Bounds. BENT's offset corners are (108,186),(92,174) at the start and
// (260,90),(260,110) at the end; the outside of the corner tops out at
// y = 90 for every join. A square cap pushes the start 10 pt back along the
// segment — (102,194),(86,182) — and the end to x = 270; a round cap is a
// disc of radius 10 about each end. SHARP's miter tip is (160, 100 − 50/3);
// bevelled, its top is y = 94.
const JOIN_AREA = { miter: 4000, round: 3950 + 50 * Math.atan2(4, 3), bevel: 3990 };
const CAP_AREA = { butt: 0, round: 100 * Math.PI, square: 400 };
const CAP_BOUNDS: Record<Cap, [number, number, number, number]> = {
  butt: [92, 90, 260, 186],
  round: [90, 90, 270, 190],
  square: [86, 90, 270, 194],
};
const BY_DEFINITION: Record<
  string,
  { area: number; bounds: [number, number, number, number] }
> = {
  ...Object.fromEntries(
    (["butt", "round", "square"] as const).flatMap((cap) =>
      (["miter", "round", "bevel"] as const).map((join) => [
        `${cap}-${join}`,
        { area: JOIN_AREA[join] + CAP_AREA[cap], bounds: CAP_BOUNDS[cap] },
      ]),
    ),
  ),
  "sharp-butt-miter-limit1_5": { area: 4000 - 400 / 3 + 48, bounds: [92, 94, 228, 186] },
  "sharp-butt-miter-limit2": { area: 4000, bounds: [92, 100 - 50 / 3, 228, 186] },
};

/** CONVENTION — anchor count, `[engine, Illustrator]`. The engine keeps the
 *  raw expansion (inner-join loop, cap corners as extra points); Illustrator
 *  returns the simple outline. */
const ENGINE_VS_ILLUSTRATOR_ANCHORS: Record<string, [number, number]> = {
  "butt-miter": [9, 6],
  "butt-round": [8, 7],
  "butt-bevel": [8, 7],
  "round-miter": [12, 9],
  "round-round": [11, 10],
  "round-bevel": [11, 10],
  "square-miter": [13, 6],
  "square-round": [12, 7],
  "square-bevel": [12, 7],
  "sharp-butt-miter-limit1_5": [8, 7],
  "sharp-butt-miter-limit2": [9, 6],
};

/** CONVENTION — the area the engine's inner-join loop covers twice. */
const ENGINE_LOOP_AREA = (id: string): number => (id.startsWith("sharp") ? 256 / 3 : 10);

const FIXTURE = loadOracle<OutlineParameters>("outline-stroke");
const RECORDED = new Map(FIXTURE.cases.map((c) => [c.id, c]));
const theirs = (id: string): ShapeSummary => summarize(RECORDED.get(id)!.measured.paths);

describe("oracle — outline stroke", () => {
  let h: HeadlessHost;
  const engineResults = new Map<string, { paths: OraclePath[]; shape: ShapeSummary }>();

  beforeAll(async () => {
    h = await openOracleHost();
  });
  afterAll(() => h?.dispose());

  /** The engine's answer to one case, measured once. */
  async function engine(c: OutlineCase) {
    const cached = engineResults.get(c.id);
    if (cached) return cached;
    const paths = await onEngine(h, c.input.paths, async (run) => {
      await run.apply(outlineStrokeMutationFor(run.ids[0], c.parameters));
      return pathsOf(h, run.ids[0]);
    });
    const result = { paths, shape: summarize(paths) };
    engineResults.set(c.id, result);
    return result;
  }

  describe("the recording", () => {
    it("says who made it", () => {
      expect(FIXTURE.produced_by.app).toBe("Adobe Illustrator");
      expect(FIXTURE.produced_by.version).toMatch(/^\d+\.\d+/);
      expect(FIXTURE.produced_by.script).toBe(
        "scripts/illustrator/probes/outline-stroke.jsx",
      );
    });

    it("has exactly this spec's cases (probe and spec have not drifted), each with a definition", () => {
      expect(
        FIXTURE.cases.map((c) => ({
          id: c.id,
          input: c.input,
          parameters: c.parameters,
        })),
      ).toEqual(OUTLINE_STROKE_CASES);
      const ids = OUTLINE_STROKE_CASES.map((c) => c.id);
      expect(Object.keys(BY_DEFINITION)).toEqual(ids);
      expect(Object.keys(ENGINE_VS_ILLUSTRATOR_ANCHORS)).toEqual(ids);
    });

    it("is self-consistent: Illustrator's area and bounds and the probe's winding match the anchors it recorded", () => {
      for (const c of FIXTURE.cases) {
        expect(c.measured.paths, c.id).toHaveLength(1);
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

  describe("Illustrator vs the stroke's definition", () => {
    it("every case is the cap and join that were ASKED for, in area and bounds", () => {
      for (const c of FIXTURE.cases) {
        const got = theirs(c.id);
        const want = BY_DEFINITION[c.id];
        expect(relDiff(got.netArea, want.area), `${c.id} area`).toBeLessThan(AREA_REL_TOL);
        expect(boundsDiff(got.bounds, want.bounds), `${c.id} bounds`).toBeLessThan(
          BOUNDS_ABS_TOL,
        );
      }
    });

    it("the result is ONE simple, closed, clockwise outline", () => {
      for (const c of FIXTURE.cases) {
        const got = theirs(c.id);
        expect(got.paths, c.id).toBe(1);
        expect(got.allClosed, c.id).toBe(true);
        expect(got.windings, c.id).toEqual(["cw"]);
        // Simple: what it paints is what it encloses. (0.2 pt² is far
        // above the flattening error of two round caps, about 0.01.)
        expect(Math.abs(got.netArea - got.fillArea), c.id).toBeLessThan(0.2);
        expect(paintedArea(RECORDED.get(c.id)!.measured.paths, "evenodd"), c.id).toBeCloseTo(
          got.fillArea,
          6,
        );
      }
    });

    it("miter limit is the stroke rule: ratio 1.6667 is mitered at limit 2, bevelled at 1.5", () => {
      expect(theirs("sharp-butt-miter-limit2").anchors).toBe(6);
      expect(theirs("sharp-butt-miter-limit1_5").anchors).toBe(7);
    });

    it("what the definition does not predict: arc bulge, and a coarse grid on the sharp corner", () => {
      // A round cap pair measures 314.247, not π·100 = 314.159.
      expect(theirs("round-miter").area - theirs("butt-miter").area).toBeCloseTo(314.247, 2);
      // One cubic for the 53.13° round join; two per semicircular cap, and
      // one arc split at the path's start point: 5 curved segments, not 4.
      expect(theirs("butt-round").curvedSegments).toBe(1);
      expect(theirs("round-miter").curvedSegments).toBe(5);
      // The miter tip belongs at y = 83.3333…; Illustrator has 83.333496,
      // and 3999.980 pt² where the definition is 4000.
      const sharp = theirs("sharp-butt-miter-limit2");
      expect(sharp.bounds[1]).toBeCloseTo(83.333496, 6);
      expect(sharp.area).toBeCloseTo(3999.98, 2);
    });
  });

  describe("engine vs the stroke's definition", () => {
    for (const c of OUTLINE_STROKE_CASES) {
      it(`${c.id}: painted area and bounds`, async () => {
        const ours = (await engine(c)).shape;
        const want = BY_DEFINITION[c.id];
        expect(ours.paths).toBe(1);
        expect(ours.allClosed).toBe(true);
        expect(relDiff(ours.fillArea, want.area)).toBeLessThan(AREA_REL_TOL);
        expect(boundsDiff(ours.bounds, want.bounds)).toBeLessThan(BOUNDS_ABS_TOL);
      });
    }
  });

  describe("engine vs Adobe Illustrator", () => {
    for (const c of OUTLINE_STROKE_CASES) {
      it(`${c.id}: one closed path, same painted area, same bounds, same direction`, async () => {
        const ours = (await engine(c)).shape;
        const want = theirs(c.id);
        expect(ours.paths).toBe(want.paths);
        expect(ours.allClosed).toBe(want.allClosed);
        expect(relDiff(ours.fillArea, want.fillArea)).toBeLessThan(AREA_REL_TOL);
        expect(boundsDiff(ours.bounds, want.bounds)).toBeLessThan(BOUNDS_ABS_TOL);
        expect(ours.windings).toEqual(want.windings);
      });
    }

    it("CONVENTION — the engine's outline overlaps itself; Illustrator's does not", async () => {
      for (const c of OUTLINE_STROKE_CASES) {
        const { paths, shape: ours } = await engine(c);
        const want = theirs(c.id);
        const loop = ENGINE_LOOP_AREA(c.id);
        // Signed area counts the inner-join loop twice…
        expect(ours.netArea - ours.fillArea, `${c.id}: engine loop`).toBeGreaterThan(loop - 0.2);
        expect(ours.netArea - ours.fillArea, `${c.id}: engine loop`).toBeLessThan(loop + 0.2);
        expect(Math.abs(want.netArea - want.fillArea), `${c.id}: Illustrator`).toBeLessThan(0.2);
        // …and an even-odd fill turns it into a hole.
        expect(
          ours.fillArea - paintedArea(paths, "evenodd"),
          `${c.id}: even-odd loses the loop`,
        ).toBeCloseTo(loop, 1);
      }
    });

    it("CONVENTION — anchor count: the raw expansion carries more anchors than Illustrator's outline", async () => {
      for (const c of OUTLINE_STROKE_CASES) {
        const [oursWant, theirsWant] = ENGINE_VS_ILLUSTRATOR_ANCHORS[c.id];
        expect((await engine(c)).shape.anchors, `${c.id}: engine`).toBe(oursWant);
        expect(theirs(c.id).anchors, `${c.id}: Illustrator`).toBe(theirsWant);
        expect(oursWant, c.id).toBeGreaterThan(theirsWant);
      }
    });
  });
});
