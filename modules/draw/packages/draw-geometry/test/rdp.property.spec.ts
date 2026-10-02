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

// Property tests for rdp.ts — the Ramer-Douglas-Peucker simplifier under
// the Pencil (and its pressure lane, which rides the kept INDICES).

import { describe, expect, it } from "vitest";

import { segmentDistance, simplifyRdp, simplifyRdpIndices } from "../src";
import {
  assertClose,
  assertTrue,
  fc,
  magnitude,
  polyline,
  real,
  refSegmentDistance,
  smallVec2,
  vec2,
} from "./property-kit";

/** A tolerance in the range a Pencil actually passes (px→pt at zoom),
 *  plus 0 and values far larger than the stroke. */
const tolerance = fc.oneof(
  fc.constantFrom(0, 0.25, 0.5, 1, 2, 5),
  real(0, 50),
  real(0, 5000),
);

/** A stroke: either arbitrary page points or a dense integer scribble
 *  (which is full of collinear runs, repeats and exact ties). */
const stroke = fc.oneof(polyline(0, 40), polyline(0, 40, smallVec2));

describe("rdp — segmentDistance (properties)", () => {
  it("agrees with an independent three-region projection", () => {
    fc.assert(
      fc.property(vec2, vec2, vec2, (p, a, b) => {
        assertClose(
          segmentDistance(p, a, b),
          refSegmentDistance(p, a, b),
          1e-9 * magnitude(p, a, b),
        );
      }),
    );
  });

  it("is zero at both end points and never exceeds the distance to either", () => {
    fc.assert(
      fc.property(vec2, vec2, vec2, (p, a, b) => {
        const slack = 1e-9 * magnitude(p, a, b);
        assertClose(segmentDistance(a, a, b), 0, slack, "at a");
        assertClose(segmentDistance(b, a, b), 0, slack, "at b");
        const d = segmentDistance(p, a, b);
        assertTrue(d >= 0, `negative distance ${d}`);
        assertTrue(
          d <= Math.hypot(p[0] - a[0], p[1] - a[1]) + slack &&
            d <= Math.hypot(p[0] - b[0], p[1] - b[1]) + slack,
          `distance ${d} exceeds the distance to an end point`,
        );
      }),
    );
  });

  it("does not depend on the segment's direction", () => {
    fc.assert(
      fc.property(vec2, vec2, vec2, (p, a, b) => {
        assertClose(
          segmentDistance(p, a, b),
          segmentDistance(p, b, a),
          1e-9 * magnitude(p, a, b),
        );
      }),
    );
  });
});

describe("rdp — simplifyRdp / simplifyRdpIndices (properties)", () => {
  it("keeps both end points", () => {
    fc.assert(
      fc.property(stroke, tolerance, (points, tol) => {
        const idx = simplifyRdpIndices(points, tol);
        if (points.length === 0) {
          expect(idx).toEqual([]);
          return;
        }
        expect(idx[0]).toBe(0);
        expect(idx[idx.length - 1]).toBe(points.length - 1);
      }),
    );
  });

  it("answers strictly ascending, in-range indices (a subsequence of the input)", () => {
    fc.assert(
      fc.property(stroke, tolerance, (points, tol) => {
        const idx = simplifyRdpIndices(points, tol);
        for (let k = 0; k < idx.length; k++) {
          assertTrue(
            Number.isInteger(idx[k]) && idx[k] >= 0 && idx[k] < points.length,
            `index ${idx[k]} out of range`,
          );
          if (k > 0) assertTrue(idx[k] > idx[k - 1], "indices not ascending");
        }
      }),
    );
  });

  it("simplifyRdp is exactly the points at simplifyRdpIndices", () => {
    fc.assert(
      fc.property(stroke, tolerance, (points, tol) => {
        expect(simplifyRdp(points, tol)).toEqual(
          simplifyRdpIndices(points, tol).map((i) => [points[i][0], points[i][1]]),
        );
      }),
    );
  });

  it("no input point deviates from the simplified polyline by more than the tolerance", () => {
    // The sharp form: every DROPPED point is within `tol` of the ONE
    // output segment that replaced it (the kept neighbours either side),
    // not merely of the output somewhere.
    fc.assert(
      fc.property(stroke, tolerance, (points, tol) => {
        const idx = simplifyRdpIndices(points, tol);
        const slack = 1e-9 * magnitude(...points);
        for (let k = 0; k + 1 < idx.length; k++) {
          const a = points[idx[k]];
          const b = points[idx[k + 1]];
          for (let i = idx[k] + 1; i < idx[k + 1]; i++) {
            const d = refSegmentDistance(points[i], a, b);
            assertTrue(
              d <= tol + slack,
              `point ${i} is ${d} from its replacing segment ` +
                `[${idx[k]}→${idx[k + 1]}], tolerance ${tol}`,
            );
          }
        }
      }),
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(stroke, tolerance, (points, tol) => {
        const once = simplifyRdp(points, tol);
        expect(simplifyRdp(once, tol)).toEqual(once);
      }),
    );
  });

  it("a larger tolerance keeps a SUBSET of what a smaller one keeps", () => {
    fc.assert(
      fc.property(stroke, tolerance, tolerance, (points, t1, t2) => {
        const lo = Math.min(t1, t2);
        const hi = Math.max(t1, t2);
        const fine = new Set(simplifyRdpIndices(points, lo));
        for (const i of simplifyRdpIndices(points, hi)) {
          assertTrue(fine.has(i), `index ${i} kept at ${hi} but not at ${lo}`);
        }
      }),
    );
  });

  it("a tolerance beyond the stroke's extent leaves only the end points", () => {
    fc.assert(
      fc.property(polyline(2, 40), (points) => {
        const m = magnitude(...points);
        expect(simplifyRdpIndices(points, 4 * m)).toEqual([0, points.length - 1]);
      }),
    );
  });

  it("returns fresh points: mutating the output leaves the input alone", () => {
    fc.assert(
      fc.property(stroke, tolerance, (points, tol) => {
        const input = structuredClone(points);
        const before = JSON.stringify(input);
        for (const p of simplifyRdp(input, tol)) {
          p[0] = Number.NaN;
          p[1] = Number.NaN;
        }
        expect(JSON.stringify(input)).toBe(before);
      }),
    );
  });
});
