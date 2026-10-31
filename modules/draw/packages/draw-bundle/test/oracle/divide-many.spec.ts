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

// ORACLE — Pathfinder Divide over MANY shapes (engine ADR 1019): 20, 50
// and 100 overlapping rectangles and circles through the engine's
// `pathfinderDivide`, against ADOBE ILLUSTRATOR 30.1.0, recorded
// 2026-10-25 by
//
//   scripts/illustrator/run-probe.sh scripts/illustrator/probes/divide-many.jsx \
//     packages/draw-bundle/test/fixtures/oracle/divide-many.illustrator.json
//
// The inputs are the probe's own (recorded with the answer). Illustrator
// cut them into 30, 199 and 1057 pieces, none of them compound, each in
// the fill of the frontmost input covering it; ten of them are its own
// slivers under 0.01 pt². Before ADR 1019 the engine refused all three (at
// most 12 inputs); now it answers with the same pieces: every one but
// those slivers, each of 0.2 pt² or more matched by fill and area.
// The kernel half of this replay is core's `divide_many_oracle` test.

import { describe, expect, it, beforeAll, afterAll } from "bun:test";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { pathfinderRegionMutationFor } from "../../src";
import { onEngine, openOracleHost, paintOf, pathsOf } from "./engine";
import { loadOracle, paintedArea } from "./oracle";

const FIXTURE = loadOracle<{ verb: "pathfinderDivide" }>("divide-many");

describe("oracle — divide over many shapes", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openOracleHost();
  });
  afterAll(() => h?.dispose());

  it("the recording says who made it", () => {
    expect(FIXTURE.produced_by.app).toBe("Adobe Illustrator");
    expect(FIXTURE.produced_by.script).toBe(
      "scripts/illustrator/probes/divide-many.jsx",
    );
    expect(FIXTURE.cases.map((c) => c.id)).toEqual([
      "divide-20",
      "divide-50",
      "divide-100",
    ]);
    expect(FIXTURE.cases.map((c) => c.measured.paths.length)).toEqual([
      30, 199, 1057,
    ]);
  });

  for (const c of FIXTURE.cases) {
    it(`${c.id}: the same pieces, in the same fills`, async () => {
      const key = (fill: unknown, area: number) =>
        `${JSON.stringify(fill)}`.padEnd(16) + area.toFixed(1);
      const theirs = c.measured.paths
        .map((p) => ({ fill: p.fill, area: paintedArea([p]) }))
        .sort((a, b) => (key(a.fill, a.area) < key(b.fill, b.area) ? -1 : 1));
      const ours = await onEngine(h, c.input.paths, async (run) => {
        const ids = [...run.ids].reverse(); // top to bottom
        await run.apply(pathfinderRegionMutationFor("pathfinderDivide", ids));
        const pieces: { fill: unknown; area: number }[] = [];
        for (const id of await run.created()) {
          pieces.push({
            fill: (await paintOf(h, id)).fill,
            area: paintedArea(await pathsOf(h, id)),
          });
        }
        return pieces.sort((a, b) =>
          key(a.fill, a.area) < key(b.fill, b.area) ? -1 : 1,
        );
      });
      // Illustrator's own slivers (under 0.01 pt², below the 1/64 pt
      // grid the engine resolves: one in divide-50, nine in divide-100)
      // are not pieces the engine can have; every other piece is.
      const real = theirs.filter((p) => p.area >= 0.01).length;
      expect(
        Math.abs(ours.length - real),
        `${c.id}: piece count ${ours.length} vs ${real} of ${theirs.length}`,
      ).toBeLessThanOrEqual(1);
      // Every piece of 0.2 pt² or more has its match: the same fill and
      // the same area within 0.03 % + 0.5 pt² (Illustrator measures its
      // own subdivision of the circles' arcs).
      const used = new Array<boolean>(ours.length).fill(false);
      for (const t of theirs.filter((p) => p.area >= 0.2)) {
        let best = -1;
        for (let i = 0; i < ours.length; i++) {
          if (
            used[i] ||
            JSON.stringify(ours[i].fill) !== JSON.stringify(t.fill)
          )
            continue;
          if (
            best < 0 ||
            Math.abs(ours[i].area - t.area) < Math.abs(ours[best].area - t.area)
          )
            best = i;
        }
        expect(
          best,
          `${c.id} ${JSON.stringify(t.fill)}: no match`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          Math.abs(ours[best].area - t.area),
          `${c.id} ${JSON.stringify(t.fill)}: ${ours[best].area} vs ${t.area}`,
        ).toBeLessThanOrEqual(t.area * 3e-4 + 0.5);
        used[best] = true;
      }
    }, 300_000);
  }
});
