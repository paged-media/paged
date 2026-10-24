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

import { describe, expect, it } from "bun:test";

import {
  evalCubic,
  planJoinScrub,
  planPathErase,
  subRun,
  type AnchorTriple,
} from "../src";

type P = [number, number];
const corner = (p: P): AnchorTriple => ({ anchor: p, left: p, right: p });
const line = (a: P, b: P): AnchorTriple[] => [corner(a), corner(b)];

describe("subRun — the exact sub-curve between two locations [plugin-draw.tool-wave-3]", () => {
  const curve: AnchorTriple[] = [
    { anchor: [0, 0], left: [0, 0], right: [40, -60] },
    { anchor: [100, 0], left: [60, -60], right: [100, 0] },
  ];

  it("traces the original cubic between the two parameters", () => {
    const run = subRun(curve, false, { segment: 0, t: 0.25 }, { segment: 0, t: 0.75 })!;
    expect(run).toHaveLength(2);
    for (const u of [0, 0.3, 0.6, 1]) {
      const got = evalCubic(run[0]!.anchor, run[0]!.right, run[1]!.left, run[1]!.anchor, u);
      const want = evalCubic([0, 0], [40, -60], [60, -60], [100, 0], 0.25 + 0.5 * u);
      expect(got[0]).toBeCloseTo(want[0], 9);
      expect(got[1]).toBeCloseTo(want[1], 9);
    }
  });

  it("wraps through the closing segment of a closed contour", () => {
    const sq = [corner([0, 0]), corner([10, 0]), corner([10, 10]), corner([0, 10])];
    const run = subRun(sq, true, { segment: 2, t: 0.5 }, { segment: 0, t: 0.5 })!;
    expect(run.map((a) => a.anchor)).toEqual([
      [5, 10],
      [0, 10],
      [0, 0],
      [5, 0],
    ]);
    // An open contour cannot wrap.
    expect(subRun(sq.slice(0, 3), false, { segment: 1, t: 0 }, { segment: 0, t: 0 })).toBeNull();
  });
});

describe("planPathErase — the Path Eraser removes what the drag covered [plugin-draw.tool-wave-3]", () => {
  it("a drag across the middle of an open line leaves two pieces meeting the brush's edge", () => {
    const plan = planPathErase(line([0, 0], [100, 0]), false, [[50, -20], [50, 20]], 5)!;
    expect(plan.pieces).toHaveLength(2);
    expect(plan.pieces[0]![0]!.anchor).toEqual([0, 0]);
    expect(plan.pieces[0]!.at(-1)!.anchor[0]).toBeCloseTo(45, 4);
    expect(plan.pieces[1]![0]!.anchor[0]).toBeCloseTo(55, 4);
    expect(plan.pieces[1]!.at(-1)!.anchor).toEqual([100, 0]);
  });

  it("over an END it shortens the path; over all of it nothing is left", () => {
    const end = planPathErase(line([0, 0], [100, 0]), false, [[95, 0], [110, 0]], 10)!;
    expect(end.pieces).toHaveLength(1);
    expect(end.pieces[0]!.at(-1)!.anchor[0]).toBeCloseTo(85, 4);
    const all = planPathErase(line([0, 0], [100, 0]), false, [[-5, 0], [105, 0]], 10)!;
    expect(all.pieces).toEqual([]);
  });

  it("a drag that misses is no plan", () => {
    expect(planPathErase(line([0, 0], [100, 0]), false, [[50, 30], [60, 30]], 5)).toBeNull();
  });

  it("a CLOSED square erased across one edge opens into ONE piece through its corners", () => {
    const sq = [corner([0, 0]), corner([100, 0]), corner([100, 100]), corner([0, 100])];
    const plan = planPathErase(sq, true, [[50, -10], [50, 10]], 5)!;
    expect(plan.pieces).toHaveLength(1);
    const piece = plan.pieces[0]!;
    expect(piece[0]!.anchor[0]).toBeCloseTo(55, 4);
    expect(piece.at(-1)!.anchor[0]).toBeCloseTo(45, 4);
    // It still passes through the other three corners and anchor 0.
    expect(piece.map((a) => a.anchor)).toContainEqual([100, 0]);
    expect(piece.map((a) => a.anchor)).toContainEqual([0, 0]);
  });
});

describe("planJoinScrub — the Join tool's plan [plugin-draw.tool-wave-3]", () => {
  it("a scrub over the GAP of two open ends extends the first to the second's end exactly", () => {
    const a = line([0, 0], [100, 0]);
    const b = line([120, 10], [200, 10]);
    const plan = planJoinScrub([{ anchors: a }, { anchors: b }], [[95, -5], [125, 15]], 8)!;
    expect(plan.kind).toBe("gap");
    if (plan.kind !== "gap") return;
    expect(plan.a).toBe(0);
    expect(plan.b).toBe(1);
    expect(plan.aAnchors.map((x) => x.anchor)).toEqual([
      [0, 0],
      [100, 0],
      [120, 10],
    ]);
  });

  it("the scrub picks the pair even when another pair is nearer", () => {
    // a's START is nearer b's START than the scrubbed pair is.
    const a = line([0, 0], [100, 0]);
    const b = line([0, 5], [100, 60]);
    const plan = planJoinScrub([{ anchors: a }, { anchors: b }], [[98, 0], [100, 30], [101, 58]], 5)!;
    expect(plan.kind).toBe("gap");
    if (plan.kind !== "gap") return;
    expect(plan.aAnchors.at(-1)!.anchor).toEqual([100, 60]);
  });

  it("one path's two ends close it", () => {
    const u = [corner([0, 0]), corner([0, 100]), corner([100, 100]), corner([100, 0])];
    expect(planJoinScrub([{ anchors: u }], [[-3, 0], [103, 0]], 6)).toEqual({ kind: "close", path: 0 });
  });

  it("a scrub over the OVERHANGS of a crossing trims both and pins them to the crossing", () => {
    const a = line([0, 50], [120, 50]); // overhangs to x 120
    const b = line([100, 0], [100, 70]); // overhangs to y 70
    const plan = planJoinScrub([{ anchors: a }, { anchors: b }], [[110, 56], [104, 56], [106, 60]], 6)!;
    expect(plan.kind).toBe("crossing");
    if (plan.kind !== "crossing") return;
    expect(plan.point[0]).toBeCloseTo(100, 6);
    expect(plan.point[1]).toBeCloseTo(50, 6);
    expect(plan.aAnchors.map((x) => x.anchor)).toEqual([[0, 50], plan.point]);
    expect(plan.bAnchors.map((x) => x.anchor)).toEqual([[100, 0], plan.point]);
  });

  it("a scrub over nothing is no plan", () => {
    const a = line([0, 0], [100, 0]);
    expect(planJoinScrub([{ anchors: a }], [[300, 300], [310, 300]], 5)).toBeNull();
  });
});
