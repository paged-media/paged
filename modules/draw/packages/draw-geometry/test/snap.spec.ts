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

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  anchorTargets,
  closestOnSegment,
  pageTargets,
  snapPoint,
  type SnapTarget,
} from "../src";

describe("snapPoint", () => {
  const targets: SnapTarget[] = [
    { kind: "point", at: [100, 100] },
    { kind: "x", x: 50 },
    { kind: "y", y: 200 },
    { kind: "segment", a: [300, 0], b: [300, 400] },
  ];

  it("a point within tolerance wins outright and lands exactly on it", () => {
    const r = snapPoint([103, 98], targets, 5);
    expect(r.point).toEqual([100, 100]);
    expect(r.point_target).toEqual(targets[0]);
    expect(r.x_target).toBeNull();
  });

  it("the axes snap independently to alignment lines", () => {
    const r = snapPoint([52, 197], targets, 5);
    expect(r.point).toEqual([50, 200]);
    expect(r.x_target).toEqual(targets[1]);
    expect(r.y_target).toEqual(targets[2]);
    const only_x = snapPoint([52, 150], targets, 5);
    expect(only_x.point).toEqual([50, 150]);
    expect(only_x.y_target).toBeNull();
  });

  it("falls back to the nearest point on a segment", () => {
    const r = snapPoint([303, 250], targets, 5);
    expect(r.point).toEqual([300, 250]);
    expect(r.segment_target).toEqual(targets[3]);
  });

  it("outside tolerance, or with a bad tolerance, nothing moves", () => {
    expect(snapPoint([150, 150], targets, 5).point).toEqual([150, 150]);
    for (const tol of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(snapPoint([101, 101], targets, tol).point).toEqual([101, 101]);
    }
  });

  it("property: a snapped point is never farther than the tolerance per axis, and snapping is idempotent", () => {
    const coord = fc.double({ min: -500, max: 500, noNaN: true, noDefaultInfinity: true });
    const target: fc.Arbitrary<SnapTarget> = fc.oneof(
      fc.tuple(coord, coord).map(([x, y]): SnapTarget => ({ kind: "point", at: [x, y] })),
      coord.map((x): SnapTarget => ({ kind: "x", x })),
      coord.map((y): SnapTarget => ({ kind: "y", y })),
      fc
        .tuple(coord, coord, coord, coord)
        .map(([a, b, c, d]): SnapTarget => ({ kind: "segment", a: [a, b], b: [c, d] })),
    );
    fc.assert(
      fc.property(
        fc.tuple(coord, coord),
        fc.array(target, { maxLength: 12 }),
        fc.double({ min: 0.5, max: 20, noNaN: true }),
        (p, ts, tol) => {
          const r = snapPoint(p, ts, tol);
          const moved = Math.hypot(r.point[0] - p[0], r.point[1] - p[1]);
          // A point or segment snap moves at most `tol`; an axis snap at
          // most `tol` per axis.
          expect(moved).toBeLessThanOrEqual(tol * Math.SQRT2 + 1e-9);
          const again = snapPoint(r.point, ts, tol);
          if (r.point_target) expect(again.point).toEqual(r.point);
        },
      ),
      { seed: 20261004, numRuns: 300 },
    );
  });
});

describe("candidate builders", () => {
  it("anchorTargets adds each point and merges aligned lines", () => {
    const t = anchorTargets([
      [10, 10],
      [10, 50],
      [40, 10],
    ]);
    expect(t.filter((x) => x.kind === "point")).toHaveLength(3);
    expect(t.filter((x) => x.kind === "x")).toHaveLength(2);
    expect(t.filter((x) => x.kind === "y")).toHaveLength(2);
  });

  it("pageTargets snaps to the page centre", () => {
    const r = snapPoint([304, 398], pageTargets(612, 792), 6);
    expect(r.point).toEqual([306, 396]);
  });

  it("closestOnSegment clamps to the ends and handles a zero-length segment", () => {
    expect(closestOnSegment([-10, 5], [0, 0], [10, 0])).toEqual([0, 0]);
    expect(closestOnSegment([5, 5], [3, 3], [3, 3])).toEqual([3, 3]);
  });
});
