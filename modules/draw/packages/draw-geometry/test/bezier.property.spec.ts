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

// Property tests for bezier.ts — the cubic kernel the pen, the anchor
// editors and every flattening consumer stand on.

import { describe, expect, it } from "vitest";

import {
  closestTOnCubic,
  dist,
  evalCubic,
  flattenAnchorRun,
  splitSegmentDeCasteljau,
  type AnchorTriple,
  type Vec2,
} from "../src";
import {
  anchorRun,
  assertClose,
  assertTrue,
  assertVecClose,
  coord,
  cubic,
  fc,
  magnitude,
  real,
  refEvalCubic,
  smallCubic,
  smallVec2,
  unit,
  vec2,
  type Cubic,
} from "./property-kit";

/** Relative tolerance for "the same point, up to floating point". */
const FP = 1e-9;

const maxLeg = (c: Cubic): number =>
  Math.max(dist(c[0], c[1]), dist(c[1], c[2]), dist(c[2], c[3]));

/** `closestTOnCubic`'s default coarse sample count. */
const COARSE = 30;

/**
 * What the COARSE SCAN ALONE guarantees, and therefore the tolerance
 * every "closest" property below is stated to. A cubic's speed is at
 * most `3 · maxLeg` (the derivative is a convex combination of the three
 * control legs, times 3), the true closest parameter is at most
 * `1 / (2·COARSE)` from a coarse sample, so the best coarse sample is at
 * most `3·maxLeg / (2·COARSE)` further from the click than the true
 * closest point. A refinement step may only tighten this.
 */
const coarseBound = (c: Cubic): number => (3 * maxLeg(c)) / (2 * COARSE);

/** Dense brute-force closest distance — the reference scan. */
function bruteForceDistance(c: Cubic, click: Vec2, n = 2000): number {
  let best = Infinity;
  for (let i = 0; i <= n; i++) {
    best = Math.min(best, dist(refEvalCubic(c, i / n), click));
  }
  return best;
}

describe("bezier — evalCubic (properties)", () => {
  it("agrees with an independent de Casteljau evaluation", () => {
    fc.assert(
      fc.property(cubic, unit, (c, t) => {
        assertVecClose(
          evalCubic(c[0], c[1], c[2], c[3], t),
          refEvalCubic(c, t),
          FP * magnitude(...c),
        );
      }),
    );
  });

  it("interpolates its end points exactly at t = 0 and t = 1", () => {
    fc.assert(
      fc.property(cubic, (c) => {
        // Tolerance 0, i.e. `===` per component: exact, but blind to the
        // sign of zero (the Bernstein sum answers +0 for a −0 end point,
        // which is the same point).
        assertVecClose(evalCubic(c[0], c[1], c[2], c[3], 0), c[0], 0);
        assertVecClose(evalCubic(c[0], c[1], c[2], c[3], 1), c[3], 0);
      }),
    );
  });

  it("stays inside the control polygon's bounding box for t in [0, 1]", () => {
    // The convex-hull property, in its axis-aligned form.
    fc.assert(
      fc.property(cubic, unit, (c, t) => {
        const p = evalCubic(c[0], c[1], c[2], c[3], t);
        const slack = FP * magnitude(...c);
        for (const axis of [0, 1] as const) {
          const lo = Math.min(...c.map((q) => q[axis]));
          const hi = Math.max(...c.map((q) => q[axis]));
          assertTrue(
            p[axis] >= lo - slack && p[axis] <= hi + slack,
            `axis ${axis}: ${p[axis]} outside [${lo}, ${hi}]`,
          );
        }
      }),
    );
  });

  it("commutes with a translation of the control points", () => {
    fc.assert(
      fc.property(cubic, unit, vec2, (c, t, d) => {
        const moved = c.map((p) => [p[0] + d[0], p[1] + d[1]]) as Cubic;
        const p = evalCubic(c[0], c[1], c[2], c[3], t);
        assertVecClose(
          evalCubic(moved[0], moved[1], moved[2], moved[3], t),
          [p[0] + d[0], p[1] + d[1]],
          FP * magnitude(...c, ...moved),
        );
      }),
    );
  });
});

describe("bezier — splitSegmentDeCasteljau (properties)", () => {
  it("the LEFT half reproduces the original curve on [0, t]", () => {
    fc.assert(
      fc.property(cubic, unit, unit, (c, t, s) => {
        const split = splitSegmentDeCasteljau(c[0], c[1], c[2], c[3], t);
        const left: Cubic = [
          c[0],
          split.startRight,
          split.midLeft,
          split.midAnchor,
        ];
        assertVecClose(
          refEvalCubic(left, s),
          refEvalCubic(c, s * t),
          FP * magnitude(...c),
          `left half at s=${s}`,
        );
      }),
    );
  });

  it("the RIGHT half reproduces the original curve on [t, 1]", () => {
    fc.assert(
      fc.property(cubic, unit, unit, (c, t, s) => {
        const split = splitSegmentDeCasteljau(c[0], c[1], c[2], c[3], t);
        const right: Cubic = [
          split.midAnchor,
          split.midRight,
          split.endLeft,
          c[3],
        ];
        assertVecClose(
          refEvalCubic(right, s),
          refEvalCubic(c, t + s * (1 - t)),
          FP * magnitude(...c),
          `right half at s=${s}`,
        );
      }),
    );
  });

  it("the new anchor is the curve's own point at t", () => {
    fc.assert(
      fc.property(cubic, unit, (c, t) => {
        const split = splitSegmentDeCasteljau(c[0], c[1], c[2], c[3], t);
        assertVecClose(
          split.midAnchor,
          evalCubic(c[0], c[1], c[2], c[3], t),
          FP * magnitude(...c),
        );
      }),
    );
  });

  it("the new anchor is SMOOTH: it divides its two handles t : (1 − t)", () => {
    // midAnchor = midLeft + t·(midRight − midLeft) — the last lerp of the
    // construction, and the reason an inserted anchor never kinks the
    // curve.
    fc.assert(
      fc.property(cubic, unit, (c, t) => {
        const { midLeft, midAnchor, midRight } = splitSegmentDeCasteljau(
          c[0],
          c[1],
          c[2],
          c[3],
          t,
        );
        assertVecClose(
          midAnchor,
          [
            midLeft[0] + t * (midRight[0] - midLeft[0]),
            midLeft[1] + t * (midRight[1] - midLeft[1]),
          ],
          FP * magnitude(...c),
        );
      }),
    );
  });

  it("degenerates onto the end points at t = 0 (exactly) and t = 1 (to an ulp)", () => {
    // `a + t·(b − a)` is exact at t = 0 and only ulp-close at t = 1
    // (`a + (b − a)` need not round back to `b`), so the two ends are
    // stated to different tolerances on purpose.
    fc.assert(
      fc.property(cubic, (c) => {
        const at0 = splitSegmentDeCasteljau(c[0], c[1], c[2], c[3], 0);
        assertVecClose(at0.midAnchor, c[0], 0, "t=0 midAnchor");
        assertVecClose(at0.startRight, c[0], 0, "t=0 startRight");
        assertVecClose(at0.midLeft, c[0], 0, "t=0 midLeft");
        assertVecClose(at0.midRight, c[1], 0, "t=0 midRight");
        assertVecClose(at0.endLeft, c[2], 0, "t=0 endLeft");
        const tol = FP * magnitude(...c);
        const at1 = splitSegmentDeCasteljau(c[0], c[1], c[2], c[3], 1);
        assertVecClose(at1.midAnchor, c[3], tol, "t=1 midAnchor");
        assertVecClose(at1.endLeft, c[3], tol, "t=1 endLeft");
        assertVecClose(at1.midRight, c[3], tol, "t=1 midRight");
        assertVecClose(at1.midLeft, c[2], tol, "t=1 midLeft");
        assertVecClose(at1.startRight, c[1], tol, "t=1 startRight");
      }),
    );
  });
});

describe("bezier — closestTOnCubic (properties)", () => {
  it("answers a finite parameter in [0, 1]", () => {
    fc.assert(
      fc.property(cubic, vec2, (c, click) => {
        const t = closestTOnCubic(c[0], c[1], c[2], c[3], click);
        assertTrue(Number.isFinite(t) && t >= 0 && t <= 1, `t = ${t}`);
      }),
    );
  });

  it("is EXACT for a click on one of its coarse sample points", () => {
    // A click at B(k/30) is found by the coarse scan with distance ~0,
    // and the refinement has nothing left to correct.
    fc.assert(
      fc.property(
        cubic,
        fc.integer({ min: 0, max: COARSE }),
        (c, k) => {
          const click = refEvalCubic(c, k / COARSE);
          const t = closestTOnCubic(c[0], c[1], c[2], c[3], click);
          assertClose(
            dist(evalCubic(c[0], c[1], c[2], c[3], t), click),
            0,
            1e-7 * magnitude(...c),
            "distance to an on-sample click",
          );
        },
      ),
    );
  });

  it("is EXACT (the analytic projection) on a uniformly parametrised line", () => {
    // Control points at thirds make B(t) = a + t·(b − a): the squared
    // distance is a parabola in t, so ONE Newton step from anywhere lands
    // on the foot of the perpendicular. This is the case the refinement
    // is exact for, stated to 1e-7.
    fc.assert(
      fc.property(vec2, vec2, vec2, (a, b, click) => {
        const len = dist(a, b);
        fc.pre(len > 0.01);
        const third = (k: number): [number, number] => [
          a[0] + (k * (b[0] - a[0])) / 3,
          a[1] + (k * (b[1] - a[1])) / 3,
        ];
        const t = closestTOnCubic(a, third(1), third(2), b, click);
        const projected =
          ((click[0] - a[0]) * (b[0] - a[0]) + (click[1] - a[1]) * (b[1] - a[1])) /
          (len * len);
        assertClose(t, Math.min(1, Math.max(0, projected)), 1e-7, "t");
      }),
    );
  });

  it("finds an on-curve click on a quarter-ellipse arc to 1e-3 of its radius", () => {
    // The κ-cubic quarter arc is the commonest curved segment a document
    // holds (every ellipse, every rounded corner), and it is TAME: nearly
    // uniform speed, no cusp. One Newton step from a sample ≤ 1/60 away
    // leaves a parameter error of order (1/60)², i.e. ~1e-4 of the radius.
    // Stated to 1e-3. (For an ARBITRARY cubic no such statement holds —
    // see the defect block below, whose on-curve counterexample misses by
    // 3.27 units.)
    const KAPPA = (4 / 3) * (Math.SQRT2 - 1);
    fc.assert(
      fc.property(
        vec2,
        real(0.5, 500),
        real(0.5, 500),
        unit,
        (center, rx, ry, t0) => {
          const c: Cubic = [
            [center[0] + rx, center[1]],
            [center[0] + rx, center[1] + KAPPA * ry],
            [center[0] + KAPPA * rx, center[1] + ry],
            [center[0], center[1] + ry],
          ];
          const click = refEvalCubic(c, t0);
          const t = closestTOnCubic(c[0], c[1], c[2], c[3], click);
          assertClose(
            dist(evalCubic(c[0], c[1], c[2], c[3], t), click),
            0,
            1e-3 * Math.max(rx, ry),
            "distance to an on-arc click",
          );
        },
      ),
    );
  });

  // ------------------------------------------------------------------
  // DEFECT (bezier.ts, closestTOnCubic) — the Newton refinement is
  // UNGUARDED and routinely returns a parameter that is WORSE than the
  // coarse sample it started from.
  //
  // The function scans 31 samples, then takes ONE Gauss-Newton step
  // (`refined = bestT − f/fp`, second-derivative term dropped) and returns
  // `refined` whenever it lands in [0, 1] — without checking that it is
  // any closer. A full Gauss-Newton step is a descent step only while the
  // residual (click → curve) is small against the radius of curvature.
  // For a click off the curve, or where |B'| is small (an apex, a
  // near-cusp), the step overshoots and the answer moves AWAY. The
  // docstring's "converges from the coarse start; stability over speed"
  // is the claim this contradicts.
  //
  // Measured over 200 000 random integer cubics in a ±10 box with clicks
  // in ±15: 28 % of the answers were further from the click than the
  // function's own coarse best.
  //
  // MINIMAL counterexample (fast-check shrink, seed 20261002):
  //   start (1,−1), startRight (0,0), endLeft (0,0), end (0,−1) — a
  //   hairpin whose apex is near (0.125, −0.25) — and click (0, 1).
  //   Coarse best: t = 0.5, distance 1.2562 (the apex; brute force over
  //   2001 samples: 1.2558).
  //   There B' = (−0.75, 0) and click→curve = (0.125, −1.25), so the step
  //   is +0.09375 / 0.5625 = +1/6.
  //   EXPECTED: a parameter no further than 1.2562 from the click.
  //   ACTUAL:   t = 0.6667, distance 1.3338.
  //
  // A LARGE one, same cause: start (−1,5), startRight (−7,9), endLeft
  // (6,7), end (7,−6), click (−11,12). Coarse best t = 0 at 9.99;
  // answered t = 0.913 at 22.94 — the far end of the curve.
  //
  // And a click EXACTLY ON the curve, which is the case the Add Anchor
  // tool lives on: start (5,7), startRight (−2,−8), endLeft (6,10), end
  // (7,8), click = B(0.3225334362697478) — beside the curve's near-cusp.
  // Coarse best 0.031 away; answered t = 0.583, 3.27 away from a point
  // that is on the curve. (2 000 000 random on-curve clicks: 16 answers
  // beyond the coarse bound, 509 worse than the coarse sample. Rare, and
  // exactly where a user clicks to fix a kink.)
  //
  // Consumer: `planAnchorAdd` (draw-tools anchor-machine) accepts a
  // segment only when `dist(evalCubic(t), click) ≤ tolerance`. A
  // refinement that walks away turns a click that WAS within tolerance of
  // the coarse sample into a miss, so Add Anchor can refuse a click near
  // a tight bend, or pick the split point visibly off the cursor.
  //
  // The fix is one comparison (keep `bestT` unless the refined point is
  // nearer). NOT applied — these tests are the record. When it is fixed
  // all three go red; flip them to `it`.
  // ------------------------------------------------------------------
  const coarseBest = (c: Cubic, click: Vec2): number => {
    let best = Infinity;
    for (let k = 0; k <= COARSE; k++) {
      best = Math.min(best, dist(refEvalCubic(c, k / COARSE), click));
    }
    return best;
  };

  it.fails(
    "DEFECT: is no worse than a dense brute-force scan (tolerance: the coarse-grid bound)",
    () => {
      fc.assert(
        fc.property(smallCubic, smallVec2, (c, click) => {
          const t = closestTOnCubic(c[0], c[1], c[2], c[3], click);
          const d = dist(evalCubic(c[0], c[1], c[2], c[3], t), click);
          const best = bruteForceDistance(c, click);
          assertTrue(
            d <= best + coarseBound(c) + FP * magnitude(...c, click),
            `answered t=${t} at distance ${d}; brute force finds ${best} ` +
              `(+ coarse bound ${coarseBound(c)})`,
          );
        }),
      );
    },
  );

  it.fails(
    "DEFECT (minimal counterexample): the refinement is not worse than the coarse scan it started from",
    () => {
      const c: Cubic = [
        [1, -1],
        [0, 0],
        [0, 0],
        [0, -1],
      ];
      const click: Vec2 = [0, 1];
      const t = closestTOnCubic(c[0], c[1], c[2], c[3], click);
      const d = dist(evalCubic(c[0], c[1], c[2], c[3], t), click);
      // coarse 1.2562 (t = 0.5); answered t = 2/3 at 1.3338.
      expect(d).toBeLessThanOrEqual(coarseBest(c, click) + 1e-9);
    },
  );

  it.fails(
    "DEFECT (on-curve counterexample): a click ON the curve is found to within the coarse-grid bound",
    () => {
      const c: Cubic = [
        [5, 7],
        [-2, -8],
        [6, 10],
        [7, 8],
      ];
      const click = refEvalCubic(c, 0.3225334362697478);
      const t = closestTOnCubic(c[0], c[1], c[2], c[3], click);
      const d = dist(evalCubic(c[0], c[1], c[2], c[3], t), click);
      // coarse bound 0.985, coarse best 0.031; answered t ≈ 0.583 at 3.27.
      expect(d).toBeLessThanOrEqual(coarseBound(c));
    },
  );

  it.fails(
    "DEFECT (large counterexample): a far click is not sent to the wrong end of the curve",
    () => {
      const c: Cubic = [
        [-1, 5],
        [-7, 9],
        [6, 7],
        [7, -6],
      ];
      const click: Vec2 = [-11, 12];
      const t = closestTOnCubic(c[0], c[1], c[2], c[3], click);
      const d = dist(evalCubic(c[0], c[1], c[2], c[3], t), click);
      // coarse 9.99 (t = 0); answered t ≈ 0.913 at 22.94.
      expect(d).toBeLessThanOrEqual(coarseBest(c, click) + 1e-9);
    },
  );
});

describe("bezier — flattenAnchorRun (properties)", () => {
  const samples = fc.integer({ min: 1, max: 16 });

  const isStraight = (a: AnchorTriple, b: AnchorTriple): boolean =>
    a.right[0] === a.anchor[0] &&
    a.right[1] === a.anchor[1] &&
    b.left[0] === b.anchor[0] &&
    b.left[1] === b.anchor[1];

  it("starts on the first anchor and ends on the last (open) / first (closed)", () => {
    fc.assert(
      fc.property(anchorRun(1, 8), fc.boolean(), samples, (anchors, close, n) => {
        const out = flattenAnchorRun(anchors, { close, samplesPerSegment: n });
        assertVecClose(out[0], anchors[0].anchor, 0, "first point");
        const last = close ? anchors[0] : anchors[anchors.length - 1];
        assertVecClose(out[out.length - 1], last.anchor, 0, "last point");
      }),
    );
  });

  it("emits 1 point per straight segment and `samplesPerSegment` per curved one", () => {
    fc.assert(
      fc.property(anchorRun(1, 8), fc.boolean(), samples, (anchors, close, n) => {
        const count = close ? anchors.length : anchors.length - 1;
        let expected = 1;
        for (let i = 0; i < count; i++) {
          const a = anchors[i];
          const b = anchors[(i + 1) % anchors.length];
          expected += isStraight(a, b) ? 1 : n;
        }
        expect(
          flattenAnchorRun(anchors, { close, samplesPerSegment: n }),
        ).toHaveLength(expected);
      }),
    );
  });

  it("every emitted point lies on its segment's cubic at k / samples", () => {
    fc.assert(
      fc.property(anchorRun(2, 6), fc.boolean(), samples, (anchors, close, n) => {
        const out = flattenAnchorRun(anchors, { close, samplesPerSegment: n });
        const count = close ? anchors.length : anchors.length - 1;
        let at = 1;
        for (let i = 0; i < count; i++) {
          const a = anchors[i];
          const b = anchors[(i + 1) % anchors.length];
          const c: Cubic = [a.anchor, a.right, b.left, b.anchor];
          if (isStraight(a, b)) {
            assertVecClose(out[at++], b.anchor, 0, `straight segment ${i}`);
            continue;
          }
          for (let k = 1; k <= n; k++) {
            assertVecClose(
              out[at++],
              refEvalCubic(c, k / n),
              FP * magnitude(...c),
              `segment ${i}, sample ${k}`,
            );
          }
        }
        expect(at).toBe(out.length);
      }),
    );
  });

  it("an empty run flattens to nothing, and the output never aliases the input", () => {
    expect(flattenAnchorRun([])).toEqual([]);
    fc.assert(
      fc.property(anchorRun(1, 5), coord, (anchors, poison) => {
        // Work on a copy: if the output DID alias its input, poisoning it
        // would corrupt fast-check's own value mid-shrink.
        const input = structuredClone(anchors);
        const before = JSON.stringify(input);
        const out = flattenAnchorRun(input, { close: true });
        for (const p of out) {
          p[0] = poison + 1;
          p[1] = poison - 1;
        }
        expect(JSON.stringify(input)).toBe(before);
      }),
    );
  });
});
