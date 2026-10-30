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

// ORACLE — Illustrator's 9-SLICE SCALING against draw-geometry's
// `nineSlicePoint` (`src/nine-slice.ts`), the mapping the engine's
// renderer applies to a scaled symbol instance with guides (engine ADR
// 1039, draw ADR 365).
//
// The recording (`scripts/illustrator/probes/nine-slice.jsx`) makes a
// symbol of a chamfered 100 x 60 pt box with guides, places it, resizes
// it about its centre and breaks the link, which expands it WITH the
// slicing. Illustrator inserts an anchor where a cut crosses an edge; the
// engine clips copies and inserts none, so the comparison is of SHAPE:
//
//   1. every anchor Illustrator wrote lies on OUR mapped outline (the
//      input densely sampled, every sample through `nineSlicePoint`);
//   2. every input anchor, mapped by us, lies on ILLUSTRATOR's outline;
//   3. a corner keeps its size: the 10 pt chamfers stay 10 pt.
//
// All within 0.05 pt. The instance's centre is the centre of what
// Illustrator wrote (it resizes about the centre, and its placement is
// its own).

import { describe, expect, it } from "bun:test";

import {
  nineSlicePoint,
  type Affine,
  type NineSliceInsets,
} from "@paged-media/draw-geometry";

import { loadOracle, pathBounds, type Vec2 } from "./oracle";

interface Params {
  box: [number, number, number, number];
  insets: [number, number, number, number];
  sx: number;
  sy: number;
  grid_read_back: [number, number, number, number];
}

const FIXTURE = loadOracle<Params>("nine-slice");
const TOL = 0.05;

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t =
    l2 === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2),
        );
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function distToPolyline(
  p: Vec2,
  pts: readonly Vec2[],
  closed: boolean,
): number {
  let best = Infinity;
  const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    best = Math.min(best, distToSegment(p, pts[i]!, pts[(i + 1) % n]!));
  }
  return best;
}

describe("Illustrator's 9-slice scaling", () => {
  it("the recording is the probe's", () => {
    expect(FIXTURE.cases).toHaveLength(6);
    for (const c of FIXTURE.cases) {
      const [l, t, r, b] = c.parameters.insets;
      const [x0, y0, x1, y1] = c.parameters.box;
      // The grid Illustrator read back is the one the probe set.
      expect(c.parameters.grid_read_back).toEqual([
        l,
        y1 - y0 - t,
        x1 - x0 - r,
        b,
      ]);
    }
  });

  for (const c of FIXTURE.cases) {
    const p = c.parameters;
    it(`${c.id}: insets ${p.insets.join("/")} at ${p.sx} x ${p.sy}`, () => {
      const [x0, y0, x1, y1] = p.box;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      // Definition space: the box centred on its registration point.
      const box: [number, number, number, number] = [
        x0 - cx,
        y0 - cy,
        x1 - cx,
        y1 - cy,
      ];
      const theirs = c.measured.paths[0]!;
      const tb = pathBounds(theirs);
      const matrix: Affine = [
        p.sx,
        0,
        0,
        p.sy,
        (tb[0] + tb[2]) / 2,
        (tb[1] + tb[3]) / 2,
      ];
      const insets: NineSliceInsets = p.insets;
      const map = (q: Vec2): Vec2 =>
        nineSlicePoint([q[0] - cx, q[1] - cy], box, insets, matrix) as Vec2;
      const input = c.input.paths[0]!.anchors.map((a) => a.anchor as Vec2);
      // Our outline, densely.
      const dense: Vec2[] = [];
      for (let i = 0; i < input.length; i++) {
        const a = input[i]!;
        const b = input[(i + 1) % input.length]!;
        for (let k = 0; k < 400; k++) {
          const t = k / 400;
          dense.push(map([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]));
        }
      }
      const theirAnchors = theirs.anchors.map((a) => a.anchor as Vec2);
      for (const q of theirAnchors) {
        expect(distToPolyline(q, dense, true)).toBeLessThan(TOL);
      }
      for (const q of input.map(map)) {
        expect(distToPolyline(q, theirAnchors, true)).toBeLessThan(TOL);
      }
      // The chamfers keep their 10 pt.
      const ours = input.map(map);
      expect(Math.abs(ours[2]![0] - ours[1]![0])).toBeCloseTo(10, 3);
      expect(Math.abs(ours[2]![1] - ours[1]![1])).toBeCloseTo(10, 3);
    });
  }
});
