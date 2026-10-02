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
//      of a convex polygon has an exact area and exact bounds; they need no
//      application to state, so this half runs everywhere, today.
//   2. ADOBE ILLUSTRATOR, recorded by
//        scripts/illustrator/run-probe.sh scripts/illustrator/probes/offset-path.jsx \
//          packages/draw-bundle/test/fixtures/oracle/offset-path.illustrator.json
//      and replayed here. CI never drives Illustrator.
//
// STATUS 2026-10-02 — the Illustrator half is NOT RECORDED. macOS had not
// been allowed to let the recording shell send Apple events to Illustrator
// (an unanswered Automation consent prompt; see scripts/illustrator/
// README.md), so there is no fixture and the replay below is an `it.todo`,
// not a pass. The closed-form half is real and already shows the engine's
// one difference:
//
//   THE ENGINE IGNORES `join` AND `miterLimit`. Every OUTWARD corner comes
//   back BEVELLED whatever join was asked for (core `paged-mutate`
//   `offset_closed_path` takes `_join` / `_miter_limit` and says so: "round/
//   miter joins are a follow-up"). Measured, engine vs definition:
//
//     case             engine area   definition    engine bounds        definition bounds
//     rect-miter-out      9400         9600        [90,90,210,170]      [90,90,210,170]
//     rect-round-out      9400         9514.159    [90,90,210,170]      [90,90,210,170]
//     tri-miter-out       9120         9600        [90,90,226,198]      [90,90,250,210]
//     tri-round-out       9120         9314.159    [90,90,226,198]      [90,90,230,200]
//
//   Classification: DEFECT (a wire parameter that is accepted and not
//   honoured), not a convention — a bevel is not a miter under any reading
//   of a miter limit: the triangle's sharpest corner has a miter ratio of
//   3.16, under the limit of 4. The four cases are `it.fails` below, so
//   they stay visible and flip RED the day the engine honours `join`.
//
//   The other eight cases agree exactly: bevel outward, and every inward
//   offset (an inward offset of a convex shape has no joins to choose).
//
// A SECOND OBSERVATION, not asserted here because only Illustrator can say
// what is right: the engine's output DIRECTION is not a function of its
// input's. Both inputs are clockwise (Y down). The rectangle comes back
// counter-clockwise when offset outward and clockwise when offset inward;
// the triangle comes back counter-clockwise both ways. A single contour
// fills the same either way; a compound path would not. The replay
// compares direction-relative-to-input with Illustrator once recorded.

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
  oracleFixturePath,
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
// Points, page-local, Y down. Both shapes are drawn clockwise.

/** 100 x 60. Area 6000, perimeter 320. */
const RECT: Vec2[] = [
  [100, 100],
  [200, 100],
  [200, 160],
  [100, 160],
];
/** A 3-4-5 right triangle: legs 120 and 90, hypotenuse 150. Area 5400,
 *  perimeter 360, inradius 30, incentre (130,130). */
const TRI: Vec2[] = [
  [100, 100],
  [220, 100],
  [100, 190],
];
const MITER_LIMIT = 4;

const OFFSET_PATH_CASES: OffsetCase[] = (
  [
    ["rect", RECT],
    ["tri", TRI],
  ] as const
).flatMap(([shape, points]) =>
  (["miter", "round", "bevel"] as const).flatMap((join) =>
    (
      [
        ["out", 10],
        ["in", -10],
      ] as const
    ).map(([dir, delta]) => ({
      id: `${shape}-${join}-${dir}`,
      input: { paths: [polygon(points)] },
      parameters: { delta, join, miterLimit: MITER_LIMIT },
    })),
  ),
);

// --- reference 1: the join's definition ------------------------------------
// For a convex polygon of area A and perimeter L, offset OUTWARD by d, with
// exterior (turning) angles t_i:
//     miter   A + d·L + d²·Σ tan(t_i / 2)
//     round   A + d·L + π·d²                (the corner sectors sum to a disc)
//     bevel   A + d·L + ½·d²·Σ sin(t_i)
// and offset INWARD by d (no edge vanishing) for EVERY join, because an
// inward corner is an intersection, not a join:
//             A − d·L + d²·Σ tan(t_i / 2)
//
// RECT, d = 10: t = 90° ×4, Σtan = 4, Σsin = 4.
//     miter 6000+3200+400 = 9600 · round 9200+100π = 9514.159 · bevel 9400
//     inward 6000−3200+400 = 3200
// TRI, d = 10: t = 90°, 143.13°, 126.87°; Σtan = 1+3+2 = 6, Σsin = 1+0.6+0.8.
//     miter 5400+3600+600 = 9600 · round 9000+100π = 9314.159
//     bevel 5400+3600+120 = 9120 · inward 5400−3600+600 = 2400
//
// Bounds. A miter (and an inward) offset of the triangle is the triangle
// scaled about its incentre (130,130) by (30±10)/30. A round offset's
// bounds are the input's grown by d. A bevel's are the extremes of the two
// points each corner yields (corner + d·normal of either edge).
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
};

/** DEFECT — the engine ignores `join`: these four ask for a miter or a
 *  round join outward and get a bevel. Numbers in the header. Run as
 *  `it.fails` against BOTH references; remove an entry when it starts
 *  passing (vitest reports an `it.fails` that passes as a failure). */
const ENGINE_IGNORES_JOIN: Record<string, string> = {
  "rect-miter-out": "area 9400 (a bevel) vs 9600",
  "rect-round-out": "area 9400 (a bevel) vs 9514.159",
  "tri-miter-out": "area 9120 (a bevel) vs 9600; bounds max [226,198] vs [250,210]",
  "tri-round-out": "area 9120 (a bevel) vs 9314.159; bounds max [226,198] vs [230,200]",
};

const FIXTURE = loadOracle<OffsetParameters>("offset-path");

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

  it("the case table is the 12 the probe records, each with a definition", () => {
    expect(OFFSET_PATH_CASES.map((c) => c.id)).toEqual(Object.keys(BY_DEFINITION));
    for (const id of Object.keys(ENGINE_IGNORES_JOIN)) {
      expect(Object.keys(BY_DEFINITION)).toContain(id);
    }
  });

  describe("engine vs the join's definition (closed form — no recording needed)", () => {
    for (const c of OFFSET_PATH_CASES) {
      const test = c.id in ENGINE_IGNORES_JOIN ? it.fails : it;
      const note = ENGINE_IGNORES_JOIN[c.id];
      test(`${c.id}${note ? ` — DEFECT, join ignored: ${note}` : ""}`, async () => {
        const ours = (await engine(c)).shape;
        const want = BY_DEFINITION[c.id];
        expect(ours.paths).toBe(1);
        expect(ours.allClosed).toBe(true);
        expect(relDiff(ours.area, want.area)).toBeLessThan(AREA_REL_TOL);
        expect(boundsDiff(ours.bounds, want.bounds)).toBeLessThan(BOUNDS_ABS_TOL);
      });
    }

    it("a join the engine ignores is ignored COMPLETELY: all three joins give one shape", async () => {
      // The pin that makes the four `it.fails` above a single finding and
      // not four: outward, miter == round == bevel, to the anchor.
      for (const shape of ["rect", "tri"]) {
        // Sequential on purpose: each measurement inserts, offsets and
        // undoes twice, and the undo stack is shared.
        const of = (join: Join) =>
          engine(OFFSET_PATH_CASES.find((c) => c.id === `${shape}-${join}-out`)!);
        const miter = await of("miter");
        const round = await of("round");
        const bevel = await of("bevel");
        expect(round.paths).toEqual(miter.paths);
        expect(bevel.paths).toEqual(miter.paths);
        // …and that shape has no curve in it, so it is not the round join.
        expect(miter.shape.curvedSegments).toBe(0);
      }
    });
  });

  describe("engine vs Adobe Illustrator (recorded)", () => {
    if (FIXTURE === null) {
      it.todo(
        `NOT RECORDED — ${oracleFixturePath("offset-path")} does not exist. ` +
          "Record it with scripts/illustrator/run-probe.sh (see scripts/illustrator/README.md); " +
          "until then this lane compares the engine with the join's definition only.",
      );
      return;
    }
    const fixture = FIXTURE;
    const recorded = new Map(fixture.cases.map((c) => [c.id, c]));

    it("the recording says who made it", () => {
      expect(fixture.produced_by.app).toMatch(/Illustrator/);
      expect(fixture.produced_by.version).toMatch(/^\d+\.\d+/);
      expect(fixture.produced_by.script).toBe(
        "scripts/illustrator/probes/offset-path.jsx",
      );
      expect(Number.isNaN(Date.parse(fixture.produced_by.recorded_at))).toBe(false);
    });

    it("the recording's cases ARE this spec's cases (probe and spec have not drifted)", () => {
      expect(
        fixture.cases.map((c) => ({
          id: c.id,
          input: c.input,
          parameters: c.parameters,
        })),
      ).toEqual(OFFSET_PATH_CASES);
    });

    it("the recording is self-consistent: Illustrator's area, bounds and the probe's winding match the anchors it recorded", () => {
      for (const c of fixture.cases) {
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

    it("Illustrator's answer is the join that was ASKED for (catches a mis-mapped `jntp`)", () => {
      // The probe's join enumeration (0 round / 1 bevel / 2 miter) is in no
      // dictionary on disk. If it is wrong, "miter" measures a round
      // join's area here. A genuine convention difference (how Illustrator
      // reads the miter limit, how it approximates an arc) also lands
      // here: classify it, do not widen the tolerance.
      for (const c of fixture.cases) {
        const theirs = summarize(c.measured.paths);
        const want = BY_DEFINITION[c.id];
        expect(relDiff(theirs.netArea, want.area), `${c.id} area`).toBeLessThan(AREA_REL_TOL);
        expect(boundsDiff(theirs.bounds, want.bounds), `${c.id} bounds`).toBeLessThan(
          BOUNDS_ABS_TOL,
        );
      }
    });

    for (const c of OFFSET_PATH_CASES) {
      const test = c.id in ENGINE_IGNORES_JOIN ? it.fails : it;
      const note = ENGINE_IGNORES_JOIN[c.id];
      test(`${c.id}: area, bounds, anchor count${note ? ` — DEFECT, join ignored: ${note}` : ""}`, async () => {
        const ours = (await engine(c)).shape;
        const theirs = summarize(recorded.get(c.id)!.measured.paths);
        expect(ours.paths).toBe(theirs.paths);
        expect(ours.allClosed).toBe(theirs.allClosed);
        expect(relDiff(ours.netArea, theirs.netArea)).toBeLessThan(AREA_REL_TOL);
        expect(boundsDiff(ours.bounds, theirs.bounds)).toBeLessThan(BOUNDS_ABS_TOL);
        expect(ours.anchors).toBe(theirs.anchors);
      });
    }

    it("direction relative to the input: the engine keeps or reverses it where Illustrator does", async () => {
      for (const c of OFFSET_PATH_CASES) {
        const input = windingOf(signedArea(c.input.paths[0]));
        const ours = (await engine(c)).shape.windings[0] === input;
        const theirs = recorded.get(c.id)!.measured.paths[0].winding === input;
        expect(ours, `${c.id}: engine keeps the input's direction`).toBe(theirs);
      }
    });
  });
});
