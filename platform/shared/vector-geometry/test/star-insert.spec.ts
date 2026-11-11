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

// The star insert, ported from the cases paged.draw's own copy was held to
// (Star geometry; the live star of engine ADR 1047 and where it stops).

import { describe, expect, it } from "bun:test";

import {
  STAR_DEFAULTS,
  STAR_MAX_POINTS,
  STAR_MIN_POINTS,
  liveStarInset,
  liveStarMutationFor,
  polygonAnchors,
  starAnchors,
  starMutationFor,
  starParamsFrom,
} from "../src/index.ts";

const star = (over: Partial<typeof STAR_DEFAULTS> = {}) => ({
  cx: 100,
  cy: 100,
  radius1: 40,
  radius2: 10,
  points: 6,
  rotationDeg: 0,
  ...over,
});

describe("starAnchors", () => {
  it("is one closed contour of 2 x points corners, the first tip straight up", () => {
    const a = starAnchors(star());
    expect(a).toHaveLength(12);
    expect(a[0]!.anchor[0]).toBeCloseTo(100, 9);
    expect(a[0]!.anchor[1]).toBeCloseTo(60, 9);
    // The first valley sits on Radius 2, half a step round.
    const v = a[1]!.anchor;
    expect(Math.hypot(v[0] - 100, v[1] - 100)).toBeCloseTo(10, 9);
    expect(a[0]!.left).toEqual(a[0]!.anchor);
    expect(a[0]!.right).toEqual(a[0]!.anchor);
  });

  it("rotates clockwise on screen by the rotation", () => {
    const a = starAnchors(star({ rotationDeg: 90 }));
    expect(a[0]!.anchor[0]).toBeCloseTo(140, 9);
    expect(a[0]!.anchor[1]).toBeCloseTo(100, 9);
  });

  it("clamps the point count, and a degenerate star has no anchors", () => {
    expect(starAnchors(star({ points: 1 }))).toHaveLength(2 * STAR_MIN_POINTS);
    expect(starAnchors(star({ points: 5000 }))).toHaveLength(
      2 * STAR_MAX_POINTS,
    );
    expect(starAnchors(star({ radius1: 0, radius2: 0 }))).toEqual([]);
    expect(starAnchors(star({ cx: NaN }))).toEqual([]);
  });

  it("either radius may be the larger", () => {
    const a = starAnchors(star({ radius1: 10, radius2: 40 }));
    expect(
      Math.hypot(a[0]!.anchor[0] - 100, a[0]!.anchor[1] - 100),
    ).toBeCloseTo(10, 9);
  });

  it("the polygon is Radius 1's corners, first one up", () => {
    const p = polygonAnchors(100, 100, 40, 6);
    expect(p).toHaveLength(6);
    expect(p[0]!.anchor[1]).toBeCloseTo(60, 9);
    expect(polygonAnchors(0, 0, 1, 1)).toHaveLength(3);
  });
});

describe("the live star (engine ADR 1047)", () => {
  it("an upright star with Radius 2 smaller is one batch: the polygon on Radius 1, its points, its inset", () => {
    const m = liveStarMutationFor("page-1", star())!;
    expect(m.op).toBe("batch");
    const [insert, sides, inset] = m.args.ops as Array<{
      op: string;
      args: Record<string, unknown>;
    }>;
    expect(insert!.op).toBe("insertPath");
    expect(insert!.args.pageId).toBe("page-1");
    expect(insert!.args.open).toBe(false);
    expect(insert!.args.anchors).toHaveLength(6);
    expect(sides!.args).toMatchObject({
      elementId: { kind: "polygon", id: "$created" },
      path: "frameShapeSides",
      value: { type: "length", value: 6 },
    });
    // 1 - 10 / 40 = 75 %.
    expect(inset!.args).toMatchObject({
      path: "frameShapeStarInset",
      value: { type: "length", value: 75 },
    });
  });

  it("the inset is rounded to two decimals", () => {
    expect(liveStarInset(star({ radius2: 13 }))).toBe(67.5);
    expect(liveStarInset(star({ radius1: 3, radius2: 1 }))).toBe(66.67);
  });

  it("a turned star, a larger Radius 2 or an inset past 99 percent is not live", () => {
    expect(liveStarInset(star({ rotationDeg: 15 }))).toBeNull();
    expect(liveStarInset(star({ rotationDeg: 360 }))).toBe(75);
    expect(liveStarInset(star({ rotationDeg: -720 }))).toBe(75);
    expect(liveStarInset(star({ radius1: 10, radius2: 40 }))).toBeNull();
    expect(liveStarInset(star({ radius2: 40 }))).toBeNull();
    expect(liveStarInset(star({ radius1: 0 }))).toBeNull();
    expect(liveStarInset(star({ radius1: 1000, radius2: 1 }))).toBeNull();
    expect(liveStarMutationFor("p", star({ rotationDeg: 15 }))).toBeNull();
  });

  it("starMutationFor falls back to the plain 2 x points path", () => {
    const turned = starMutationFor("page-1", star({ rotationDeg: 15 }))!;
    expect(turned.op).toBe("insertPath");
    expect(
      (turned.args as unknown as { anchors: unknown[] }).anchors,
    ).toHaveLength(12);
    const larger = starMutationFor(
      "page-1",
      star({ radius1: 10, radius2: 40 }),
    )!;
    expect(
      (larger.args as unknown as { anchors: unknown[] }).anchors,
    ).toHaveLength(12);
    expect(starMutationFor("p", star())!.op).toBe("batch");
    expect(starMutationFor("p", star({ radius1: 0, radius2: 0 }))).toBeNull();
  });
});

describe("starParamsFrom", () => {
  it("takes the defaults for anything unreadable, magnitudes for radii, a whole in-range count", () => {
    expect(starParamsFrom()).toEqual(STAR_DEFAULTS);
    expect(
      starParamsFrom({
        cx: 1,
        cy: "x",
        radius1: -30,
        radius2: 12,
        points: 7.4,
        rotationDeg: 20,
      }),
    ).toEqual({
      cx: 1,
      cy: STAR_DEFAULTS.cy,
      radius1: 30,
      radius2: 12,
      points: 7,
      rotationDeg: 20,
    });
    expect(starParamsFrom({ points: 1 }).points).toBe(STAR_MIN_POINTS);
    expect(starParamsFrom({ points: 1e6 }).points).toBe(STAR_MAX_POINTS);
  });
});
