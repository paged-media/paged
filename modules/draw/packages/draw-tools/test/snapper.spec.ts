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

// The shared point snapper (ADR 358): one client of the engine's
// `requestSnapPoint` for the host's Pen and draw's Curvature. The engine
// is scripted here; the real one answers in the headless specs
// (draw-bundle test/headless/snapping.spec.ts).

import { describe, expect, it } from "bun:test";

import type { SnapPointQuery, SnapPointResult } from "@paged-media/plugin-api";

import { createSnapper, snapAnswered } from "../src";

const result = (point: [number, number], tolerancePt = 3): SnapPointResult => ({
  point,
  snapped: true,
  lines: [],
  tolerancePt,
});

/** A scripted engine that records every query. */
function engine(answer: (q: SnapPointQuery) => SnapPointResult | null) {
  const asked: SnapPointQuery[] = [];
  return {
    asked,
    query: async (q: SnapPointQuery) => {
      asked.push(q);
      return answer(q);
    },
  };
}

describe("createSnapper", () => {
  it("returns the engine's point and keeps its answer for the smart guides", async () => {
    const e = engine(() => result([10, 20]));
    const s = createSnapper(e.query);
    expect(
      await s.snap({ pageId: "p1", point: [9, 19], cameraScale: 2 }),
    ).toEqual([10, 20]);
    expect(s.last()?.point).toEqual([10, 20]);
    s.reset();
    expect(s.last()).toBeNull();
  });

  it("sends the page, the point, the zoom and the tool's own points", async () => {
    const e = engine(() => result([0, 0]));
    const s = createSnapper(e.query);
    await s.snap({
      pageId: "p1",
      point: [1, 2],
      cameraScale: 0.5,
      extra: [
        [3, 4],
        [5, 6],
      ],
    });
    expect(e.asked).toEqual([
      {
        pageId: "p1",
        point: [1, 2],
        cameraScale: 0.5,
        extraPoints: [
          [3, 4],
          [5, 6],
        ],
      },
    ]);
  });

  it("bypassed: the point unchanged, and the engine is not asked", async () => {
    const e = engine(() => result([10, 20]));
    const s = createSnapper(e.query);
    await s.snap({ pageId: "p1", point: [0, 0], cameraScale: 1 });
    expect(
      await s.snap({
        pageId: "p1",
        point: [9, 19],
        cameraScale: 1,
        bypass: true,
      }),
    ).toEqual([9, 19]);
    expect(e.asked).toHaveLength(1);
    expect(s.last()).toBeNull();
  });

  it("unanswered (null, a zero tolerance, a rejection): the point unchanged", async () => {
    for (const query of [
      async () => null,
      async () => undefined,
      async () => result([10, 20], 0),
      async () => {
        throw new Error("no engine");
      },
    ]) {
      const s = createSnapper(query);
      expect(
        await s.snap({ pageId: "p1", point: [9, 19], cameraScale: 1 }),
      ).toEqual([9, 19]);
      expect(s.last()).toBeNull();
    }
  });

  it("snapAnswered: an answer is a result with a positive tolerance", () => {
    expect(snapAnswered(result([0, 0]))).toBe(true);
    expect(snapAnswered(result([0, 0], 0))).toBe(false);
    expect(snapAnswered(null)).toBe(false);
    expect(snapAnswered(undefined)).toBe(false);
  });
});
