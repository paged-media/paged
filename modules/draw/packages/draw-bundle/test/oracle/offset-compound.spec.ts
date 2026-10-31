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

// ORACLE — Offset Path of COMPOUND and OPEN paths (engine ADR 1019). The
// engine's `offsetPath { elementId, delta, join, miterLimit, side? }`
// against ADOBE ILLUSTRATOR 30.1.0, recorded 2026-10-25 by
//
//   scripts/illustrator/run-probe.sh scripts/illustrator/probes/offset-compound.jsx \
//     packages/draw-bundle/test/fixtures/oracle/offset-compound.illustrator.json
//
// WHAT ILLUSTRATOR SAID (14 cases):
//
//   * A compound path's hole moves the OTHER way: outset by 10, the ring
//     [100,300]² minus [170,230]² becomes 220² − 40² (outer contour grown,
//     hole shrunk), inset by 10 it becomes 180² − 80². The join is drawn
//     on the corners each contour OPENS — the outer one's on an outset,
//     the hole's on an inset (`ring-round-in`: the hole is 6314.249, a
//     round-cornered 80 pt square).
//   * A hole shrunk past nothing VANISHES (one plain path back); an
//     island inside the hole moves like an outer contour; two outer
//     contours that grow into each other come back as ONE path.
//   * Outer contours clockwise on the page, holes the other way.
//   * An OPEN path becomes the closed band of width 2·|δ|, its ends
//     following the join: BUTT for miter and bevel, ROUND for round
//     (`open-l-round` is 7292.811, the L's band plus two half discs).
//
// WHAT THE ENGINE DOES: the same, every case, in area (0.1 %), bounds
// (0.05 pt) and contour count. Before ADR 1019 a compound path was
// offset as the two-sided BAND of its outline (every contour stroked at
// 2·|δ|), so `ring-miter-out` measured the 20 pt bands around both
// contours instead of 220² − 40².
//
// The engine's ONE-SIDED offset (`side: "left" | "right"`) has no
// Illustrator counterpart; it is held to the recording by running ALONG
// Illustrator's band: every anchor of the left and right offsets of the
// open L lies on the band's outline.

import { describe, expect, it, beforeAll, afterAll } from "bun:test";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { offsetPathMutationFor } from "../../src";
import { onEngine, openOracleHost, pathsOf } from "./engine";
import {
  AREA_REL_TOL,
  BOUNDS_ABS_TOL,
  boundsDiff,
  flatten,
  loadOracle,
  paintedArea,
  relDiff,
  summarize,
  windingOf,
  signedArea,
  type OraclePath,
  type Vec2,
} from "./oracle";

interface OffsetParameters {
  delta: number;
  join: "miter" | "round" | "bevel";
  miterLimit: number;
}

const FIXTURE = loadOracle<OffsetParameters>("offset-compound");

/** The distance from `p` to a polyline ring. */
function distanceToRing(p: Vec2, ring: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t =
      len2 === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2),
          );
    const x = a[0] + t * dx - p[0];
    const y = a[1] + t * dy - p[1];
    best = Math.min(best, Math.hypot(x, y));
  }
  return best;
}

describe("oracle — offset path of compound and open paths", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openOracleHost();
  });
  afterAll(() => h?.dispose());

  /** Insert the case's contours as ONE element (one compound path, the
   *  contours in the order the probe gave them), offset it, read it. */
  async function engine(
    input: OraclePath[],
    parameters: OffsetParameters,
    side?: "left" | "right",
  ): Promise<OraclePath[]> {
    return onEngine(h, [input[0]], async (run) => {
      const id = run.ids[0];
      if (input.length > 1) {
        const anchors = input.flatMap((p) => p.anchors);
        const subpathStarts: number[] = [];
        let at = 0;
        for (const p of input) {
          subpathStarts.push(at);
          at += p.anchors.length;
        }
        await run.apply({
          op: "setElementProperty",
          args: {
            elementId: id,
            path: "framePath",
            value: { type: "framePath", value: { anchors, subpathStarts } },
          },
        });
      }
      await run.apply(
        offsetPathMutationFor(id, {
          delta: parameters.delta,
          join: parameters.join,
          miterLimit: parameters.miterLimit,
          side,
        }),
      );
      return pathsOf(h, id);
    });
  }

  it("the recording says who made it, and is self-consistent", () => {
    expect(FIXTURE.produced_by.app).toBe("Adobe Illustrator");
    expect(FIXTURE.produced_by.script).toBe(
      "scripts/illustrator/probes/offset-compound.jsx",
    );
    expect(FIXTURE.cases).toHaveLength(14);
    for (const c of FIXTURE.cases) {
      for (const p of c.measured.paths) {
        expect(relDiff(Math.abs(signedArea(p)), p.area), c.id).toBeLessThan(
          AREA_REL_TOL,
        );
        expect(windingOf(signedArea(p)), c.id).toBe(p.winding);
      }
    }
  });

  for (const c of FIXTURE.cases) {
    it(`${c.id}: the engine paints what Illustrator paints`, async () => {
      const ours = await engine(c.input.paths, c.parameters);
      const theirs: OraclePath[] = c.measured.paths;
      const want = summarize(theirs);
      const got = summarize(ours);
      expect(got.allClosed, c.id).toBe(true);
      expect(
        relDiff(paintedArea(ours), paintedArea(theirs)),
        `${c.id}: painted area ${paintedArea(ours)} vs ${paintedArea(theirs)}`,
      ).toBeLessThan(AREA_REL_TOL);
      expect(
        boundsDiff(got.bounds, want.bounds),
        `${c.id}: bounds`,
      ).toBeLessThan(BOUNDS_ABS_TOL);
      expect(got.paths, `${c.id}: contours`).toBe(want.paths);
      // Outer contours clockwise, holes the other way — as many of each.
      expect(
        got.windings.filter((w) => w === "cw").length,
        `${c.id}: clockwise contours`,
      ).toBe(want.windings.filter((w) => w === "cw").length);
    });
  }

  it("a one-sided offset of the open L runs along Illustrator's band, on its side", async () => {
    const c = FIXTURE.cases.find((x) => x.id === "open-l-miter")!;
    const band = flatten(c.measured.paths[0], 256);
    for (const side of ["left", "right"] as const) {
      const ours = await engine(c.input.paths, c.parameters, side);
      expect(ours, side).toHaveLength(1);
      expect(ours[0].closed, side).toBe(false);
      for (const a of ours[0].anchors) {
        expect(
          distanceToRing(a.anchor, band),
          `${side}: ${a.anchor} off the band`,
        ).toBeLessThan(BOUNDS_ABS_TOL);
      }
    }
    // Left of "right along the top" is above it; right is below.
    const left = (await engine(c.input.paths, c.parameters, "left"))[0];
    const right = (await engine(c.input.paths, c.parameters, "right"))[0];
    expect(left.anchors[0].anchor[1]).toBeCloseTo(90, 3);
    expect(right.anchors[0].anchor[1]).toBeCloseTo(110, 3);
  });
});
