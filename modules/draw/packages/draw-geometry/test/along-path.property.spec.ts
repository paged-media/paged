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

// Property tests for along-path.ts — the ONE arc-length kernel under the
// blend spine and objects-on-a-path.

import { describe, expect, it } from "vitest";

import {
  EASE_KINDS,
  distributeAlongPath,
  ease,
  measureAnchorRun,
  measureSegment,
  pointAtFraction,
  pointAtLength,
  wrapOrClamp,
  type AnchorTriple,
  type PathMetric,
  type Vec2,
} from "../src";
import {
  anchorRun,
  assertClose,
  assertTrue,
  assertVecClose,
  cornerOf,
  fc,
  magnitude,
  polyline,
  real,
  refPolylineDistance,
  refPolylineLength,
  smallVec2,
  unit,
  vec2,
} from "./property-kit";

const samples = fc.integer({ min: 1, max: 24 });

/** Any metric the kernel can build: curved or straight, open or closed. */
const anyMetric: fc.Arbitrary<PathMetric> = fc
  .tuple(anchorRun(1, 6), fc.boolean(), samples)
  .map(([anchors, close, n]) =>
    measureAnchorRun(anchors, { close, samplesPerSegment: n }),
  );

/** A metric with real length (the properties below divide by it). */
const longMetric = anyMetric.filter((m) => m.length > 1e-3);

/** A polyline with no two consecutive points coincident, as a metric —
 *  every flattened segment has a direction. */
const cleanPolyline = polyline(2, 8, smallVec2).filter((pts) =>
  pts.every((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]),
);

const pointsOf = (m: PathMetric): Vec2[] => m.stations.map((s) => s.point);

const lengthTol = (m: PathMetric): number => 1e-9 * Math.max(1, m.length);

describe("along-path — measureAnchorRun (properties)", () => {
  it("accumulates a monotone arc length from 0 to `length`", () => {
    fc.assert(
      fc.property(anyMetric, (m) => {
        expect(m.stations[0].s).toBe(0);
        expect(m.stations[m.stations.length - 1].s).toBe(m.length);
        for (let i = 1; i < m.stations.length; i++) {
          assertTrue(
            m.stations[i].s >= m.stations[i - 1].s,
            `station ${i} goes backwards`,
          );
        }
        assertClose(m.length, refPolylineLength(pointsOf(m)), lengthTol(m), "length");
      }),
    );
  });

  it("starts on the path's first anchor and ends on its last (open) / first (closed)", () => {
    fc.assert(
      fc.property(anchorRun(1, 6), fc.boolean(), samples, (anchors, close, n) => {
        const m = measureAnchorRun(anchors, { close, samplesPerSegment: n });
        expect(m.closed).toBe(close);
        assertVecClose(m.stations[0].point, anchors[0].anchor, 0, "first station");
        const end = close ? anchors[0] : anchors[anchors.length - 1];
        assertVecClose(
          m.stations[m.stations.length - 1].point,
          end.anchor,
          0,
          "last station",
        );
      }),
    );
  });

  it("lies between the chord polygon and the control polygon", () => {
    // For every cubic: |chord| ≤ arc length ≤ control-polygon length, and
    // an inscribed flattening sits between the first two.
    fc.assert(
      fc.property(anchorRun(2, 6), fc.boolean(), samples, (anchors, close, n) => {
        const m = measureAnchorRun(anchors, { close, samplesPerSegment: n });
        const count = close ? anchors.length : anchors.length - 1;
        let chord = 0;
        let control = 0;
        for (let i = 0; i < count; i++) {
          const a = anchors[i];
          const b = anchors[(i + 1) % anchors.length];
          chord += refPolylineLength([a.anchor, b.anchor]);
          control += refPolylineLength([a.anchor, a.right, b.left, b.anchor]);
        }
        const slack = 1e-9 * Math.max(1, control);
        assertTrue(m.length >= chord - slack, `length ${m.length} < chord ${chord}`);
        assertTrue(
          m.length <= control + slack,
          `length ${m.length} > control polygon ${control}`,
        );
      }),
    );
  });

  it("doubling the samples never shortens the path (the flattening is inscribed)", () => {
    fc.assert(
      fc.property(
        anchorRun(2, 5),
        fc.boolean(),
        fc.integer({ min: 1, max: 12 }),
        (anchors, close, n) => {
          const coarse = measureAnchorRun(anchors, { close, samplesPerSegment: n });
          const fine = measureAnchorRun(anchors, {
            close,
            samplesPerSegment: 2 * n,
          });
          assertTrue(
            fine.length >= coarse.length - lengthTol(fine),
            `${2 * n} samples measured ${fine.length}, ${n} measured ${coarse.length}`,
          );
        },
      ),
    );
  });

  it("a corner run is measured EXACTLY as its polyline, one chord per segment", () => {
    fc.assert(
      fc.property(polyline(1, 8), fc.boolean(), samples, (pts, close, n) => {
        const m = measureAnchorRun(pts.map(cornerOf), {
          close,
          samplesPerSegment: n,
        });
        const ring = close ? [...pts, pts[0]] : pts;
        expect(m.stations).toHaveLength(ring.length);
        assertClose(m.length, refPolylineLength(ring), lengthTol(m), "length");
      }),
    );
  });

  it("an empty run is one station at the origin with no length", () => {
    expect(measureAnchorRun([])).toEqual({
      stations: [{ point: [0, 0], s: 0 }],
      length: 0,
      closed: false,
    });
  });

  it("measureSegment is the two-station metric of a straight line", () => {
    fc.assert(
      fc.property(vec2, vec2, (a, b) => {
        const m = measureSegment(a, b);
        expect(m.stations).toHaveLength(2);
        expect(m.closed).toBe(false);
        assertClose(m.length, refPolylineLength([a, b]), lengthTol(m));
        assertVecClose(m.stations[0].point, a, 0);
        assertVecClose(m.stations[1].point, b, 0);
      }),
    );
  });
});

describe("along-path — pointAtLength / pointAtFraction (properties)", () => {
  it("the arc-length parametrisation is MONOTONE", () => {
    fc.assert(
      fc.property(longMetric, unit, unit, (m, u1, u2) => {
        const lo = pointAtFraction(m, Math.min(u1, u2));
        const hi = pointAtFraction(m, Math.max(u1, u2));
        assertTrue(lo.s <= hi.s, `s(${lo.u}) = ${lo.s} > s(${hi.u}) = ${hi.s}`);
        assertTrue(lo.u <= hi.u, "u goes backwards");
      }),
    );
  });

  it("its end points are the path's end points", () => {
    fc.assert(
      fc.property(anchorRun(1, 6), fc.boolean(), samples, (anchors, close, n) => {
        const m = measureAnchorRun(anchors, { close, samplesPerSegment: n });
        fc.pre(m.length > 1e-3);
        const start = pointAtFraction(m, 0);
        const end = pointAtFraction(m, 1);
        const last = close ? anchors[0] : anchors[anchors.length - 1];
        const tol = 1e-9 * magnitude(...pointsOf(m));
        assertVecClose(start.point, anchors[0].anchor, tol, "u = 0");
        assertVecClose(end.point, last.anchor, tol, "u = 1");
        expect(start.s).toBe(0);
        expect(start.u).toBe(0);
        assertClose(end.s, m.length, lengthTol(m), "s at u = 1");
        assertClose(end.u, 1, 1e-12, "u at u = 1");
      }),
    );
  });

  it("reports s = u · length, both in range", () => {
    fc.assert(
      fc.property(longMetric, unit, (m, u) => {
        const p = pointAtFraction(m, u);
        assertTrue(p.s >= 0 && p.s <= m.length, `s = ${p.s}`);
        assertTrue(p.u >= 0 && p.u <= 1, `u = ${p.u}`);
        assertClose(p.s, u * m.length, lengthTol(m), "s");
        assertClose(p.u, p.s / m.length, 1e-12, "u");
      }),
    );
  });

  it("answers a point ON the flattened path", () => {
    fc.assert(
      fc.property(longMetric, unit, (m, u) => {
        const p = pointAtFraction(m, u);
        const pts = pointsOf(m);
        assertClose(
          refPolylineDistance(p.point, pts),
          0,
          1e-9 * magnitude(...pts),
          "distance to the flattening",
        );
      }),
    );
  });

  it("never moves faster than arc length (1-Lipschitz)", () => {
    fc.assert(
      fc.property(longMetric, unit, unit, (m, u1, u2) => {
        const a = pointAtFraction(m, u1);
        const b = pointAtFraction(m, u2);
        const moved = Math.hypot(b.point[0] - a.point[0], b.point[1] - a.point[1]);
        assertTrue(
          moved <= Math.abs(b.s - a.s) + 1e-9 * magnitude(...pointsOf(m)),
          `moved ${moved} for an arc of ${Math.abs(b.s - a.s)}`,
        );
      }),
    );
  });

  it("passes through every station at that station's arc length", () => {
    fc.assert(
      fc.property(longMetric, fc.nat(200), (m, pick) => {
        const st = m.stations[pick % m.stations.length];
        assertVecClose(
          pointAtLength(m, st.s).point,
          st.point,
          1e-9 * magnitude(...pointsOf(m)),
        );
      }),
    );
  });

  it("clamps s to [0, length] and reads NaN as the start", () => {
    fc.assert(
      fc.property(
        longMetric,
        real(0, 1e6),
        (m, beyond) => {
          expect(pointAtLength(m, -beyond)).toEqual(pointAtLength(m, 0));
          expect(pointAtLength(m, m.length + beyond)).toEqual(
            pointAtLength(m, m.length),
          );
          expect(pointAtLength(m, Number.NaN)).toEqual(pointAtLength(m, 0));
          expect(pointAtFraction(m, Number.NaN)).toEqual(pointAtLength(m, 0));
        },
      ),
    );
  });

  it("a degenerate metric answers its one point for every s", () => {
    fc.assert(
      fc.property(vec2, fc.double({ noNaN: true }), fc.boolean(), (p, s, close) => {
        const m = measureAnchorRun([cornerOf(p)], { close });
        expect(m.length).toBe(0);
        const at = pointAtLength(m, s);
        assertVecClose(at.point, p, 0);
        expect([at.s, at.u, at.tangentDeg]).toEqual([0, 0, 0]);
      }),
    );
  });

  it("on a straight line is the lerp, with the line's own direction", () => {
    fc.assert(
      fc.property(vec2, vec2, unit, (a, b, u) => {
        const m = measureSegment(a, b);
        fc.pre(m.length > 1e-3);
        const p = pointAtFraction(m, u);
        assertVecClose(
          p.point,
          [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u],
          1e-9 * magnitude(a, b),
        );
        assertClose(
          p.tangentDeg,
          (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI,
          1e-9,
          "tangentDeg",
        );
      }),
    );
  });

  it("the tangent is the direction of the flattened segment the point is on", () => {
    // Strictly INSIDE a segment of a polyline with no repeated points:
    // the one unambiguous case.
    fc.assert(
      fc.property(
        cleanPolyline,
        fc.nat(20),
        real(0.05, 0.95),
        (pts, pick, within) => {
          const m = measureAnchorRun(pts.map(cornerOf));
          const i = pick % (pts.length - 1);
          const s = m.stations[i].s + within * (m.stations[i + 1].s - m.stations[i].s);
          const expected =
            (Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]) * 180) /
            Math.PI;
          assertClose(pointAtLength(m, s).tangentDeg, expected, 1e-9, "tangentDeg");
        },
      ),
    );
  });

  it("at the START of a path, the tangent skips a leading zero-length segment", () => {
    // The well-behaved half of the defect below: a doubled FIRST anchor
    // does not cost the start its direction.
    fc.assert(
      fc.property(cleanPolyline, (pts) => {
        const doubled = [pts[0], ...pts];
        const m = measureAnchorRun(doubled.map(cornerOf));
        const expected =
          (Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]) * 180) / Math.PI;
        assertClose(pointAtFraction(m, 0).tangentDeg, expected, 1e-9, "tangentDeg");
      }),
    );
  });

  // ------------------------------------------------------------------
  // DEFECT (along-path.ts, pointAtLength) — the tangent at the END of a
  // path whose last flattened segment has zero length is reported as 0°.
  //
  // The binary search keeps `stations[lo].s ≤ want` and stops at
  // `hi − lo = 1`. For `want = length` it therefore always answers the
  // LAST segment, `[n−2, n−1]`. When that segment is degenerate (the last
  // anchor repeats the one before it; or, on a closed path, the last
  // anchor sits on the first so the closing segment is empty) its
  // direction is `atan2(0, 0) = 0`. At the START the same search walks
  // PAST leading zero-length segments (previous test), so the two ends of
  // one path behave differently.
  //
  // Minimal counterexample: the corner run (0,0) → (0,10) → (0,10), a
  // vertical line whose end anchor is doubled.
  //   EXPECTED: pointAtFraction(metric, 1).tangentDeg === 90 (the path
  //             runs straight DOWN the page, as it reports at u = 0.5).
  //   ACTUAL:   0.
  //
  // Consumer: objects-on-a-path with `endpoints: "inclusive"` puts its
  // last object at s = length; with rotate-to-path on, that object is
  // turned to 0° instead of along the path. A doubled end anchor is what
  // a double-click-to-finish pen path carries.
  // ------------------------------------------------------------------
  it.fails("DEFECT (minimal counterexample): the end tangent survives a doubled last anchor", () => {
    const m = measureAnchorRun(
      ([
        [0, 0],
        [0, 10],
        [0, 10],
      ] as Vec2[]).map(cornerOf),
    );
    expect(pointAtFraction(m, 0.5).tangentDeg).toBe(90);
    expect(pointAtFraction(m, 1).tangentDeg).toBe(90);
  });

  it.fails("DEFECT: at the END of a path, the tangent skips a trailing zero-length segment", () => {
    fc.assert(
      fc.property(cleanPolyline, (pts) => {
        const n = pts.length;
        const doubled = [...pts, pts[n - 1]];
        const m = measureAnchorRun(doubled.map(cornerOf));
        const expected =
          (Math.atan2(pts[n - 1][1] - pts[n - 2][1], pts[n - 1][0] - pts[n - 2][0]) *
            180) /
          Math.PI;
        assertClose(pointAtFraction(m, 1).tangentDeg, expected, 1e-9, "tangentDeg");
      }),
    );
  });
});

describe("along-path — distributeAlongPath (properties)", () => {
  const count = fc.integer({ min: 1, max: 40 });

  /** A metric built open or closed on demand. */
  const run = fc.tuple(anchorRun(2, 5), samples);
  const metricOf = (
    [anchors, n]: [AnchorTriple[], number],
    close: boolean,
  ): PathMetric => measureAnchorRun(anchors, { close, samplesPerSegment: n });

  it("COUNT / inclusive on an open path: `count` slots from the start to the end, evenly", () => {
    fc.assert(
      fc.property(run, count, (r, n) => {
        const m = metricOf(r, false);
        fc.pre(m.length > 1e-3);
        const slots = distributeAlongPath({ metric: m, mode: "count", count: n });
        expect(slots).toHaveLength(n);
        slots.forEach((slot, j) => {
          expect(slot.index).toBe(j);
          const u = n === 1 ? 0 : j / (n - 1);
          assertClose(slot.u, u, 1e-12, `slot ${j} u`);
          assertClose(slot.s, u * m.length, lengthTol(m), `slot ${j} s`);
        });
        expect(slots[0].s).toBe(0);
        if (n > 1) assertClose(slots[n - 1].s, m.length, lengthTol(m), "last s");
      }),
    );
  });

  it("COUNT / interior: `count` slots strictly between the ends, at k / (count + 1)", () => {
    fc.assert(
      fc.property(run, fc.boolean(), count, (r, close, n) => {
        const m = metricOf(r, close);
        fc.pre(m.length > 1e-3);
        const slots = distributeAlongPath({
          metric: m,
          mode: "count",
          count: n,
          endpoints: "interior",
        });
        expect(slots).toHaveLength(n);
        slots.forEach((slot, j) => {
          assertClose(slot.u, (j + 1) / (n + 1), 1e-12, `slot ${j} u`);
          assertTrue(slot.s > 0 && slot.s < m.length, `slot ${j} sits on an end`);
        });
      }),
    );
  });

  it("COUNT / inclusive on a closed path: j / count, and nothing on the seam twice", () => {
    fc.assert(
      fc.property(run, count, (r, n) => {
        const m = metricOf(r, true);
        fc.pre(m.length > 1e-3);
        const slots = distributeAlongPath({ metric: m, mode: "count", count: n });
        expect(slots).toHaveLength(n);
        slots.forEach((slot, j) => {
          assertClose(slot.s, (j / n) * m.length, lengthTol(m), `slot ${j} s`);
          assertTrue(slot.s < m.length, `slot ${j} repeats the seam`);
        });
      }),
    );
  });

  it("COUNT slots are in path order", () => {
    fc.assert(
      fc.property(
        run,
        fc.boolean(),
        count,
        fc.constantFrom("inclusive" as const, "interior" as const),
        (r, close, n, endpoints) => {
          const m = metricOf(r, close);
          fc.pre(m.length > 1e-3);
          const slots = distributeAlongPath({
            metric: m,
            mode: "count",
            count: n,
            endpoints,
          });
          for (let j = 1; j < slots.length; j++) {
            assertTrue(slots[j].s > slots[j - 1].s, `slot ${j} is out of order`);
          }
        },
      ),
    );
  });

  it("COUNT survives a ZERO-LENGTH path: every slot on the one point, each with its own fraction", () => {
    fc.assert(
      fc.property(
        vec2,
        count,
        fc.constantFrom("inclusive" as const, "interior" as const),
        (p, n, endpoints) => {
          const m = measureSegment(p, p);
          const slots = distributeAlongPath({
            metric: m,
            mode: "count",
            count: n,
            endpoints,
          });
          expect(slots).toHaveLength(n);
          slots.forEach((slot, j) => {
            assertVecClose(slot.point, p, 0);
            const u =
              endpoints === "interior" ? (j + 1) / (n + 1) : n === 1 ? 0 : j / (n - 1);
            assertClose(slot.u, u, 1e-12, `slot ${j} u`);
          });
        },
      ),
    );
  });

  it("a start offset on an OPEN path shifts every slot, and drops exactly the ones pushed off either end", () => {
    fc.assert(
      fc.property(
        run,
        count,
        real(-500, 500),
        fc.constantFrom("inclusive" as const, "interior" as const),
        (r, n, startOffsetPt, endpoints) => {
          const m = metricOf(r, false);
          fc.pre(m.length > 1e-3);
          const wanted = Array.from({ length: n }, (_, j) => {
            const u =
              endpoints === "interior" ? (j + 1) / (n + 1) : n === 1 ? 0 : j / (n - 1);
            return { j, u, s: u * m.length + startOffsetPt };
          });
          // A slot a hair's breadth from an end could go either way.
          const edge = 1e-6 * m.length;
          fc.pre(
            wanted.every(
              ({ s: at }) =>
                (at === 0 || Math.abs(at) > edge) &&
                (at === m.length || Math.abs(at - m.length) > edge),
            ),
          );
          const kept = wanted.filter(({ s: at }) => at >= 0 && at <= m.length);
          const slots = distributeAlongPath({
            metric: m,
            mode: "count",
            count: n,
            startOffsetPt,
            endpoints,
          });
          expect(slots.map((slot) => slot.index)).toEqual(kept.map((k) => k.j));
          slots.forEach((slot, i) => {
            assertClose(slot.s, kept[i].s, lengthTol(m), `slot ${slot.index} s`);
            assertClose(slot.u, kept[i].u, 1e-12, `slot ${slot.index} u`);
          });
        },
      ),
    );
  });

  it("a closed path WRAPS the start offset: always `count` slots, each a whole number of laps from where it was asked", () => {
    fc.assert(
      fc.property(
        run,
        count,
        real(-500, 500),
        (r, n, startOffsetPt) => {
          const m = metricOf(r, true);
          fc.pre(m.length > 1e-3);
          const slots = distributeAlongPath({
            metric: m,
            mode: "count",
            count: n,
            startOffsetPt,
          });
          expect(slots).toHaveLength(n);
          slots.forEach((slot, j) => {
            assertTrue(slot.s >= 0 && slot.s <= m.length, `s = ${slot.s}`);
            const laps = ((j / n) * m.length + startOffsetPt - slot.s) / m.length;
            assertClose(laps, Math.round(laps), 1e-6, `slot ${j}: laps between asked and placed`);
          });
        },
      ),
    );
  });

  it("SPACING on an open path: one slot every `spacing`, from 0 to the last that fits", () => {
    fc.assert(
      fc.property(
        run,
        real(0.01, 1),
        (r, fraction) => {
          const m = metricOf(r, false);
          fc.pre(m.length > 1e-3);
          const spacingPt = fraction * m.length;
          const slots = distributeAlongPath({ metric: m, mode: "spacing", spacingPt });
          assertTrue(slots.length >= 1, "no slot at the start");
          slots.forEach((slot, j) => {
            expect(slot.index).toBe(j);
            assertClose(slot.s, Math.min(m.length, j * spacingPt), lengthTol(m), `slot ${j} s`);
          });
          // The next one would not fit.
          assertTrue(
            slots.length * spacingPt > m.length - lengthTol(m),
            `${slots.length} slots at ${spacingPt} leave room on ${m.length}`,
          );
          assertTrue(
            (slots.length - 1) * spacingPt <= m.length + lengthTol(m),
            "a slot past the end",
          );
        },
      ),
    );
  });

  it("SPACING with a start offset on an open path: exactly the walk's steps that land ON the path", () => {
    fc.assert(
      fc.property(run, real(0.05, 1), real(-3, 2), (r, fraction, offsetLaps) => {
        const m = metricOf(r, false);
        fc.pre(m.length > 1e-3);
        const spacingPt = fraction * m.length;
        const startOffsetPt = offsetLaps * m.length;
        // The walk: offset, offset + spacing, … — the ones in [0, length].
        const expected: { j: number; s: number }[] = [];
        const edge = 1e-6 * m.length;
        let ambiguous = false;
        for (let j = 0; j < 200; j++) {
          const at = startOffsetPt + j * spacingPt;
          if (at > m.length + edge) break;
          if (Math.abs(at) <= edge || Math.abs(at - m.length) <= edge) ambiguous = true;
          if (at >= 0 && at <= m.length) expected.push({ j, s: at });
        }
        fc.pre(!ambiguous);
        const slots = distributeAlongPath({
          metric: m,
          mode: "spacing",
          spacingPt,
          startOffsetPt,
        });
        expect(slots.map((slot) => slot.index)).toEqual(expected.map((e) => e.j));
        slots.forEach((slot, i) => {
          assertClose(slot.s, expected[i].s, lengthTol(m), `slot ${slot.index} s`);
        });
      }),
    );
  });

  // ------------------------------------------------------------------
  // DEFECT (along-path.ts, distributeAlongPath, SPACING mode) — steps
  // that fall BEFORE the start of an open path are counted against
  // `maxSlots`, so a large negative start offset returns NOTHING.
  //
  // `maxSlots` is documented as "how many slots may be PRODUCED before
  // the walk gives up". The loop is `for (j = 0; j < max; j++)` and a
  // step with `s < 0` is skipped with `continue` — it produces no slot
  // but still spends one of the `max` iterations. Once more than `max`
  // steps lie before the path's start, the walk ends before it reaches
  // the path.
  //
  // Minimal counterexample: a straight 100 pt path, spacing 1 pt, start
  // offset −1500 pt (default maxSlots 1000).
  //   The walk −1500, −1499, … reaches the path at step 1500; steps
  //   1500…1600 are the 101 slots at s = 0, 1, …, 100.
  //   EXPECTED: those 101 slots.
  //   ACTUAL:   [] — indistinguishable from "the path has no room".
  //
  // Low severity: it needs an offset more than `maxSlots` steps before
  // the start. The count mode is not affected.
  // ------------------------------------------------------------------
  it.fails("DEFECT (minimal counterexample): skipped steps before the start do not use up maxSlots", () => {
    const slots = distributeAlongPath({
      metric: measureSegment([0, 0], [100, 0]),
      mode: "spacing",
      spacingPt: 1,
      startOffsetPt: -1500,
    });
    expect(slots).toHaveLength(101);
  });

  it("SPACING on a closed path: exactly one lap, never a slot back on the start", () => {
    fc.assert(
      fc.property(
        run,
        real(0.01, 1),
        (r, fraction) => {
          const m = metricOf(r, true);
          fc.pre(m.length > 1e-3);
          const spacingPt = fraction * m.length;
          const slots = distributeAlongPath({ metric: m, mode: "spacing", spacingPt });
          assertTrue(slots.length >= 1, "no slot at the start");
          slots.forEach((slot, j) => {
            assertTrue(j * spacingPt < m.length, `slot ${j} is past one lap`);
            assertClose(slot.s, j * spacingPt, lengthTol(m), `slot ${j} s`);
          });
        },
      ),
    );
  });

  it("SPACING refuses a non-positive gap and honours maxSlots", () => {
    fc.assert(
      fc.property(
        run,
        fc.boolean(),
        real(-100, 0),
        fc.integer({ min: 1, max: 20 }),
        (r, close, bad, maxSlots) => {
          const m = metricOf(r, close);
          fc.pre(m.length > 1e-3);
          expect(
            distributeAlongPath({ metric: m, mode: "spacing", spacingPt: bad }),
          ).toEqual([]);
          const capped = distributeAlongPath({
            metric: m,
            mode: "spacing",
            spacingPt: m.length / 1000,
            maxSlots,
          });
          expect(capped).toHaveLength(maxSlots);
        },
      ),
    );
  });
});

describe("along-path — wrapOrClamp (properties)", () => {
  const anyS = real(-1e5, 1e5);

  it("an OPEN path clamps into [0, length]", () => {
    fc.assert(
      fc.property(longMetric, anyS, (m, s) => {
        const open: PathMetric = { ...m, closed: false };
        expect(wrapOrClamp(open, s)).toBe(Math.min(open.length, Math.max(0, s)));
      }),
    );
  });

  it("a CLOSED path wraps into [0, length), congruent to s modulo the length", () => {
    fc.assert(
      fc.property(longMetric, anyS, (m, s) => {
        const closed: PathMetric = { ...m, closed: true };
        const w = wrapOrClamp(closed, s);
        assertTrue(w >= 0 && w <= closed.length, `wrapped to ${w}`);
        const laps = (s - w) / closed.length;
        assertClose(laps, Math.round(laps), 1e-6, "whole laps between s and its wrap");
      }),
    );
  });

  it("is idempotent (up to the seam of a closed path), and a zero-length path answers 0", () => {
    // The seam: on a closed path `length` and `0` are the same place, and
    // a NEGATIVE s smaller than half an ulp of the length wraps to
    // `s + length`, which rounds to `length` itself rather than into
    // [0, length). So "the same answer again" is taken modulo the length.
    fc.assert(
      fc.property(longMetric, fc.boolean(), anyS, vec2, (m, closed, s, p) => {
        const metric: PathMetric = { ...m, closed };
        const once = wrapOrClamp(metric, s);
        const twice = wrapOrClamp(metric, once);
        const gap = Math.abs(twice - once);
        assertTrue(
          gap <= lengthTol(metric) ||
            (closed && Math.abs(gap - metric.length) <= lengthTol(metric)),
          `wrap(${s}) = ${once}, wrap again = ${twice}`,
        );
        expect(wrapOrClamp({ ...measureSegment(p, p), closed }, s)).toBe(0);
      }),
    );
  });
});

describe("along-path — ease (properties)", () => {
  const kind = fc.constantFrom(...EASE_KINDS);

  it("fixes both ends and stays in [0, 1]", () => {
    fc.assert(
      fc.property(kind, unit, unit, (k, t, strength) => {
        expect(ease(0, k, strength)).toBe(0);
        expect(ease(1, k, strength)).toBe(1);
        const e = ease(t, k, strength);
        assertTrue(e >= 0 && e <= 1, `ease = ${e}`);
      }),
    );
  });

  it("is MONOTONE in t — an ease never reorders the steps of a blend", () => {
    fc.assert(
      fc.property(kind, unit, unit, unit, (k, t1, t2, strength) => {
        const lo = Math.min(t1, t2);
        const hi = Math.max(t1, t2);
        assertTrue(
          ease(lo, k, strength) <= ease(hi, k, strength) + 1e-15,
          `${k} at strength ${strength} reorders ${lo} and ${hi}`,
        );
      }),
    );
  });

  it("strength 0 and `linear` are both the identity", () => {
    fc.assert(
      fc.property(kind, unit, unit, (k, t, strength) => {
        expect(ease(t, k, 0)).toBe(t);
        expect(ease(t, "linear", strength)).toBe(t);
      }),
    );
  });

  it("strength is a BLEND between the identity and the full curve", () => {
    fc.assert(
      fc.property(kind, unit, unit, (k, t, strength) => {
        const full = ease(t, k, 1);
        assertClose(ease(t, k, strength), t + (full - t) * strength, 1e-12);
      }),
    );
  });

  it("easeIn lags, easeOut leads, and easeInOut is symmetric about the middle", () => {
    fc.assert(
      fc.property(unit, unit, (t, strength) => {
        assertTrue(ease(t, "easeIn", strength) <= t + 1e-15, "easeIn leads");
        assertTrue(ease(t, "easeOut", strength) >= t - 1e-15, "easeOut lags");
        assertClose(
          ease(1 - t, "easeInOut", strength),
          1 - ease(t, "easeInOut", strength),
          1e-12,
          "easeInOut symmetry",
        );
        assertClose(
          ease(1 - t, "easeOut", strength),
          1 - ease(t, "easeIn", strength),
          1e-12,
          "easeOut is easeIn mirrored",
        );
      }),
    );
  });

  it("clamps t and strength, and treats non-finite input as 0", () => {
    fc.assert(
      fc.property(
        kind,
        real(-50, 50),
        real(-50, 50),
        (k, t, strength) => {
          const clampedT = Math.min(1, Math.max(0, t));
          const clampedK = Math.min(1, Math.max(0, strength));
          expect(ease(t, k, strength)).toBe(ease(clampedT, k, clampedK));
          expect(ease(Number.NaN, k, strength)).toBe(0);
          expect(ease(t, k, Number.NaN)).toBe(clampedT);
        },
      ),
    );
  });
});
