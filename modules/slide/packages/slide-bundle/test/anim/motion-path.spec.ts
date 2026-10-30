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
// editor's geometry, without a host.

import { describe, expect, it } from "bun:test";

import {
  fromPage,
  handlePoint,
  handlesOf,
  moveHandle,
  svgPath,
  toPage,
  type MotionPathState,
} from "../../src/anim/motion-path";
import type { PathSeg } from "../../src/anim/model";

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

  it("an anchor moves with its handles; a handle bends its curve alone", () => {
    const moved = moveHandle(PATH, { seg: 1, which: "to" }, [0.3, 0.25]);
    const c = moved[1] as Extract<PathSeg, { kind: "curve" }>;
    const n = moved[2] as Extract<PathSeg, { kind: "curve" }>;
    expect(c.to).toEqual([0.3, 0.25]);
    expect(c.c2[0]).toBeCloseTo(0.25);
    expect(c.c2[1]).toBeCloseTo(0.15);
    expect(n.c1[0]).toBeCloseTo(0.35);
    expect(n.c1[1]).toBeCloseTo(0.35);
    expect(c.c1).toEqual([0.1, 0]);
    const bent = moveHandle(PATH, { seg: 2, which: "c1" }, [0, 0.5]);
    expect((bent[2] as Extract<PathSeg, { kind: "curve" }>).c1).toEqual([
      0, 0.5,
    ]);
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
});
