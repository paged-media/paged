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

// Property tests for svg-arc.ts — the SVG `A` command lowered to cubics.
//
// THE REFERENCE RUNS THE OTHER WAY. `arcToCubics` implements the SVG
// ENDPOINT → CENTRE conversion (implementation notes §F.6.5). The
// properties start from the CENTRE form — a centre, two radii, a
// rotation, a start angle and a signed sweep — derive the endpoint
// arguments from it (§F.6.4, the easy direction: evaluate the ellipse
// twice and read the two flags off the sweep), and then check that the
// cubics the kernel answers lie on THAT ellipse, go the right way round
// it, and stop where the arc stops. A wrong flag, a wrong sign or a wrong
// centre all show up as "the midpoint of slice i is not where the ellipse
// is at that angle".

import { describe, expect, it } from "vitest";

import { arcToCubics, type ArcCubic, type Vec2 } from "../src";
import {
  angleDeg,
  assertClose,
  assertTrue,
  assertVecClose,
  fc,
  real,
  refEvalCubic,
  smallVec2,
  vec2,
} from "./property-kit";

interface CentreArc {
  center: Vec2;
  rx: number;
  ry: number;
  phiDeg: number;
  theta1: number;
  dTheta: number;
}

const radius = real(1, 200);

/** A centre-form arc whose sweep is clear of the three ambiguous places:
 *  0 (no arc), ±π (the large-arc flag flips), ±2π (start = end), and of
 *  the multiples of π/2 where the slice count changes. */
const centreArc: fc.Arbitrary<CentreArc> = fc
  .record({
    center: smallVec2 as fc.Arbitrary<Vec2>,
    rx: radius,
    ry: radius,
    phiDeg: angleDeg,
    theta1: real(-Math.PI, Math.PI),
    dTheta: fc
      .tuple(real(0.05, 2 * Math.PI - 0.05), fc.boolean())
      .map(([m, neg]) => (neg ? -m : m)),
  })
  .filter(({ dTheta }) => {
    const quarters = Math.abs(dTheta) / (Math.PI / 2);
    return Math.abs(quarters - Math.round(quarters)) > 0.02;
  });

/** The point of the ellipse at parameter angle `theta`. */
function onEllipse(arc: CentreArc, theta: number): Vec2 {
  const phi = (arc.phiDeg * Math.PI) / 180;
  const ex = arc.rx * Math.cos(theta);
  const ey = arc.ry * Math.sin(theta);
  return [
    arc.center[0] + Math.cos(phi) * ex - Math.sin(phi) * ey,
    arc.center[1] + Math.sin(phi) * ex + Math.cos(phi) * ey,
  ];
}

/** `√((x'/rx)² + (y'/ry)²)` in the ellipse's own frame — 1 on the
 *  ellipse, the implicit equation. */
function radialRatio(arc: CentreArc, p: Vec2): number {
  const phi = (arc.phiDeg * Math.PI) / 180;
  const dx = p[0] - arc.center[0];
  const dy = p[1] - arc.center[1];
  const x = Math.cos(phi) * dx + Math.sin(phi) * dy;
  const y = -Math.sin(phi) * dx + Math.cos(phi) * dy;
  return Math.hypot(x / arc.rx, y / arc.ry);
}

function lower(arc: CentreArc): { start: Vec2; end: Vec2; cubics: ArcCubic[] } {
  const start = onEllipse(arc, arc.theta1);
  const end = onEllipse(arc, arc.theta1 + arc.dTheta);
  const cubics = arcToCubics(
    start,
    arc.rx,
    arc.ry,
    arc.phiDeg,
    Math.abs(arc.dTheta) > Math.PI,
    arc.dTheta > 0,
    end,
  );
  return { start, end, cubics };
}

const scaleOf = (arc: CentreArc): number =>
  Math.max(arc.rx, arc.ry, Math.abs(arc.center[0]), Math.abs(arc.center[1]));

/** The Bézier quarter-arc approximation is good to 2.7e-4 of the radius
 *  at a 90° slice (less for a narrower one). */
const KAPPA_ERROR = 3e-4;

describe("svg-arc — arcToCubics against the centre form (properties)", () => {
  it("ends on the arc's END point (to √ε of its size)", () => {
    // 1e-7, not 1e-9: see the defect block at the end of this file. With
    // a start within ~1e-8 rad of the ellipse's major axis the start
    // angle comes out of `acos` with half its digits, and the end point
    // inherits the error.
    fc.assert(
      fc.property(centreArc, (arc) => {
        const { end, cubics } = lower(arc);
        assertTrue(cubics.length > 0, "no cubics for a real arc");
        assertVecClose(
          cubics[cubics.length - 1].end,
          end,
          1e-7 * scaleOf(arc),
          "last slice end",
        );
      }),
    );
  });

  it("slices the sweep into the fewest pieces of at most a quarter turn", () => {
    fc.assert(
      fc.property(centreArc, (arc) => {
        const { cubics } = lower(arc);
        expect(cubics).toHaveLength(Math.ceil(Math.abs(arc.dTheta) / (Math.PI / 2)));
        assertTrue(cubics.length <= 4, "more than four slices");
      }),
    );
  });

  it("every slice boundary is ON the ellipse, at its own share of the sweep", () => {
    fc.assert(
      fc.property(centreArc, (arc) => {
        const { cubics } = lower(arc);
        const n = cubics.length;
        cubics.forEach((slice, i) => {
          assertVecClose(
            slice.end,
            onEllipse(arc, arc.theta1 + ((i + 1) * arc.dTheta) / n),
            1e-7 * scaleOf(arc),
            `slice ${i} end`,
          );
        });
      }),
    );
  });

  it("every slice FOLLOWS the ellipse — right centre, right flags, right direction", () => {
    // Sampled inside each cubic. Every sample must satisfy the ellipse's
    // implicit equation, and the slice's MIDPOINT (t = 0.5, where the
    // cubic's symmetry makes its parameter and the angle agree) must be
    // the ellipse's point at the middle of that slice's share of the
    // sweep. A flipped sweep flag traces the mirror arc and a flipped
    // large-arc flag the complementary one; either puts the midpoints
    // nowhere near.
    fc.assert(
      fc.property(centreArc, (arc) => {
        const { start, cubics } = lower(arc);
        const n = cubics.length;
        let from = start;
        cubics.forEach((slice, i) => {
          const c: [[number, number], [number, number], [number, number], [number, number]] = [
            [from[0], from[1]],
            [slice.c1[0], slice.c1[1]],
            [slice.c2[0], slice.c2[1]],
            [slice.end[0], slice.end[1]],
          ];
          for (const t of [0.125, 0.25, 0.5, 0.75, 0.875]) {
            assertClose(
              radialRatio(arc, refEvalCubic(c, t)),
              1,
              KAPPA_ERROR,
              `slice ${i} radial ratio at t=${t}`,
            );
          }
          assertVecClose(
            refEvalCubic(c, 0.5),
            onEllipse(arc, arc.theta1 + ((i + 0.5) * arc.dTheta) / n),
            KAPPA_ERROR * Math.max(arc.rx, arc.ry),
            `slice ${i} midpoint`,
          );
          from = slice.end;
        });
      }),
    );
  });

  it("joins its slices smoothly: the handles either side of a boundary mirror each other", () => {
    fc.assert(
      fc.property(centreArc, (arc) => {
        const { cubics } = lower(arc);
        for (let i = 0; i + 1 < cubics.length; i++) {
          const joint = cubics[i].end;
          const incoming = cubics[i].c2;
          const outgoing = cubics[i + 1].c1;
          assertVecClose(
            outgoing,
            [2 * joint[0] - incoming[0], 2 * joint[1] - incoming[1]],
            1e-9 * scaleOf(arc),
            `joint ${i}`,
          );
        }
      }),
    );
  });

  it("the reverse arc (ends swapped, sweep flipped) has the same slice boundaries, backwards", () => {
    fc.assert(
      fc.property(centreArc, (arc) => {
        const { start, end, cubics } = lower(arc);
        const large = Math.abs(arc.dTheta) > Math.PI;
        const back = arcToCubics(end, arc.rx, arc.ry, arc.phiDeg, large, !(arc.dTheta > 0), start);
        expect(back).toHaveLength(cubics.length);
        const forward = [start, ...cubics.map((c) => c.end)];
        const backward = [end, ...back.map((c) => c.end)].reverse();
        forward.forEach((p, i) => {
          assertVecClose(backward[i], p, 1e-7 * scaleOf(arc), `boundary ${i}`);
        });
      }),
    );
  });

  it("ignores the sign of a radius and a whole turn of rotation", () => {
    fc.assert(
      fc.property(centreArc, (arc) => {
        const { start, end, cubics } = lower(arc);
        const large = Math.abs(arc.dTheta) > Math.PI;
        const sweep = arc.dTheta > 0;
        const negated = arcToCubics(start, -arc.rx, -arc.ry, arc.phiDeg, large, sweep, end);
        expect(negated).toEqual(cubics);
        const turned = arcToCubics(start, arc.rx, arc.ry, arc.phiDeg + 360, large, sweep, end);
        expect(turned).toHaveLength(cubics.length);
        turned.forEach((slice, i) => {
          assertVecClose(slice.end, cubics[i].end, 1e-7 * scaleOf(arc));
          assertVecClose(slice.c1, cubics[i].c1, 1e-7 * scaleOf(arc));
          assertVecClose(slice.c2, cubics[i].c2, 1e-7 * scaleOf(arc));
        });
      }),
    );
  });
});

describe("svg-arc — arcToCubics from raw endpoint arguments (properties)", () => {
  const flag = fc.boolean();
  const rawRadius = fc.oneof(
    fc.constantFrom(1, 5, 10, 25),
    real(0.01, 500),
  );

  /** The larger radius AFTER the spec's out-of-range correction (§F.6.6:
   *  radii too small for the chord are scaled by √λ). */
  const effectiveRadius = (start: Vec2, end: Vec2, rx: number, ry: number, phiDeg: number): number => {
    const phi = (phiDeg * Math.PI) / 180;
    const dx = (start[0] - end[0]) / 2;
    const dy = (start[1] - end[1]) / 2;
    const x = Math.cos(phi) * dx + Math.sin(phi) * dy;
    const y = -Math.sin(phi) * dx + Math.cos(phi) * dy;
    const lambda = (x / rx) ** 2 + (y / ry) ** 2;
    return Math.max(rx, ry) * Math.max(1, Math.sqrt(lambda));
  };

  it("answers finite cubics that end on the END point to √ε of the radius, whatever the radii", () => {
    // Includes radii too small to span the chord (the spec scales them up
    // until the arc is a half ellipse) and every flag combination.
    //
    // THE TOLERANCE IS √ε·R, NOT ε·R, and that is the measured truth of
    // the implementation rather than a courtesy: the sweep comes out of
    // an `acos`, which keeps only half its digits near 0 and π, and a
    // scaled-up arc is ALWAYS a half turn. See the defect block below.
    fc.assert(
      fc.property(vec2, vec2, rawRadius, rawRadius, angleDeg, flag, flag, (start, end, rx, ry, phi, large, sweep) => {
        const chord = Math.hypot(end[0] - start[0], end[1] - start[1]);
        fc.pre(chord > 1e-6);
        const cubics = arcToCubics(start, rx, ry, phi, large, sweep, end);
        assertTrue(cubics.length >= 1 && cubics.length <= 4, `${cubics.length} slices`);
        for (const slice of cubics) {
          for (const p of [slice.c1, slice.c2, slice.end]) {
            assertTrue(Number.isFinite(p[0]) && Number.isFinite(p[1]), "non-finite output");
          }
        }
        const size = Math.max(Math.abs(start[0]), Math.abs(start[1]), Math.abs(end[0]), Math.abs(end[1]), 1);
        assertVecClose(
          cubics[cubics.length - 1].end,
          end,
          1e-7 * effectiveRadius(start, end, rx, ry, phi) + 1e-9 * size,
          "last slice end",
        );
      }),
    );
  });

  it("radii too small for the chord are scaled up to a HALF circle on the chord", () => {
    fc.assert(
      fc.property(smallVec2, smallVec2, real(0.05, 0.4), flag, flag, (start, end, shrink, large, sweep) => {
        const chord = Math.hypot(end[0] - start[0], end[1] - start[1]);
        fc.pre(chord > 0);
        // A circle whose DIAMETER is `shrink` of the chord cannot reach.
        const r = (shrink * chord) / 2;
        const cubics = arcToCubics(start, r, r, 0, large, sweep, end);
        // Two quarter slices — or three, when the half turn comes back
        // from `acos` a hair over π.
        assertTrue(cubics.length === 2 || cubics.length === 3, `${cubics.length} slices`);
        // Scaled to radius chord/2 about the chord's midpoint: every
        // slice boundary is on that circle.
        const mid: Vec2 = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
        for (const slice of cubics) {
          assertClose(
            Math.hypot(slice.end[0] - mid[0], slice.end[1] - mid[1]),
            chord / 2,
            1e-6 * chord,
            "radius after scaling",
          );
        }
      }),
    );
  });

  it("a zero radius is one straight cubic; coincident end points are no arc at all", () => {
    fc.assert(
      fc.property(vec2, vec2, rawRadius, angleDeg, flag, flag, (start, end, r, phi, large, sweep) => {
        fc.pre(start[0] !== end[0] || start[1] !== end[1]);
        for (const [rx, ry] of [
          [0, r],
          [r, 0],
          [0, 0],
        ]) {
          expect(arcToCubics(start, rx, ry, phi, large, sweep, end)).toEqual([
            { c1: start, c2: end, end },
          ]);
        }
        expect(arcToCubics(start, r, r, phi, large, sweep, start)).toEqual([]);
      }),
    );
  });

  // ------------------------------------------------------------------
  // DEFECT (svg-arc.ts, arcToCubics) — the arc does not end EXACTLY on
  // the end point it was given.
  //
  // The SVG `A` command draws "to (x, y)". The last slice's `end` is
  // instead recomputed from the derived centre and angles
  // (`point(theta1 + dTheta)`), and both angles come out of `acos`, which
  // keeps only HALF its digits near 0 and π. So the recomputed end is
  //   · an ulp or two off in the ordinary case, and
  //   · up to ~1.5e-8 × the larger radius off for a start on the major
  //     axis or a half-turn sweep — which is every arc whose radii the
  //     spec scales up (measured: start (0,−8), end (−2,0), rx 0.0157,
  //     ry 1 misses the end by 1.3e-6).
  // Invisible on a page. It matters because svg-path.ts
  //   · advances the pen to the drifted point (`cx = a[0]`), so every
  //     following RELATIVE command inherits the error, and
  //   · decides whether `Z` returns to the subpath start with an exact
  //     `===` on the coordinates.
  // So the standard two-arc circle, `M 0 5 a 5 5 0 1 0 10 0 a 5 5 0 1 0
  // -10 0 Z`, parses to FIVE anchors — the fifth 1e-15 from the first —
  // instead of four, and its start anchor is a corner (see svg-path's
  // defect block for that end of it).
  //
  // Minimal counterexample: the second arc of that circle,
  //   arcToCubics([10, 5], 5, 5, 0, true, false, [0, 5])
  //   EXPECTED last slice end: [0, 5]
  //   ACTUAL:                  [0, 4.999999999999999]
  //
  // The fix is to emit `end` itself as the last slice's end point.
  // ------------------------------------------------------------------
  it.fails("DEFECT (minimal counterexample): the arc ends exactly on its end point", () => {
    const cubics = arcToCubics([10, 5], 5, 5, 0, true, false, [0, 5]);
    expect(cubics[cubics.length - 1].end).toEqual([0, 5]);
  });

  it.fails("DEFECT (√ε counterexample): a unit arc starting a hair off the −x axis ends within 1e-9 of its end point", () => {
    // Found by the centre-form property once it was stated to 1e-9 (seed
    // 20261002): start angle −π + 5.9e-9, a 0.05 rad sweep on the unit
    // circle. The end point comes back 5.85e-9 away — seven orders above
    // an ulp.
    const theta1 = -3.1415926477381206;
    const start: Vec2 = [Math.cos(theta1), Math.sin(theta1)];
    const end: Vec2 = [Math.cos(theta1 + 0.05), Math.sin(theta1 + 0.05)];
    const cubics = arcToCubics(start, 1, 1, 0, false, true, end);
    assertVecClose(cubics[cubics.length - 1].end, end, 1e-9, "last slice end");
  });

  it.fails("DEFECT: property — the last slice ends EXACTLY on the end point", () => {
    fc.assert(
      fc.property(smallVec2, smallVec2, fc.constantFrom(1, 5, 10, 25), flag, flag, (start, end, r, large, sweep) => {
        fc.pre(start[0] !== end[0] || start[1] !== end[1]);
        const cubics = arcToCubics(start, r, r, 0, large, sweep, end);
        assertVecClose(cubics[cubics.length - 1].end, end, 0, "last slice end");
      }),
    );
  });
});
