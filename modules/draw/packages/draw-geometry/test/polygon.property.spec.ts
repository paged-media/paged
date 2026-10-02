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

// Property tests for polygon.ts — the lasso's region test and the
// face-under-cursor test of Shape Builder / Live Paint.
//
// WHICH FILL RULE. `pointInPolygon` and `pointInAnchorPath` implement
// EVEN-ODD (a ray cast, parity of crossings). The ENGINE FILLS NON-ZERO.
// The two rules describe the same region for a SIMPLE polygon and for a
// properly nested set of contours, which is what the first property
// proves against a non-zero reference. They DIFFER on a self-intersecting
// contour — the pentagram test pins that difference so nobody reads these
// functions as "what the engine paints".

import { describe, expect, it } from "vitest";

import {
  ellipseToPath,
  flattenAnchorRun,
  pointInAnchorPath,
  pointInPolygon,
  type AnchorTriple,
  type Vec2,
} from "../src";
import {
  assertTrue,
  cornerOf,
  fc,
  polyline,
  real,
  refEvenOddVertical,
  refRingDistance,
  refWindingNumber,
  smallAnchorTriple,
  smallVec2,
  starPolygon,
  vec2,
} from "./property-kit";

/** A probe offset in units of the polygon's reach: covers the inside,
 *  the notches between the star's points, and the outside. */
const probeOffset = fc.tuple(
  real(-1.3, 1.3),
  real(-1.3, 1.3),
);

/** A probe that is never on an integer lattice line, so it is never on a
 *  vertex of an integer ring (it can still be on an edge — `fc.pre`
 *  handles that). */
const offLatticeProbe = fc
  .tuple(fc.integer({ min: -60, max: 60 }), fc.integer({ min: -60, max: 60 }))
  .map(([x, y]): Vec2 => [x / 4 + 0.13, y / 4 + 0.29]);

/** A ring of 3..9 integer vertices: usually self-intersecting. */
const anyRing = polyline(3, 9, smallVec2);

const cornerRun = (ring: readonly Vec2[]): AnchorTriple[] => ring.map(cornerOf);

describe("polygon — pointInPolygon (properties)", () => {
  it("on a SIMPLE polygon, agrees with the NON-ZERO winding rule (the engine's fill)", () => {
    fc.assert(
      fc.property(starPolygon, probeOffset, ({ center, ring, reach }, off) => {
        const p: Vec2 = [center[0] + off[0] * reach, center[1] + off[1] * reach];
        fc.pre(refRingDistance(p, ring) > 1e-6 * reach);
        const winding = refWindingNumber(p, ring);
        assertTrue(
          Math.abs(winding) <= 1,
          `a simple polygon winds 0 or ±1, got ${winding}`,
        );
        expect(pointInPolygon(p, ring)).toBe(winding !== 0);
      }),
    );
  });

  it("the star's centre is inside and anything beyond its reach is outside", () => {
    fc.assert(
      fc.property(starPolygon, vec2, ({ center, ring, reach }, far) => {
        expect(pointInPolygon(center, ring)).toBe(true);
        const d = Math.hypot(far[0] - center[0], far[1] - center[1]);
        fc.pre(d > reach * 1.001);
        expect(pointInPolygon(far, ring)).toBe(false);
      }),
    );
  });

  it("on ANY ring, agrees with an independent even-odd reference (a vertical ray)", () => {
    fc.assert(
      fc.property(anyRing, offLatticeProbe, (ring, p) => {
        fc.pre(refRingDistance(p, ring) > 1e-9);
        expect(pointInPolygon(p, ring)).toBe(refEvenOddVertical(p, ring));
      }),
    );
  });

  it("does not depend on the ring's start vertex or its direction", () => {
    fc.assert(
      fc.property(anyRing, offLatticeProbe, fc.nat(8), (ring, p, shift) => {
        fc.pre(refRingDistance(p, ring) > 1e-9);
        const k = shift % ring.length;
        const rotated = [...ring.slice(k), ...ring.slice(0, k)];
        const expected = pointInPolygon(p, ring);
        expect(pointInPolygon(p, rotated)).toBe(expected);
        expect(pointInPolygon(p, [...ring].reverse())).toBe(expected);
      }),
    );
  });

  it("fewer than 3 vertices never contain anything", () => {
    fc.assert(
      fc.property(polyline(0, 2), vec2, (ring, p) => {
        expect(pointInPolygon(p, ring)).toBe(false);
      }),
    );
  });

  it("is EVEN-ODD, not non-zero: a pentagram's core is OUTSIDE (the engine would paint it)", () => {
    // The five points of a regular star, joined every second vertex. The
    // central pentagon is wound TWICE: non-zero says inside, even-odd
    // says outside. This is the documented behaviour of the module, and
    // the reason it must not be used to predict the engine's fill on a
    // self-intersecting contour.
    const star: Vec2[] = [0, 2, 4, 1, 3].map((k) => {
      const a = -Math.PI / 2 + (2 * Math.PI * k) / 5;
      return [10 * Math.cos(a), 10 * Math.sin(a)];
    });
    const core: Vec2 = [0, 0];
    const tip: Vec2 = [0, -8];
    expect(Math.abs(refWindingNumber(core, star))).toBe(2);
    expect(pointInPolygon(core, star)).toBe(false); // even-odd
    expect(refWindingNumber(core, star) !== 0).toBe(true); // non-zero
    // The star's points are wound once: both rules agree there.
    expect(Math.abs(refWindingNumber(tip, star))).toBe(1);
    expect(pointInPolygon(tip, star)).toBe(true);
  });
});

describe("polygon — pointInAnchorPath (properties)", () => {
  it("over corner anchors, is pointInPolygon over the same ring", () => {
    fc.assert(
      fc.property(anyRing, offLatticeProbe, (ring, p) => {
        const expected = pointInPolygon(p, ring);
        expect(pointInAnchorPath(p, cornerRun(ring))).toBe(expected);
        // An empty `subpathStarts` is the single-contour case.
        expect(pointInAnchorPath(p, cornerRun(ring), [])).toBe(expected);
        expect(pointInAnchorPath(p, cornerRun(ring), [0])).toBe(expected);
      }),
    );
  });

  it("over several contours, is the XOR of the contours (a hole answers false)", () => {
    fc.assert(
      fc.property(
        fc.array(anyRing, { minLength: 1, maxLength: 4 }),
        offLatticeProbe,
        (rings, p) => {
          const anchors: AnchorTriple[] = [];
          const starts: number[] = [];
          let expected = false;
          for (const ring of rings) {
            starts.push(anchors.length);
            anchors.push(...cornerRun(ring));
            if (pointInPolygon(p, ring)) expected = !expected;
          }
          expect(pointInAnchorPath(p, anchors, starts)).toBe(expected);
        },
      ),
    );
  });

  it("over a CURVED contour of 3+ anchors, is even-odd over its flattening", () => {
    fc.assert(
      fc.property(
        fc.array(smallAnchorTriple, { minLength: 3, maxLength: 6 }),
        offLatticeProbe,
        fc.constantFrom(undefined, 4, 12, 24),
        (anchors, p, samplesPerSegment) => {
          const ring = flattenAnchorRun(anchors, {
            close: true,
            samplesPerSegment,
          });
          fc.pre(refRingDistance(p, ring) > 1e-7);
          expect(
            pointInAnchorPath(p, anchors, [], { samplesPerSegment }),
          ).toBe(refEvenOddVertical(p, ring));
        },
      ),
    );
  });

  it("an ellipse contains exactly the points of its analytic interior (to 1 %)", () => {
    // Independent of every flattening: the implicit equation. The 1 %
    // band covers the κ approximation (0.03 %) and the 12-chord-per-
    // quadrant sagitta (0.2 %).
    fc.assert(
      fc.property(
        smallVec2,
        real(1, 200),
        real(1, 200),
        real(0, 1.6),
        real(0, 2 * Math.PI),
        (center, rx, ry, radial, theta) => {
          fc.pre(Math.abs(radial - 1) > 0.01);
          const p: Vec2 = [
            center[0] + radial * rx * Math.cos(theta),
            center[1] + radial * ry * Math.sin(theta),
          ];
          const table = ellipseToPath(center[0], center[1], rx, ry);
          expect(pointInAnchorPath(p, table.anchors, table.subpathStarts)).toBe(
            radial < 1,
          );
        },
      ),
    );
  });

  // ------------------------------------------------------------------
  // DEFECT (polygon.ts, pointInAnchorPath) — a closed contour of ONE or
  // TWO anchors can never contain a point.
  //
  // `if (anchors.length < 3) return false;` (and, per contour,
  // `if (to - from < 3) continue;`) is `pointInPolygon`'s "fewer than 3
  // VERTICES" guard carried over to ANCHORS. A polygon with two vertices
  // has no area; a CUBIC contour with two anchors is a lens, and with one
  // anchor a teardrop — both ordinary closed shapes. `contourSignedArea`
  // in compound.ts knows this (it measures from 2 anchors up).
  //
  // Minimal counterexample: the lens
  //   a0 = (0,0)  left (3,−5)  right (3,5)
  //   a1 = (10,0) left (7,5)   right (7,−5)
  // encloses |area| 50.6 (`contourSignedArea`), its flattened ring
  // contains (5,0) under `pointInPolygon`.
  //   EXPECTED: pointInAnchorPath((5,0), lens) === true
  //   ACTUAL:   false (for every point).
  //
  // Consumers: Shape Builder and Live Paint resolve the face under the
  // cursor with this function, and the lens between two overlapping
  // circles is the first face anyone tries — when the planar arrangement
  // returns it with just its two crossing anchors it cannot be hit.
  // `contourDepths` inherits the same guard (`if (jt - jf < 3) continue`),
  // so a contour nested inside a lens-shaped outer is reported at depth 0
  // and "make compound path" does not cut the hole.
  // ------------------------------------------------------------------
  const LENS: AnchorTriple[] = [
    { anchor: [0, 0], left: [3, -5], right: [3, 5] },
    { anchor: [10, 0], left: [7, 5], right: [7, -5] },
  ];

  it.fails("DEFECT (minimal counterexample): a two-anchor lens contains its own middle", () => {
    const ring = flattenAnchorRun(LENS, { close: true });
    expect(pointInPolygon([5, 0], ring)).toBe(true); // the flattening does
    expect(pointInAnchorPath([5, 0], LENS)).toBe(true);
  });

  it.fails("DEFECT: over a curved contour of 1–2 anchors, is even-odd over its flattening", () => {
    fc.assert(
      fc.property(
        fc.array(smallAnchorTriple, { minLength: 1, maxLength: 2 }),
        offLatticeProbe,
        (anchors, p) => {
          const ring = flattenAnchorRun(anchors, { close: true });
          fc.pre(refRingDistance(p, ring) > 1e-7);
          expect(pointInAnchorPath(p, anchors)).toBe(refEvenOddVertical(p, ring));
        },
      ),
    );
  });
});
