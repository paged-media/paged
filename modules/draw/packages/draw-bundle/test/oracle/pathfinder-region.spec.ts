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

// ORACLE — the six Pathfinder REGION verbs. The engine's `pathfinderDivide`
// / `Trim` / `Merge` / `Crop` / `Outline` / `MinusBack { elementIds }`
// (ids TOP TO BOTTOM) against set algebra and against ADOBE ILLUSTRATOR
// 30.1.0 (Effect > Pathfinder on a group, then Expand Appearance), recorded
// 2026-10-02 by
//   scripts/illustrator/run-probe.sh scripts/illustrator/probes/pathfinder-region.jsx \
//     packages/draw-bundle/test/fixtures/oracle/pathfinder-region.illustrator.json
//
// 9 cases: the six verbs on a RED rectangle with a BLUE one in front of it,
// Merge again with both red, and Divide and Minus Back on a red circle
// under a blue rectangle. A result is compared as a set of PIECES — painted
// area, bounds, anchor count and fill of each.
//
// WHAT ILLUSTRATOR SAID:
//   Divide      one piece per face; the overlap takes the FRONT object's fill.
//   Trim        the front object whole, the back one minus what covers it.
//               The front one comes back with 6 anchors, not 4: both
//               crossing points are inserted into its untouched outline.
//   Merge       Trim, unless the fills are EQUAL — then one united piece.
//   Crop        the back object clipped to the front one, keeping the BACK
//               fill. The front object is consumed; nothing unpainted is
//               left behind.
//   Outline     OPEN paths, stroked not filled, stroke weight ZERO, one per
//               run of edge between two crossings: 4 polylines (3, 5, 5 and
//               3 anchors). Each carries the fill of the object that is on
//               TOP along it — the back object's covered edges are blue.
//   Minus Back  FRONT minus back, with the front object's fill.
//   Every closed piece is counter-clockwise, as with the booleans.
//
// WHAT THE ENGINE DOES, against Illustrator (engine pin: canvas-wasm 0.65.0):
//   AGREEMENT — Divide, Trim, Merge (both ways), Crop AND Minus Back: the
//   same pieces, piece for piece, in area, bounds, anchor count and fill,
//   on rectangles and on the circle. Trim's extra two anchors included.
//
//   FIXED in 0.65.0 — `pathfinderMinusBack` was Illustrator's Minus FRONT
//   on 0.64.0: with the ids top to bottom, as the bundle sends them, it
//   kept the BACK object minus the front one (rectangles 6000 pt², red,
//   where Illustrator keeps 6800 pt², blue). It now keeps the front.
//
//   FIXED in 0.65.0 — direction: every closed piece counter-clockwise, as
//   Illustrator's (RFI C-81). 0.64.0 had no convention.
//
//   CONVENTION — Outline's segmentation and paint. The engine cuts the line
//   work at every vertex (12 two-anchor lines), Illustrator only at the
//   crossings (4 polylines); the line work itself is identical, 740 pt in
//   the same bounds. The engine strokes its lines at 1 pt, Illustrator at
//   0 pt. And the two edges of the back object that the front one covers
//   are RED in the engine (the edge's owner) and BLUE in Illustrator (what
//   is on top there).

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { pathfinderRegionMutationFor } from "../../src";
import { onEngine, openOracleHost, paintOf, pathsOf, type Paint } from "./engine";
import {
  AREA_REL_TOL,
  BOUNDS_ABS_TOL,
  boundsDiff,
  loadOracle,
  paintedArea,
  pathBounds,
  pathLength,
  polygon,
  relDiff,
  signedArea,
  summarize,
  windingOf,
  type OraclePath,
  type Rgb,
  type Winding,
} from "./oracle";

type Verb = Parameters<typeof pathfinderRegionMutationFor>[0];
interface RegionParameters {
  verb: Verb;
}
interface RegionCase {
  id: string;
  input: { paths: OraclePath[] };
  parameters: RegionParameters;
}

// --- the cases: a MIRROR of scripts/illustrator/probes/pathfinder-region.jsx

const RED: Rgb = [255, 0, 0];
const BLUE: Rgb = [0, 0, 255];
const filled = (path: OraclePath, fill: Rgb): OraclePath => ({ ...path, fill });

/** Back: [100,100]-[200,180], 8000 pt², perimeter 360. */
const RECT_A = polygon([
  [100, 100],
  [200, 100],
  [200, 180],
  [100, 180],
]);
/** Front: [150,140]-[260,220], 8800 pt², perimeter 380. Overlap 2000. */
const RECT_B = polygon([
  [150, 140],
  [260, 140],
  [260, 220],
  [150, 220],
]);
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

const VERBS = [
  ["divide", "pathfinderDivide"],
  ["trim", "pathfinderTrim"],
  ["merge", "pathfinderMerge"],
  ["crop", "pathfinderCrop"],
  ["outline", "pathfinderOutline"],
  ["minus-back", "pathfinderMinusBack"],
] as const;

const PATHFINDER_REGION_CASES: RegionCase[] = [
  ...VERBS.map(([name, verb]) => ({
    id: `rects-${name}`,
    input: { paths: [filled(RECT_A, RED), filled(RECT_B, BLUE)] },
    parameters: { verb },
  })),
  {
    id: "rects-merge-same-fill",
    input: { paths: [filled(RECT_A, RED), filled(RECT_B, RED)] },
    parameters: { verb: "pathfinderMerge" },
  },
  {
    id: "circle-rect-divide",
    input: { paths: [filled(CIRCLE, RED), filled(RECT_C, BLUE)] },
    parameters: { verb: "pathfinderDivide" },
  },
  {
    id: "circle-rect-minus-back",
    input: { paths: [filled(CIRCLE, RED), filled(RECT_C, BLUE)] },
    parameters: { verb: "pathfinderMinusBack" },
  },
];
const caseOf = (id: string) => PATHFINDER_REGION_CASES.find((c) => c.id === id)!;

// --- pieces ------------------------------------------------------------------

/** One object of a result. */
interface Piece {
  /** Painted area (0 for an open line). */
  area: number;
  bounds: [number, number, number, number];
  anchors: number;
  closed: boolean;
  /** Fill, or `"none"`. */
  fill: Paint;
  /** Stroke, or `"none"`, and its weight. */
  stroke: Paint;
  strokeWeight: number | null;
  length: number;
  windings: Winding[];
}

const bySize = (a: Piece, b: Piece) =>
  a.area - b.area || a.bounds[0] - b.bounds[0] || a.bounds[1] - b.bounds[1];

function pieceOf(paths: OraclePath[], paint: Pick<Piece, "fill" | "stroke" | "strokeWeight">): Piece {
  const shape = summarize(paths);
  const closed = shape.allClosed;
  return {
    area: closed ? shape.fillArea : 0,
    bounds: shape.bounds,
    anchors: shape.anchors,
    closed,
    ...paint,
    length: paths.reduce((sum, p) => sum + pathLength(p), 0),
    windings: shape.windings,
  };
}

const FIXTURE = loadOracle<RegionParameters>("pathfinder-region");
const RECORDED = new Map(FIXTURE.cases.map((c) => [c.id, c]));

/** Illustrator's pieces: every recorded path is its own object (none of
 *  these results is a compound path — asserted below). */
const theirs = (id: string): Piece[] =>
  RECORDED.get(id)!
    .measured.paths.map((p) =>
      pieceOf([p], {
        fill: p.filled ? (p.fill ?? "unknown") : "none",
        stroke: p.stroked ? (p.stroke ?? "unknown") : "none",
        strokeWeight: p.stroked ? (p.strokeWidth ?? null) : null,
      }),
    )
    .sort(bySize);

// --- reference 1: set algebra ----------------------------------------------
// Both inputs are clockwise, so a non-zero fill of the pair paints their
// union and an even-odd fill their symmetric difference.
function byDefinition(c: RegionCase): { area: number; fill: Paint }[] {
  const [back, front] = c.input.paths;
  const union = paintedArea(c.input.paths, "nonzero");
  const overlap = union - paintedArea(c.input.paths, "evenodd");
  const backOnly = paintedArea([back]) - overlap;
  const frontOnly = paintedArea([front]) - overlap;
  const sameFill = String(back.fill) === String(front.fill);
  const pieces = (() => {
    switch (c.parameters.verb) {
      case "pathfinderDivide":
        return [
          { area: overlap, fill: front.fill! },
          { area: frontOnly, fill: front.fill! },
          { area: backOnly, fill: back.fill! },
        ];
      case "pathfinderTrim":
        return [
          { area: frontOnly + overlap, fill: front.fill! },
          { area: backOnly, fill: back.fill! },
        ];
      case "pathfinderMerge":
        return sameFill
          ? [{ area: union, fill: front.fill! }]
          : [
              { area: frontOnly + overlap, fill: front.fill! },
              { area: backOnly, fill: back.fill! },
            ];
      case "pathfinderCrop":
        return [{ area: overlap, fill: back.fill! }];
      case "pathfinderMinusBack":
        return [{ area: frontOnly, fill: front.fill! }];
      default:
        return []; // Outline has no area; its reference is a length.
    }
  })();
  return pieces.sort((a, b) => a.area - b.area);
}

function expectPiecesByDefinition(got: Piece[], c: RegionCase) {
  const want = byDefinition(c);
  expect(got.length, `${c.id}: piece count`).toBe(want.length);
  got.forEach((piece, i) => {
    expect(relDiff(piece.area, want[i].area), `${c.id} piece ${i}: area`).toBeLessThan(
      AREA_REL_TOL,
    );
    expect(piece.fill, `${c.id} piece ${i}: fill`).toEqual(want[i].fill);
  });
}

/** The two Minus Back cases (a 0.64.0 defect, fixed in 0.65.0). */
const MINUS_BACK_CASES = ["rects-minus-back", "circle-rect-minus-back"];

describe("oracle — pathfinder region verbs", () => {
  let h: HeadlessHost;
  const engineResults = new Map<string, Piece[]>();

  beforeAll(async () => {
    h = await openOracleHost();
  });
  afterAll(() => h?.dispose());

  /** The engine's pieces for one case — one per element the verb leaves —
   *  with the ids handed over top to bottom, or the other way round. */
  async function measure(c: RegionCase, order: "topToBottom" | "bottomToTop") {
    return onEngine(h, c.input.paths, async (run) => {
      const ids = order === "topToBottom" ? [...run.ids].reverse() : run.ids;
      await run.apply(pathfinderRegionMutationFor(c.parameters.verb, ids));
      const pieces: Piece[] = [];
      for (const id of await run.created()) {
        pieces.push(pieceOf(await pathsOf(h, id), await paintOf(h, id)));
      }
      return pieces.sort(bySize);
    });
  }
  async function engine(c: RegionCase) {
    const cached = engineResults.get(c.id);
    if (cached) return cached;
    const pieces = await measure(c, "topToBottom");
    engineResults.set(c.id, pieces);
    return pieces;
  }

  describe("the recording", () => {
    it("says who made it", () => {
      expect(FIXTURE.produced_by.app).toBe("Adobe Illustrator");
      expect(FIXTURE.produced_by.version).toMatch(/^\d+\.\d+/);
      expect(FIXTURE.produced_by.script).toBe(
        "scripts/illustrator/probes/pathfinder-region.jsx",
      );
    });

    it("has exactly this spec's cases (probe and spec have not drifted)", () => {
      expect(
        FIXTURE.cases.map((c) => ({
          id: c.id,
          input: c.input,
          parameters: c.parameters,
        })),
      ).toEqual(PATHFINDER_REGION_CASES);
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
          // No result here is a compound path: one path, one object.
          expect(p.compound, c.id).toBeUndefined();
        }
      }
    });
  });

  describe("Illustrator vs set algebra", () => {
    for (const c of PATHFINDER_REGION_CASES.filter(
      (x) => x.parameters.verb !== "pathfinderOutline",
    )) {
      it(`${c.id}: the pieces the verb is defined to leave, each with the right fill`, () => {
        const got = theirs(c.id);
        expectPiecesByDefinition(got, c);
        for (const piece of got) {
          expect(piece.closed).toBe(true);
          expect(piece.stroke).toBe("none");
          expect(piece.windings).toEqual(["ccw"]);
        }
      });
    }

    it("rects-outline: the whole line work, as OPEN zero-weight strokes cut at the crossings", () => {
      const got = theirs("rects-outline");
      // Perimeters 360 + 380; nothing added, nothing dropped.
      expect(got.reduce((sum, p) => sum + p.length, 0)).toBeCloseTo(740, 6);
      expect(got.map((p) => p.anchors).sort()).toEqual([3, 3, 5, 5]);
      for (const piece of got) {
        expect(piece.closed).toBe(false);
        expect(piece.fill).toBe("none");
        expect(piece.strokeWeight).toBe(0);
      }
      // Three runs are blue and one is red: the back object's two COVERED
      // edges take the colour of the front object lying over them.
      const colourOf = (anchors: number, first: [number, number]) =>
        RECORDED.get("rects-outline")!.measured.paths.find(
          (p) =>
            p.anchors.length === anchors &&
            p.anchors[1].anchor[0] === first[0] &&
            p.anchors[1].anchor[1] === first[1],
        )!.stroke;
      expect(colourOf(5, [200, 100])).toEqual(RED); // back, uncovered
      expect(colourOf(5, [150, 220])).toEqual(BLUE); // front, outside back
      expect(colourOf(3, [150, 140])).toEqual(BLUE); // front, over back
      expect(colourOf(3, [200, 180])).toEqual(BLUE); // back, UNDER front
    });

    it("what set algebra does not predict: Trim inserts the crossing points into the untouched front object", () => {
      const front = theirs("rects-trim").find((p) => Math.abs(p.area - 8800) < 0.01)!;
      expect(front.anchors).toBe(6); // a rectangle, with two extra anchors
      expect(front.fill).toEqual(BLUE);
    });
  });

  describe("engine vs set algebra", () => {
    for (const c of PATHFINDER_REGION_CASES.filter(
      (x) => x.parameters.verb !== "pathfinderOutline",
    )) {
      it(c.id, async () => {
        expectPiecesByDefinition(await engine(c), c);
      });
    }
  });

  describe("engine vs Adobe Illustrator", () => {
    for (const c of PATHFINDER_REGION_CASES.filter(
      (x) => x.parameters.verb !== "pathfinderOutline",
    )) {
      it(`${c.id}: the same pieces — area, bounds, anchor count, fill`, async () => {
        const ours = await engine(c);
        const want = theirs(c.id);
        expect(ours.length).toBe(want.length);
        ours.forEach((piece, i) => {
          expect(piece.closed, `piece ${i}`).toBe(want[i].closed);
          expect(relDiff(piece.area, want[i].area), `piece ${i}: area`).toBeLessThan(
            AREA_REL_TOL,
          );
          expect(boundsDiff(piece.bounds, want[i].bounds), `piece ${i}: bounds`).toBeLessThan(
            BOUNDS_ABS_TOL,
          );
          expect(piece.anchors, `piece ${i}: anchors`).toBe(want[i].anchors);
          expect(piece.fill, `piece ${i}: fill`).toEqual(want[i].fill);
          expect(piece.stroke, `piece ${i}: stroke`).toBe("none");
        });
      });
    }

    it("FIXED in 0.65.0 — Minus Back, as the bundle sends it (top to bottom), is Illustrator's: the front minus the back, the front's fill", async () => {
      for (const id of MINUS_BACK_CASES) {
        const c = caseOf(id);
        const [, front] = c.input.paths;
        const overlap =
          paintedArea(c.input.paths, "nonzero") - paintedArea(c.input.paths, "evenodd");
        const [asSent] = await engine(c);
        const [want] = theirs(id);
        expect(relDiff(asSent.area, paintedArea([front]) - overlap), id).toBeLessThan(AREA_REL_TOL);
        expect(relDiff(asSent.area, want.area), id).toBeLessThan(AREA_REL_TOL);
        expect(boundsDiff(asSent.bounds, want.bounds), id).toBeLessThan(BOUNDS_ABS_TOL);
        expect(asSent.fill, id).toEqual(BLUE);
      }
    });

    it("CONVENTION — Outline: the same line work, cut at every vertex (12 lines) instead of at the crossings (4), stroked at 1 pt instead of 0", async () => {
      const ours = await engine(caseOf("rects-outline"));
      const want = theirs("rects-outline");
      const total = (pieces: Piece[]) => pieces.reduce((sum, p) => sum + p.length, 0);
      const union = (pieces: Piece[]) =>
        pieces.reduce(
          (b, p) => [
            Math.min(b[0], p.bounds[0]),
            Math.min(b[1], p.bounds[1]),
            Math.max(b[2], p.bounds[2]),
            Math.max(b[3], p.bounds[3]),
          ],
          [Infinity, Infinity, -Infinity, -Infinity],
        );
      // The same line work…
      expect(total(ours)).toBeCloseTo(740, 6);
      expect(total(want)).toBeCloseTo(740, 6);
      expect(boundsDiff(union(ours), union(want))).toBeLessThan(BOUNDS_ABS_TOL);
      for (const piece of [...ours, ...want]) {
        expect(piece.closed).toBe(false);
        expect(piece.fill).toBe("none");
      }
      // …in different pieces…
      expect(ours).toHaveLength(12);
      expect(ours.every((p) => p.anchors === 2)).toBe(true);
      expect(want).toHaveLength(4);
      // …at a different weight…
      expect(new Set(ours.map((p) => p.strokeWeight))).toEqual(new Set([1]));
      expect(new Set(want.map((p) => p.strokeWeight))).toEqual(new Set([0]));
      // …and the back object's two covered edges ((150,180)–(200,180) and
      // (200,140)–(200,180), 90 pt together) are RED here, blue there.
      const length = (pieces: Piece[], colour: Rgb) =>
        total(pieces.filter((p) => String(p.stroke) === String(colour)));
      expect(length(want, RED)).toBeCloseTo(270, 6);
      expect(length(want, BLUE)).toBeCloseTo(470, 6);
      expect(length(ours, RED)).toBeCloseTo(360, 6);
      expect(length(ours, BLUE)).toBeCloseTo(380, 6);
    });

    it("direction — FIXED in 0.65.0: every closed piece counter-clockwise, as Illustrator's", async () => {
      for (const c of PATHFINDER_REGION_CASES.filter(
        (x) => x.parameters.verb !== "pathfinderOutline",
      )) {
        const ours = await engine(c);
        expect(new Set(ours.flatMap((p) => p.windings)), `${c.id}: engine`).toEqual(new Set(["ccw"]));
        expect(new Set(theirs(c.id).flatMap((p) => p.windings)), `${c.id}: Illustrator`).toEqual(
          new Set(["ccw"]),
        );
      }
    });
  });
});
