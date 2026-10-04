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

// ORACLE — Offset Path. The engine's `offsetPath { elementId, delta, join,
// miterLimit }` against two references:
//
//   1. THE JOIN'S DEFINITION (closed form). A miter, round or bevel offset
//      of a convex polygon has an exact area and exact bounds.
//   2. ADOBE ILLUSTRATOR 30.1.0, recorded 2026-10-02 by
//        scripts/illustrator/run-probe.sh scripts/illustrator/probes/offset-path.jsx \
//          packages/draw-bundle/test/fixtures/oracle/offset-path.illustrator.json
//      and replayed here. CI never drives Illustrator.
//
// WHAT ILLUSTRATOR SAID, against the definition (17 cases):
//
//   * It IS the definition, to the digit, for every miter, bevel and inward
//     case: areas 9600 / 9400 / 3200 / 9120 / 2400 exactly, bounds exactly.
//   * MITER LIMIT is the stroke definition: the corner is mitered while
//     1/sin(angle/2) <= limit and BEVELLED past it. The triangle's sharpest
//     corner has ratio 3.1623 — limit 3.2 miters it (area 9600), limit 3.1
//     bevels it (9330), limit 2 also bevels the 2.2361 corner (9170).
//   * ROUND joins are cubic arcs with the standard handle (4/3)·tan(θ/4)·r:
//     one cubic for a 90° corner, TWO equal cubics for the triangle's 126.87°
//     and 143.13° corners. That approximation bulges: the rectangle measures
//     9514.249 where the definition is 9514.159 (+0.0009 %), and the
//     triangle's right bound is 230.0007, not 230. Both are far inside the
//     tolerances; they are pinned below so a re-recording that changes them
//     is noticed.
//   * DIRECTION IS NORMALISED. Every result is CLOCKWISE on the page
//     (`polarity` positive, Illustrator's own `area` positive) whether the
//     input was clockwise or counter-clockwise, outward or inward.
//   * One thing no definition predicts: `tri-round-out` has 9 anchors, not
//     8. The path STARTS at its lowest point, which falls inside an arc, and
//     the arc is split there.
//   * A straight edge is two corner points with collapsed handles.
//
// WHAT THE ENGINE DOES, against Illustrator (engine pin: canvas-wasm 0.65.0):
//
//   FIXED in 0.65.0 — `join` and `miterLimit` are honoured. On 0.64.0 every
//   outward corner was a bevel (core `offset_closed_path` took `_join` /
//   `_miter_limit`): area 9400 for a miter asked of the rectangle, 9120
//   for every triangle case. Now all seventeen match Illustrator in AREA
//   and BOUNDS, and every miter-limit case bevels exactly where the stroke
//   definition says.
//
//   FIXED in 0.65.0 — direction. 0.64.0 had no convention (5 of 17 agreed
//   with Illustrator's clockwise, by accident of the crossing resolver);
//   0.65.0 returns every result clockwise, as Illustrator does (RFI C-81).
//
//   CONVENTION, not a defect — ANCHOR COUNT on a mitered or rounded
//   outward corner. A miter apex arrives with the two edge endpoints it
//   was built from still in the table, collinear with their edges:
//   12 anchors for the rectangle where Illustrator has 4, 9 for the
//   triangle where it has 3. The shape is identical (area and bounds
//   above); only a later anchor edit can tell. The round join spends one
//   cubic fewer than Illustrator on the triangle (8 vs 9 anchors) and
//   matches it on the rectangle. ENGINE_ANCHOR_CONVENTION pins both
//   counts, so a change either way is seen.
//
//   AGREEMENT — the other nine cases (bevel outward, every inward offset)
//   match Illustrator in area, bounds AND anchor count.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { drawBundle, offsetPathMutationFor } from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "../conformance/host";
import {
  AREA_REL_TOL,
  BOUNDS_ABS_TOL,
  boundsDiff,
  loadOracle,
  pathBounds,
  pathsOfTable,
  polygon,
  relDiff,
  signedArea,
  summarize,
  windingOf,
  type OraclePath,
  type ShapeSummary,
  type Vec2,
} from "./oracle";

type Join = "miter" | "round" | "bevel";
interface OffsetParameters {
  delta: number;
  join: Join;
  miterLimit: number;
}
interface OffsetCase {
  id: string;
  input: { paths: OraclePath[] };
  parameters: OffsetParameters;
}

// --- the cases: a MIRROR of scripts/illustrator/probes/offset-path.jsx -----
// Points, page-local, Y down. RECT and TRI are drawn clockwise.

/** 100 x 60. Area 6000, perimeter 320. */
const RECT: Vec2[] = [
  [100, 100],
  [200, 100],
  [200, 160],
  [100, 160],
];
/** The same rectangle, counter-clockwise. */
const RECT_CCW: Vec2[] = [RECT[0], RECT[3], RECT[2], RECT[1]];
/** A 3-4-5 right triangle: legs 120 and 90, hypotenuse 150. Area 5400,
 *  perimeter 360, inradius 30, incentre (130,130). Corners 90°, 36.87°
 *  (miter ratio 3.1623) and 53.13° (2.2361). */
const TRI: Vec2[] = [
  [100, 100],
  [220, 100],
  [100, 190],
];
const MITER_LIMIT = 4;
const DELTAS = [
  ["out", 10],
  ["in", -10],
] as const;

const OFFSET_PATH_CASES: OffsetCase[] = [
  ...(
    [
      ["rect", RECT],
      ["tri", TRI],
    ] as const
  ).flatMap(([shape, points]) =>
    (["miter", "round", "bevel"] as const).flatMap((join) =>
      DELTAS.map(([dir, delta]) => ({
        id: `${shape}-${join}-${dir}`,
        input: { paths: [polygon(points)] },
        parameters: { delta, join, miterLimit: MITER_LIMIT },
      })),
    ),
  ),
  // Direction: is the result's direction kept, reversed, or normalised?
  ...DELTAS.map(([dir, delta]) => ({
    id: `rectccw-miter-${dir}`,
    input: { paths: [polygon(RECT_CCW)] },
    parameters: { delta, join: "miter" as const, miterLimit: MITER_LIMIT },
  })),
  // Miter-limit semantics: 3.1 and 3.2 straddle the sharpest corner's
  // ratio; 2 also catches the 53.13° corner.
  ...(
    [
      ["2", 2],
      ["3_1", 3.1],
      ["3_2", 3.2],
    ] as const
  ).map(([name, miterLimit]) => ({
    id: `tri-miter-out-limit${name}`,
    input: { paths: [polygon(TRI)] },
    parameters: { delta: 10, join: "miter" as const, miterLimit },
  })),
];

// --- reference 1: the join's definition ------------------------------------
// For a convex polygon of area A and perimeter L, offset OUTWARD by d, with
// exterior (turning) angles t_i, a corner contributes
//     miter   d²·tan(t_i / 2)        round   ½·d²·t_i  (Σ = π·d²)
//     bevel   ½·d²·sin(t_i)
// on top of A + d·L. A miter whose ratio 1/sin(interior/2) exceeds the
// limit is a bevel. Offset INWARD by d (no edge vanishing) every join gives
//     A − d·L + d²·Σ tan(t_i / 2)
// because an inward corner is an intersection, not a join.
//
// RECT, d = 10: t = 90° ×4, Σtan = 4, Σsin = 4.
//     miter 6000+3200+400 = 9600 · round 9200+100π = 9514.159 · bevel 9400
//     inward 6000−3200+400 = 3200
// TRI, d = 10: t = 90°, 143.13°, 126.87°; tan(t/2) = 1, 3, 2; sin t = 1, 0.6, 0.8.
//     miter 5400+3600+600 = 9600 · round 9000+100π = 9314.159
//     bevel 5400+3600+120 = 9120 · inward 5400−3600+600 = 2400
//     limit 3.1: the 3.1623 corner bevels, 300 → 30:            9330
//     limit 2:   the 2.2361 corner bevels too, 200 → 40:        9170
//
// Bounds. A miter (and an inward) offset of the triangle is the triangle
// scaled about its incentre (130,130) by (30±10)/30. A round offset's
// bounds are the input's grown by d. A bevelled corner yields two points
// (corner + d·normal of either edge): (220,90),(226,108) at the sharp
// corner, (106,198),(90,190) at the 53.13° one.
const R = 100 * Math.PI;
const BY_DEFINITION: Record<
  string,
  { area: number; bounds: [number, number, number, number] }
> = {
  "rect-miter-out": { area: 9600, bounds: [90, 90, 210, 170] },
  "rect-miter-in": { area: 3200, bounds: [110, 110, 190, 150] },
  "rect-round-out": { area: 9200 + R, bounds: [90, 90, 210, 170] },
  "rect-round-in": { area: 3200, bounds: [110, 110, 190, 150] },
  "rect-bevel-out": { area: 9400, bounds: [90, 90, 210, 170] },
  "rect-bevel-in": { area: 3200, bounds: [110, 110, 190, 150] },
  "tri-miter-out": { area: 9600, bounds: [90, 90, 250, 210] },
  "tri-miter-in": { area: 2400, bounds: [110, 110, 190, 170] },
  "tri-round-out": { area: 9000 + R, bounds: [90, 90, 230, 200] },
  "tri-round-in": { area: 2400, bounds: [110, 110, 190, 170] },
  "tri-bevel-out": { area: 9120, bounds: [90, 90, 226, 198] },
  "tri-bevel-in": { area: 2400, bounds: [110, 110, 190, 170] },
  "rectccw-miter-out": { area: 9600, bounds: [90, 90, 210, 170] },
  "rectccw-miter-in": { area: 3200, bounds: [110, 110, 190, 150] },
  "tri-miter-out-limit2": { area: 9170, bounds: [90, 90, 226, 198] },
  "tri-miter-out-limit3_1": { area: 9330, bounds: [90, 90, 226, 210] },
  "tri-miter-out-limit3_2": { area: 9600, bounds: [90, 90, 250, 210] },
};

/** CONVENTION (engine 0.65.0) — anchor count where the engine and
 *  Illustrator spend a different number of points on the same shape:
 *  [engine, Illustrator]. See the header. */
const ENGINE_ANCHOR_CONVENTION: Record<string, [engine: number, illustrator: number]> = {
  "rect-miter-out": [12, 4],
  "rectccw-miter-out": [12, 4],
  "tri-miter-out": [9, 3],
  "tri-miter-out-limit2": [7, 5],
  "tri-miter-out-limit3_1": [8, 4],
  "tri-miter-out-limit3_2": [9, 3],
  "tri-round-out": [8, 9],
};

const FIXTURE = loadOracle<OffsetParameters>("offset-path");
const RECORDED = new Map(FIXTURE.cases.map((c) => [c.id, c]));
const theirs = (id: string): ShapeSummary => summarize(RECORDED.get(id)!.measured.paths);

describe("oracle — offset path", () => {
  let h: HeadlessHost;
  const engineResults = new Map<string, { paths: OraclePath[]; shape: ShapeSummary }>();

  beforeAll(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  /** Build the case's input in the real engine, apply the bundle's own
   *  `offsetPath` mutation, read the result back, and undo both steps.
   *  Measured once per case; both references read the same answer. */
  async function engine(c: OffsetCase) {
    const cached = engineResults.get(c.id);
    if (cached) return cached;
    const [input] = c.input.paths;
    const inserted = await h.host.document.mutate({
      op: "insertPath",
      args: {
        pageId: F1_MULTI_SHAPE.pageId,
        anchors: input.anchors,
        open: !input.closed,
      },
    });
    if (!inserted.applied || !inserted.createdId) {
      throw new Error(`${c.id}: insertPath was refused`);
    }
    const id = inserted.createdId;
    const outcome = await h.host.document.mutate(
      offsetPathMutationFor(id, c.parameters),
    );
    if (!outcome.applied) throw new Error(`${c.id}: offsetPath was refused`);
    const table = await h.host.document.pathAnchors(id);
    if (!table) throw new Error(`${c.id}: no anchor table after offsetPath`);
    const paths = pathsOfTable(table);
    await h.host.document.undo(); // the offset
    await h.host.document.undo(); // the scratch path
    const result = { paths, shape: summarize(paths) };
    engineResults.set(c.id, result);
    return result;
  }

  describe("the recording", () => {
    it("says who made it", () => {
      expect(FIXTURE.produced_by.app).toBe("Adobe Illustrator");
      expect(FIXTURE.produced_by.version).toMatch(/^\d+\.\d+/);
      expect(FIXTURE.produced_by.script).toBe(
        "scripts/illustrator/probes/offset-path.jsx",
      );
      expect(Number.isNaN(Date.parse(FIXTURE.produced_by.recorded_at))).toBe(false);
    });

    it("has exactly this spec's cases (probe and spec have not drifted), each with a definition", () => {
      expect(
        FIXTURE.cases.map((c) => ({
          id: c.id,
          input: c.input,
          parameters: c.parameters,
        })),
      ).toEqual(OFFSET_PATH_CASES);
      expect(Object.keys(BY_DEFINITION)).toEqual(OFFSET_PATH_CASES.map((c) => c.id));
      for (const id of Object.keys(ENGINE_ANCHOR_CONVENTION)) {
        expect(Object.keys(BY_DEFINITION)).toContain(id);
      }
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

  describe("Illustrator vs the join's definition", () => {
    it("every case is the join that was ASKED for, in area and bounds", () => {
      // Also the guard on the probe's `jntp` enumeration (0 round / 1 bevel /
      // 2 miter), which is in no dictionary: mis-mapped, "miter" would
      // measure a round join's area here.
      for (const c of FIXTURE.cases) {
        const got = theirs(c.id);
        const want = BY_DEFINITION[c.id];
        expect(relDiff(got.netArea, want.area), `${c.id} area`).toBeLessThan(AREA_REL_TOL);
        expect(boundsDiff(got.bounds, want.bounds), `${c.id} bounds`).toBeLessThan(
          BOUNDS_ABS_TOL,
        );
      }
    });

    it("miter limit is the stroke definition: mitered while 1/sin(angle/2) <= limit, bevelled past it", () => {
      // Sharpest corner 3.1623, next 2.2361. Anchor count = 3 corners plus
      // one per bevelled corner.
      expect(theirs("tri-miter-out-limit3_2").anchors).toBe(3);
      expect(theirs("tri-miter-out-limit3_1").anchors).toBe(4);
      expect(theirs("tri-miter-out-limit2").anchors).toBe(5);
      expect(theirs("tri-miter-out-limit3_2").area).toBe(9600);
      expect(theirs("tri-miter-out-limit3_1").area).toBe(9330);
      expect(theirs("tri-miter-out-limit2").area).toBe(9170);
    });

    it("direction is NORMALISED: every result is clockwise, whatever the input", () => {
      expect(windingOf(signedArea(polygon(RECT)))).toBe("cw");
      expect(windingOf(signedArea(polygon(RECT_CCW)))).toBe("ccw");
      for (const c of FIXTURE.cases) {
        const [p] = c.measured.paths;
        expect(p.winding, c.id).toBe("cw");
        expect(p.polarity, c.id).toBe("positive");
        expect(p.areaSignedApp, c.id).toBeGreaterThan(0);
      }
    });

    it("what the definition does not predict: the arc approximation and one split arc", () => {
      // One cubic per 90° corner: 4 arcs, 8 anchors, and a bulge of
      // +0.09 pt² over the exact 9514.159.
      const rect = theirs("rect-round-out");
      expect(rect.anchors).toBe(8);
      expect(rect.curvedSegments).toBe(4);
      expect(rect.area).toBeCloseTo(9514.249, 3);
      expect(rect.area - BY_DEFINITION["rect-round-out"].area).toBeGreaterThan(0.08);
      // The triangle: 90° is one cubic, 126.87° and 143.13° are two each —
      // 5 arcs, 8 anchors. Illustrator returns 9 anchors and 6 curved
      // segments: the path starts at its lowest point, (99.9985, 200),
      // which lies inside an arc, and that arc is split there.
      const tri = theirs("tri-round-out");
      expect(tri.anchors).toBe(9);
      expect(tri.curvedSegments).toBe(6);
      expect(tri.bounds[2]).toBeGreaterThan(230); // 230.0007: the bulge again
      // A straight edge has no handles at all.
      for (const id of ["rect-miter-out", "tri-bevel-out", "rect-round-in"]) {
        const [p] = RECORDED.get(id)!.measured.paths;
        for (const a of p.anchors) {
          expect(a.left, id).toEqual(a.anchor);
          expect(a.right, id).toEqual(a.anchor);
        }
      }
    });
  });

  describe("engine vs the join's definition", () => {
    for (const c of OFFSET_PATH_CASES) {
      it(c.id, async () => {
        const ours = (await engine(c)).shape;
        const want = BY_DEFINITION[c.id];
        expect(ours.paths).toBe(1);
        expect(ours.allClosed).toBe(true);
        expect(relDiff(ours.area, want.area)).toBeLessThan(AREA_REL_TOL);
        expect(boundsDiff(ours.bounds, want.bounds)).toBeLessThan(BOUNDS_ABS_TOL);
      });
    }

    it("FIXED in 0.65.0 — the join is honoured: miter, round and bevel are three shapes, and the miter limit decides", async () => {
      // On 0.64.0 all three joins, and every miter limit, gave ONE shape
      // (a bevel). Sequential on purpose: each measurement inserts,
      // offsets and undoes twice, and the undo stack is shared.
      const of = (id: string) => engine(OFFSET_PATH_CASES.find((c) => c.id === id)!);
      for (const shape of ["rect", "tri"]) {
        const miter = await of(`${shape}-miter-out`);
        const round = await of(`${shape}-round-out`);
        const bevel = await of(`${shape}-bevel-out`);
        expect(round.paths).not.toEqual(miter.paths);
        expect(bevel.paths).not.toEqual(miter.paths);
        expect(bevel.paths).not.toEqual(round.paths);
        expect(miter.shape.curvedSegments).toBe(0);
        expect(round.shape.curvedSegments).toBeGreaterThan(0);
      }
      // Limit 2 bevels the triangle's sharp corners; 3.2 miters them all.
      const limit2 = await of("tri-miter-out-limit2");
      const limit32 = await of("tri-miter-out-limit3_2");
      expect(limit2.shape.area).toBeLessThan(limit32.shape.area);
    });
  });

  describe("engine vs Adobe Illustrator", () => {
    for (const c of OFFSET_PATH_CASES) {
      const convention = ENGINE_ANCHOR_CONVENTION[c.id];
      it(`${c.id}: area, bounds, anchor count${convention ? ` — anchors by convention, engine ${convention[0]} vs Illustrator ${convention[1]}` : ""}`, async () => {
        const ours = (await engine(c)).shape;
        const want = theirs(c.id);
        expect(ours.paths).toBe(want.paths);
        expect(ours.allClosed).toBe(want.allClosed);
        expect(relDiff(ours.netArea, want.netArea)).toBeLessThan(AREA_REL_TOL);
        expect(boundsDiff(ours.bounds, want.bounds)).toBeLessThan(BOUNDS_ABS_TOL);
        if (convention) {
          expect(want.anchors).toBe(convention[1]);
          expect(ours.anchors).toBe(convention[0]);
        } else {
          expect(ours.anchors).toBe(want.anchors);
        }
      });
    }

    it("direction — FIXED in 0.65.0: every result is clockwise, as Illustrator's (0.64.0 agreed in 5 of 17, by accident)", async () => {
      for (const c of OFFSET_PATH_CASES) {
        const ours = (await engine(c)).shape.windings[0];
        const want = theirs(c.id).windings[0];
        expect(want, c.id).toBe("cw");
        expect(ours, c.id).toBe("cw");
      }
    });
  });
});
