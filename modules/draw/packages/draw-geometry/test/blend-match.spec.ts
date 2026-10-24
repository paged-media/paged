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
  alignClosedRun,
  evalCubic,
  interpolateRamps,
  matchContourSets,
  matchRamps,
  rampColorAt,
  reverseRun,
  solidRamp,
  subdivideRun,
  type AnchorTriple,
  type RampStop,
} from "../src";

const corner = (x: number, y: number): AnchorTriple => ({
  anchor: [x, y],
  left: [x, y],
  right: [x, y],
});

const square = (x: number, y: number, s: number): AnchorTriple[] => [
  corner(x, y),
  corner(x + s, y),
  corner(x + s, y + s),
  corner(x, y + s),
];

/** Sample a closed run's outline densely (for "the shape did not change"). */
function outline(
  run: AnchorTriple[],
  closed: boolean,
  per = 16,
): [number, number][] {
  const out: [number, number][] = [];
  const segs = closed ? run.length : run.length - 1;
  for (let s = 0; s < segs; s++) {
    const a = run[s];
    const b = run[(s + 1) % run.length];
    for (let i = 0; i < per; i++)
      out.push(evalCubic(a.anchor, a.right, b.left, b.anchor, i / per));
  }
  return out;
}

const onOutline = (p: [number, number], ref: [number, number][], tol = 0.5) =>
  ref.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol);

describe("subdivideRun", () => {
  it("adds anchors ON the curve until the count matches, shape unchanged", () => {
    const sq = square(0, 0, 100);
    const out = subdivideRun(sq, true, 7);
    expect(out).toHaveLength(7);
    const ref = outline(sq, true, 64);
    for (const p of outline(out, true, 8))
      expect(onOutline(p, ref, 2)).toBe(true);
    // The original anchors survive, in order.
    const kept = out.filter((p) =>
      sq.some(
        (q) => q.anchor[0] === p.anchor[0] && q.anchor[1] === p.anchor[1],
      ),
    );
    expect(kept).toHaveLength(4);
  });

  it("splits a curved segment exactly (de Casteljau)", () => {
    const run: AnchorTriple[] = [
      { anchor: [0, 0], left: [0, 0], right: [0, 50] },
      { anchor: [100, 0], left: [100, 50], right: [100, 0] },
    ];
    const out = subdivideRun(run, false, 3);
    expect(out[1].anchor).toEqual(
      evalCubic([0, 0], [0, 50], [100, 50], [100, 0], 0.5),
    );
  });

  it("an open run never splits a closing segment", () => {
    const out = subdivideRun([corner(0, 0), corner(10, 0)], false, 3);
    expect(out.map((p) => p.anchor)).toEqual([
      [0, 0],
      [5, 0],
      [10, 0],
    ]);
  });
});

describe("alignClosedRun", () => {
  it("rotates the start to the least-movement correspondence", () => {
    const a = square(0, 0, 10);
    const rotated = [a[2], a[3], a[0], a[1]];
    const out = alignClosedRun(a, rotated);
    expect(out.map((p) => p.anchor)).toEqual(a.map((p) => p.anchor));
  });

  it("reverses a run wound the other way", () => {
    const a = square(0, 0, 10);
    const out = alignClosedRun(a, reverseRun(a));
    expect(out.map((p) => p.anchor)).toEqual(a.map((p) => p.anchor));
  });
});

describe("matchContourSets", () => {
  it("a square and a triangle get one anchor count", () => {
    const tri = [corner(0, 0), corner(60, 0), corner(30, 50)];
    const m = matchContourSets(
      { subpaths: [square(0, 0, 50)], open: [false] },
      { subpaths: [tri], open: [false] },
    );
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.a.subpaths[0]).toHaveLength(4);
    expect(m.b.subpaths[0]).toHaveLength(4);
    expect(m.added).toBe(1);
  });

  it("an extra contour grows from a collapsed point", () => {
    const m = matchContourSets(
      {
        subpaths: [square(0, 0, 50), square(10, 10, 10)],
        open: [false, false],
      },
      { subpaths: [square(100, 0, 50)], open: [false] },
    );
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.b.subpaths).toHaveLength(2);
    const pts = m.b.subpaths[1].map((p) => p.anchor);
    expect(new Set(pts.map(String)).size).toBe(1);
    expect(pts[0]).toEqual([15, 15]);
  });

  it("open against closed is refused with a reason", () => {
    const m = matchContourSets(
      { subpaths: [square(0, 0, 50)], open: [false] },
      { subpaths: [[corner(0, 0), corner(5, 5)]], open: [true] },
    );
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.reason).toContain("open in one key and closed in the other");
  });

  it("matching structures pass through untouched", () => {
    const a = { subpaths: [square(0, 0, 5)], open: [false] };
    const m = matchContourSets(a, {
      subpaths: [square(0, 0, 9)],
      open: [false],
    });
    expect(m.ok && m.added).toBe(0);
  });
});

describe("gradient ramps", () => {
  const bw: RampStop[] = [
    { rgb: [0, 0, 0], location: 0, midpoint: 50 },
    { rgb: [255, 255, 255], location: 100, midpoint: 50 },
  ];
  const three: RampStop[] = [
    { rgb: [255, 0, 0], location: 0, midpoint: 50 },
    { rgb: [0, 255, 0], location: 40, midpoint: 50 },
    { rgb: [0, 0, 255], location: 100, midpoint: 50 },
  ];

  it("evaluates a ramp with its midpoints", () => {
    expect(rampColorAt(bw, 50)).toEqual([128, 128, 128]);
    const skew = [{ ...bw[0], midpoint: 25 }, bw[1]];
    expect(rampColorAt(skew, 25)).toEqual([128, 128, 128]);
  });

  it("resamples both ramps at the union of their stop locations", () => {
    const m = matchRamps(bw, three);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.a.map((s) => s.location)).toEqual([0, 40, 100]);
    expect(m.b.map((s) => s.location)).toEqual([0, 40, 100]);
    expect(m.a[1].rgb).toEqual(rampColorAt(bw, 40));
  });

  it("refuses to resample across a moved midpoint", () => {
    const m = matchRamps([{ ...bw[0], midpoint: 30 }, bw[1]], three);
    expect(m.ok).toBe(false);
  });

  it("interpolates matched stops", () => {
    const mid = interpolateRamps(solidRamp([0, 0, 0]), bw, 0.5);
    expect(mid[1].rgb).toEqual([128, 128, 128]);
    expect(mid[0].rgb).toEqual([0, 0, 0]);
  });
});

describe("matchContourSets keeps a matching blend as it was", () => {
  it("equal counts keep the drawn anchor order (no realignment)", () => {
    const a = square(0, 0, 10);
    const b = [corner(50, 60), corner(50, 50), corner(60, 50), corner(60, 60)];
    const m = matchContourSets(
      { subpaths: [a], open: [false] },
      { subpaths: [b], open: [false] },
    );
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.b.subpaths[0].map((p) => p.anchor)).toEqual(
      b.map((p) => p.anchor),
    );
  });
});
