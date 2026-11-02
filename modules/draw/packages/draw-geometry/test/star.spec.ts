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
  flareParts,
  regularPolygonPath,
  starPath,
  STAR_MIN_POINTS,
} from "../src";

describe("starPath / flareParts — Star and Flare geometry [plugin-draw.tool-wave-3]", () => {
  it("a 5-point star alternates Radius 1 and Radius 2, first tip straight up", () => {
    const t = starPath({
      cx: 100,
      cy: 100,
      radius1: 50,
      radius2: 20,
      points: 5,
    });
    expect(t.anchors).toHaveLength(10);
    expect(t.subpathOpen).toEqual([false]);
    expect(t.anchors[0]!.anchor[0]).toBeCloseTo(100, 9);
    expect(t.anchors[0]!.anchor[1]).toBeCloseTo(50, 9);
    t.anchors.forEach((a, i) => {
      const r = Math.hypot(a.anchor[0] - 100, a.anchor[1] - 100);
      expect(r).toBeCloseTo(i % 2 === 0 ? 50 : 20, 9);
      expect(a.left).toEqual(a.anchor);
    });
  });

  it("Radius 2 may exceed Radius 1, rotation turns it, points clamp to 3", () => {
    const t = starPath({
      cx: 0,
      cy: 0,
      radius1: 10,
      radius2: 30,
      points: 1,
      rotationDeg: 90,
    });
    expect(t.anchors).toHaveLength(2 * STAR_MIN_POINTS);
    expect(t.anchors[0]!.anchor[0]).toBeCloseTo(10, 9);
    expect(t.anchors[0]!.anchor[1]).toBeCloseTo(0, 9);
    expect(Math.hypot(...t.anchors[1]!.anchor)).toBeCloseTo(30, 9);
    expect(
      starPath({ cx: 0, cy: 0, radius1: 0, radius2: 0, points: 5 }).anchors,
    ).toEqual([]);
  });

  it("a regular polygon puts its corners on the radius", () => {
    const t = regularPolygonPath(0, 0, 10, 6);
    expect(t.anchors).toHaveLength(6);
    for (const a of t.anchors)
      expect(Math.hypot(...a.anchor)).toBeCloseTo(10, 9);
  });

  it("a flare has a centre, a larger halo, its rays and its rings toward the end point — the same every time", () => {
    const spec = {
      cx: 100,
      cy: 100,
      centreRadius: 10,
      haloScale: 3,
      rays: 12,
      rayLength: 80,
      rings: 4,
      end: [300, 200] as [number, number],
      ringRadius: 20,
    };
    const f = flareParts(spec);
    expect(f.rays).toHaveLength(12);
    expect(f.rings).toHaveLength(4);
    expect(f.halo.anchors[0]!.anchor[0] - 100).toBeCloseTo(30, 9);
    for (const r of f.rays) {
      expect(r.anchors[0]!.anchor).toEqual([100, 100]);
      const l = Math.hypot(
        r.anchors[1]!.anchor[0] - 100,
        r.anchors[1]!.anchor[1] - 100,
      );
      expect(l).toBeGreaterThanOrEqual(80 / 3 - 1e-9);
      expect(l).toBeLessThanOrEqual(80);
    }
    // The last ring sits at the end point.
    const last = f.rings.at(-1)!;
    const cx = (last.anchors[0]!.anchor[0] + last.anchors[2]!.anchor[0]) / 2;
    expect(cx).toBeCloseTo(300, 6);
    expect(flareParts(spec)).toEqual(f);
  });
});
