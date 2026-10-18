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

// Property tests for constrain.ts — the Shift angle constraint of the pen
// and the measure tool.

import { describe, expect, it } from "vitest";

import { constrainAngle, dist, type Vec2 } from "../src";
import {
  assertClose,
  assertTrue,
  assertVecClose,
  fc,
  magnitude,
  real,
  smallVec2,
  vec2,
} from "./property-kit";

/** Steps that divide a half turn — what a UI offers. For these the
 *  snapped direction is a multiple of the step however it is measured. */
const niceStep = fc.constantFrom(1, 5, 7.5, 10, 15, 22.5, 30, 45, 60, 90, 180);

/** Any positive step, including ones that do not divide a turn. */
const anyStep = fc.oneof(niceStep, real(0.5, 180));

/** An (origin, point) pair that is not degenerate: the point is a real
 *  distance from the origin, so it HAS a direction. */
const armed = fc
  .tuple(vec2, vec2)
  .filter(([o, p]) => dist(o, p) > 1e-3 * magnitude(o, p));

const DEG = Math.PI / 180;

describe("constrain — constrainAngle (properties)", () => {
  it("preserves the distance from the origin", () => {
    fc.assert(
      fc.property(armed, anyStep, ([o, p], step) => {
        assertClose(
          dist(o, constrainAngle(o, p, step)),
          dist(o, p),
          1e-9 * magnitude(o, p),
          "distance",
        );
      }),
    );
  });

  it("lands ON a multiple of the step", () => {
    // Stated without atan2 (the function's own tool): for SOME integer k
    // the answer is origin + r·(cos k·step, sin k·step).
    fc.assert(
      fc.property(armed, anyStep, ([o, p], step) => {
        const out = constrainAngle(o, p, step);
        const r = dist(o, p);
        const reach = Math.ceil(180 / step) + 1;
        let best = Infinity;
        for (let k = -reach; k <= reach; k++) {
          const a = k * step * DEG;
          best = Math.min(
            best,
            Math.hypot(out[0] - (o[0] + r * Math.cos(a)), out[1] - (o[1] + r * Math.sin(a))),
          );
        }
        assertClose(best, 0, 1e-9 * magnitude(o, p), "distance to the nearest multiple");
      }),
    );
  });

  it("for a step dividing 180°, the snapped direction is a whole number of steps", () => {
    fc.assert(
      fc.property(armed, niceStep, ([o, p], step) => {
        const out = constrainAngle(o, p, step);
        const steps = Math.atan2(out[1] - o[1], out[0] - o[0]) / (step * DEG);
        // Relative to the arm's length: the angle of a point r away is
        // only as good as the point's coordinates.
        const tol = (1e-9 * magnitude(o, p)) / dist(o, p) / (step * DEG) + 1e-9;
        assertClose(steps, Math.round(steps), tol, "steps");
      }),
    );
  });

  it("picks the NEAREST multiple: it never turns the arm by more than half a step", () => {
    fc.assert(
      fc.property(armed, anyStep, ([o, p], step) => {
        const out = constrainAngle(o, p, step);
        const ux = p[0] - o[0];
        const uy = p[1] - o[1];
        const vx = out[0] - o[0];
        const vy = out[1] - o[1];
        const turned = Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
        const tol = (1e-9 * magnitude(o, p)) / dist(o, p) + 1e-9;
        assertTrue(
          turned <= (step * DEG) / 2 + tol,
          `turned ${turned / DEG}° for a step of ${step}°`,
        );
      }),
    );
  });

  it("is idempotent (for a step that divides 180°)", () => {
    fc.assert(
      fc.property(armed, niceStep, ([o, p], step) => {
        const once = constrainAngle(o, p, step);
        assertVecClose(constrainAngle(o, once, step), once, 1e-9 * magnitude(o, p));
      }),
    );
  });

  it("leaves a point already on a multiple where it is", () => {
    fc.assert(
      fc.property(
        smallVec2,
        fc.integer({ min: -8, max: 8 }),
        real(0.5, 500),
        niceStep,
        (o, k, r, step) => {
          const a = k * step * DEG;
          const p: Vec2 = [o[0] + r * Math.cos(a), o[1] + r * Math.sin(a)];
          assertVecClose(constrainAngle(o, p, step), p, 1e-9 * magnitude(o, p));
        },
      ),
    );
  });

  it("commutes with moving origin and point together", () => {
    fc.assert(
      fc.property(armed, smallVec2, niceStep, ([o, p], d, step) => {
        const base = constrainAngle(o, p, step);
        const moved = constrainAngle(
          [o[0] + d[0], o[1] + d[1]],
          [p[0] + d[0], p[1] + d[1]],
          step,
        );
        // A tie (the arm exactly half a step from two multiples) may break
        // either way once the move perturbs the last bit; skip those.
        const steps = Math.atan2(p[1] - o[1], p[0] - o[0]) / (step * DEG);
        fc.pre(Math.abs(Math.abs(steps - Math.round(steps)) - 0.5) > 1e-6);
        assertVecClose(
          moved,
          [base[0] + d[0], base[1] + d[1]],
          1e-9 * magnitude(o, p, d),
        );
      }),
    );
  });

  it("defaults to 45°", () => {
    fc.assert(
      fc.property(armed, ([o, p]) => {
        assertVecClose(constrainAngle(o, p), constrainAngle(o, p, 45), 0);
      }),
    );
  });

  it("answers the point itself, as a fresh tuple, when it is on the origin", () => {
    fc.assert(
      fc.property(vec2, anyStep, (o, step) => {
        const point: Vec2 = [o[0], o[1]];
        const out = constrainAngle(o, point, step);
        assertVecClose(out, o, 0);
        expect(out).not.toBe(point);
      }),
    );
  });

  // ------------------------------------------------------------------
  // DEFECT (constrain.ts, constrainAngle) — for a step that does NOT
  // divide 180° the snap was not idempotent, and was not the nearest
  // multiple either. FIXED — and the contract DECIDED, because for such
  // a step "the nearest multiple" had never been defined.
  //
  // `Math.round(atan2(dy, dx) / step) * step` only ever considers the
  // multiples k·step with |k·step| ≲ 180°, and it treated +180° and
  // −180° as different candidates although they are one direction. With
  // a step that divides 180° both ends of the range ARE multiples, so
  // nothing shows. With any other step the candidate nearest to the
  // ±180° cut lies BEYOND it, and re-reading that direction through
  // atan2 lands on the other side of the cut — where the nearest
  // candidate was a different one.
  //
  // Minimal counterexample: step 100°, a 10 pt arm at 175°.
  //   multiples within reach: −200, −100, 0, 100, 200.
  //   1st snap: round(1.75)·100 = 200°, i.e. the direction −160°.
  //   2nd snap of THAT: round(−1.6)·100 = −200°, i.e. the direction 160°.
  //   EXPECTED: snapping a snapped point leaves it where it is (and the
  //             first snap chooses 160° — it is 15° from the arm, 200°
  //             is 25°).
  //   WAS:      the point jumped 40° on every re-application.
  //
  // Low severity: both callers use the 45° default, and every step a UI
  // offers (15/30/45/60/90) divides 180°.
  //
  // THE CONTRACT (constrain.ts states it in full). The multiples of a
  // step that does not divide 360° never close up — 100° generates every
  // multiple of 20° — so the candidates have to be a chosen, finite set.
  // They are the multiples k·step with |k| ≤ round(180°/step): the fan
  // counted both ways from the +x axis out to the multiple nearest the
  // half turn — exactly the directions the function could always answer.
  // Among them the winner is the one nearest the arm ON THE CIRCLE. That
  // makes the snap idempotent for every step and keeps the turn within
  // half a step, and for a step that divides 360° the answer is
  // bit-for-bit what it was (checked on 3.2 million points).
  // ------------------------------------------------------------------
  it("FIXED DEFECT (minimal counterexample): snapping is idempotent at a 100° step", () => {
    const a = 175 * DEG;
    const p: Vec2 = [10 * Math.cos(a), 10 * Math.sin(a)];
    const once = constrainAngle([0, 0], p, 100);
    const twice = constrainAngle([0, 0], once, 100);
    expect(Math.hypot(twice[0] - once[0], twice[1] - once[1])).toBeLessThan(1e-9);
    // And it is the 160° direction (−200°), 15° from the arm — not the
    // 200° one, 25° away.
    assertVecClose(once, [10 * Math.cos(160 * DEG), 10 * Math.sin(160 * DEG)], 1e-9);
  });

  it("FIXED DEFECT: is idempotent for ANY positive step", () => {
    fc.assert(
      fc.property(armed, real(0.5, 180), ([o, p], step) => {
        const once = constrainAngle(o, p, step);
        assertVecClose(constrainAngle(o, once, step), once, 1e-9 * magnitude(o, p));
      }),
    );
  });

  it("THE CONTRACT: the answer is the nearest, on the circle, of the multiples out to the one nearest the half turn", () => {
    // Stated without atan2 and without rounding an angle: every
    // candidate direction is laid out as a POINT at the arm's length,
    // and the answer must be the candidate point nearest the arm's own
    // end. (Chord length is monotone in the angle between two directions
    // of the same length, so nearest point = nearest direction.)
    fc.assert(
      fc.property(armed, anyStep, ([o, p], step) => {
        const r = dist(o, p);
        const reach = Math.round(180 / step);
        let best = Infinity;
        let second = Infinity;
        let at: Vec2 = p;
        for (let k = -reach; k <= reach; k++) {
          const a = k * step * DEG;
          const c: Vec2 = [o[0] + r * Math.cos(a), o[1] + r * Math.sin(a)];
          const d = dist(c, p);
          if (d < best) {
            // A candidate that is the same DIRECTION as the best so far
            // (+180° and −180°) is not a second candidate.
            if (dist(c, at) > 1e-9 * r) second = best;
            best = d;
            at = c;
          } else if (dist(c, at) > 1e-9 * r) {
            second = Math.min(second, d);
          }
        }
        // A near tie may break either way; skip it.
        fc.pre(second - best > 1e-6 * r);
        assertVecClose(constrainAngle(o, p, step), at, 1e-9 * magnitude(o, p));
      }),
    );
  });

  it("the sign of the step is ignored", () => {
    fc.assert(
      fc.property(armed, anyStep, ([o, p], step) => {
        // A tie (the arm exactly between two multiples) rounds toward +∞
        // of k either way and may land differently; skip those.
        const steps = Math.atan2(p[1] - o[1], p[0] - o[0]) / (step * DEG);
        fc.pre(Math.abs(Math.abs(steps - Math.round(steps)) - 0.5) > 1e-6);
        assertVecClose(
          constrainAngle(o, p, -step),
          constrainAngle(o, p, step),
          1e-9 * magnitude(o, p),
        );
      }),
    );
  });

  // ------------------------------------------------------------------
  // DEFECT (constrain.ts, constrainAngle) — a step of 0° answered
  // [NaN, NaN]. FIXED.
  //
  // `step = 0` makes `atan2(...) / step` ±Infinity (or NaN on the +x
  // axis), `Math.round(±Infinity) * 0` is NaN, and the NaN went straight
  // into the returned coordinates. Every other function in this package
  // answers a degenerate argument with something inert ("never a throw",
  // `[]`, the point unchanged); this one answered a poisoned point that
  // a caller would hand to an `insertPath` / `framePath` op.
  //
  // Minimal counterexample: constrainAngle([0,0], [3,4], 0)
  //   EXPECTED: a finite point (no constraint is the only reading of
  //             "snap to multiples of 0°": [3, 4]).
  //   WAS:      [NaN, NaN].
  //
  // Low severity: both callers (pen-machine, measure-machine) use the
  // 45° default. It is the first thing a "constrain angle" preference
  // field would hit.
  //
  // THE FIX: a step with no multiples to snap to — 0, NaN, ±∞ — is no
  // constraint: the point comes back unchanged, as a fresh tuple.
  // ------------------------------------------------------------------
  it("FIXED DEFECT (minimal counterexample): a 0° step answers a finite point", () => {
    const out = constrainAngle([0, 0], [3, 4], 0);
    expect(Number.isFinite(out[0]) && Number.isFinite(out[1])).toBe(true);
    expect(out).toEqual([3, 4]);
  });

  it("FIXED DEFECT: property — a step that is 0, NaN or infinite is no constraint", () => {
    fc.assert(
      fc.property(
        vec2,
        vec2,
        fc.constantFrom(0, -0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        (o, point, step) => {
          const out = constrainAngle(o, point, step);
          assertVecClose(out, point, 0);
          expect(out).not.toBe(point);
        },
      ),
    );
  });
});
