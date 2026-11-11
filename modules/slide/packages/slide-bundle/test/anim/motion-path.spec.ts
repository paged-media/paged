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

// Motion paths on the canvas (slide ADR 714, amendment 2026-10-30): the
// editor's geometry, without a host; the editing is the host's Direct
// Selection machine over the path's anchor table.

import { describe, expect, it } from "bun:test";

import {
  deletePoint,
  fromPage,
  handlePoint,
  handlesOf,
  insertPoint,
  hitOf,
  segsOfTable,
  tableOfSegs,
  nearestOnPath,
  svgPath,
  toPage,
  type MotionPathState,
} from "../../src/anim/motion-path";
import type { PathSeg } from "../../src/anim/model";
import {
  applyPathOps,
  DirectSelectMachine,
  type DirectSelectHit,
} from "@paged-media/vector-tools";

const PATH: PathSeg[] = [
  { kind: "move", to: [0, 0] },
  { kind: "curve", c1: [0.1, 0], c2: [0.2, 0.1], to: [0.25, 0.2] },
  { kind: "curve", c1: [0.3, 0.3], c2: [0.4, 0.3], to: [0.5, 0.2] },
  { kind: "line", to: [0.5, 0] },
];
const ST: MotionPathState = {
  pageId: "p",
  index: 0,
  segs: PATH,
  origin: [100, 50],
  slide: [960, 540],
  locked: false,
};

describe("motion path editing (slide ADR 714)", () => {
  it("shows every end point and each curve's two handles", () => {
    const hs = handlesOf(PATH);
    expect(hs.filter((h) => h.which === "to").length).toBe(4);
    expect(hs.filter((h) => h.which !== "to").length).toBe(4);
    expect(handlePoint(PATH, { seg: 1, which: "c2" })).toEqual([0.2, 0.1]);
  });

  it("is an anchor table both ways: an anchor per end point, a curve's controls as handles", () => {
    const { table, anchorOf } = tableOfSegs(PATH);
    expect(table.anchors).toHaveLength(4);
    expect(anchorOf).toEqual([0, 1, 2, 3]);
    expect(table.anchors[0]!.right).toEqual([0.1, 0]);
    expect(table.anchors[1]!.left).toEqual([0.2, 0.1]);
    expect(table.anchors[3]!.left).toEqual([0.5, 0]);
    expect(segsOfTable(table)).toEqual([...PATH]);
    const closed: PathSeg[] = [...PATH, { kind: "close" }];
    expect(segsOfTable(tableOfSegs(closed).table)).toEqual(closed);
    expect(hitOf(PATH, { seg: 2, which: "c1" })).toEqual({
      kind: "handle",
      index: 1,
      side: "right",
    });
    expect(hitOf(PATH, { seg: 1, which: "to" })).toEqual({
      kind: "anchor",
      index: 1,
    });
  });

  it("the host's Direct Selection edits it: an anchor moves with its handles, a handle bends its curve alone", () => {
    const { table } = tableOfSegs(PATH);
    const drag = (hit: DirectSelectHit, to: [number, number]) => {
      const m = new DirectSelectMachine({ table, slop: 1e-6, nudgeStep: 1 });
      const none = { shift: false, alt: true };
      const from =
        hit.kind === "anchor"
          ? table.anchors[hit.index]!.anchor
          : hit.kind === "handle"
            ? table.anchors[hit.index]![hit.side]
            : [0, 0];
      m.handle({ type: "down", point: from as never, hit, modifiers: none });
      m.handle({ type: "move", point: to, modifiers: none });
      const snap = m.handle({ type: "up", point: to, modifiers: none });
      return segsOfTable(applyPathOps(table, snap.commit!.ops));
    };
    const moved = drag({ kind: "anchor", index: 1 }, [0.3, 0.25]);
    const c = moved[1] as Extract<PathSeg, { kind: "curve" }>;
    const n = moved[2] as Extract<PathSeg, { kind: "curve" }>;
    expect(c.to[0]).toBeCloseTo(0.3);
    expect(c.to[1]).toBeCloseTo(0.25);
    expect(c.c2[0]).toBeCloseTo(0.25);
    expect(c.c2[1]).toBeCloseTo(0.15);
    expect(n.c1[0]).toBeCloseTo(0.35);
    expect(n.c1[1]).toBeCloseTo(0.35);
    expect(c.c1).toEqual([0.1, 0]);
    const bent = drag({ kind: "handle", index: 1, side: "right" }, [0, 0.5]);
    const b2 = bent[2] as Extract<PathSeg, { kind: "curve" }>;
    expect(b2.c1[0]).toBeCloseTo(0);
    expect(b2.c1[1]).toBeCloseTo(0.5);
    expect((bent[1] as Extract<PathSeg, { kind: "curve" }>).to).toEqual([
      0.25, 0.2,
    ]);
    // The original is not changed.
    expect((PATH[1] as Extract<PathSeg, { kind: "curve" }>).to).toEqual([
      0.25, 0.2,
    ]);
  });

  it("maps between the slide and the path from where the shape stands", () => {
    expect(toPage(ST, [0.5, 0.5])).toEqual([580, 320]);
    expect(fromPage(ST, [580, 320])).toEqual([0.5, 0.5]);
    expect(svgPath(ST, PATH.slice(0, 1))).toBe("M 100.00 50.00");
  });

  it("finds the nearest place on the path and adds a point there", () => {
    const hit = nearestOnPath(PATH, [0.5, 0.1])!;
    expect(hit.seg).toBe(3);
    expect(hit.t).toBeCloseTo(0.5, 1);
    const grown = insertPoint(PATH, 3, 0.5);
    expect(grown.length).toBe(5);
    expect(grown[3]).toEqual({ kind: "line", to: [0.5, 0.1] });
    expect(grown[4]).toEqual(PATH[3]!);
    // A curve splits where it stood: the new point lies on it.
    const split = insertPoint(PATH, 1, 0.5);
    expect(split.length).toBe(5);
    const mid = (split[1] as Extract<PathSeg, { kind: "curve" }>).to;
    expect(nearestOnPath(PATH, mid)!.dist).toBeLessThan(1e-3);
    expect((split[2] as Extract<PathSeg, { kind: "curve" }>).to).toEqual([
      0.25, 0.2,
    ]);
  });

  it("deletes an anchor and joins its neighbours, keeping two points", () => {
    const less = deletePoint(PATH, 1);
    expect(less.length).toBe(3);
    const joined = less[1] as Extract<PathSeg, { kind: "curve" }>;
    expect(joined.to).toEqual([0.5, 0.2]);
    expect(joined.c1).toEqual([0.1, 0]);
    expect(joined.c2).toEqual([0.4, 0.3]);
    expect(deletePoint(PATH, 3).length).toBe(3);
    expect(deletePoint(PATH, 0)[0]).toEqual({ kind: "move", to: [0.25, 0.2] });
    const two: PathSeg[] = [
      { kind: "move", to: [0, 0] },
      { kind: "line", to: [1, 0] },
    ];
    expect(deletePoint(two, 1)).toEqual(two);
  });
});
