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

// Property tests for affine.ts — the itemTransform algebra. The module
// offers no matrix inverse; "invert" here is `inverseApplyAffine`, the
// point-wise inverse the anchor editors use to bring a page-space click
// into a path's local frame.

import { describe, expect, it } from "vitest";

import {
  IDENTITY_AFFINE,
  affineScale,
  applyAffine,
  composeAffine,
  inverseApplyAffine,
  type Affine,
} from "../src";
import {
  angleRad,
  assertClose,
  assertTrue,
  assertVecClose,
  coord,
  fc,
  real,
  vec2,
} from "./property-kit";

/** A magnitude in [0.2, 5] with a random sign — a scale that neither
 *  flattens nor explodes. */
const scaleFactor = fc
  .tuple(real(0.2, 5), fc.boolean())
  .map(([m, neg]) => (neg ? -m : m));

/**
 * A WELL-CONDITIONED affine: rotation · scale · shear + translation, the
 * shape an item transform actually has. Condition number is bounded
 * (≈ 25 · 6), so a round trip is good to ~1e-12 of the coordinates and
 * the 1e-7 tolerance below is generous without being vacuous.
 */
const invertible: fc.Arbitrary<Affine> = fc
  .tuple(
    angleRad,
    scaleFactor,
    scaleFactor,
    real(-2, 2),
    coord,
    coord,
  )
  .map(([theta, sx, sy, shear, tx, ty]) => {
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    // R(θ) · [[sx, shear·sy], [0, sy]] in the [a, b, c, d] column pairs.
    const a = cos * sx;
    const b = sin * sx;
    const c = cos * shear * sy - sin * sy;
    const d = sin * shear * sy + cos * sy;
    return [a, b, c, d, tx, ty] as Affine;
  });

/** Any six numbers at all — singular ones included. */
const anyAffine: fc.Arbitrary<Affine> = fc
  .tuple(coord, coord, coord, coord, coord, coord)
  .map((m) => m as Affine);

/** Six small integers: products are exact, so algebraic identities hold
 *  to the bit. */
const intAffine: fc.Arbitrary<Affine> = fc
  .array(fc.integer({ min: -9, max: 9 }), { minLength: 6, maxLength: 6 })
  .map((m) => m as unknown as Affine);

const det = (m: Affine): number => m[0] * m[3] - m[1] * m[2];

const size = (...ms: Affine[]): number =>
  Math.max(1, ...ms.flatMap((m) => m.map(Math.abs)));

/** Entry-wise `===` (so +0 and −0, the same number, compare equal —
 *  `toEqual` tells them apart and integer products make both). */
function assertAffineExact(actual: Affine, expected: Affine): void {
  for (let i = 0; i < 6; i++) {
    assertClose(actual[i], expected[i], 0, `entry ${i}`);
  }
}

describe("affine — applyAffine (properties)", () => {
  it("a null transform and IDENTITY_AFFINE both leave a point alone", () => {
    fc.assert(
      fc.property(vec2, ([x, y]) => {
        assertVecClose(applyAffine(null, x, y), [x, y], 0);
        assertVecClose(applyAffine(IDENTITY_AFFINE, x, y), [x, y], 0);
        assertVecClose(inverseApplyAffine(null, x, y)!, [x, y], 0);
        assertVecClose(inverseApplyAffine(IDENTITY_AFFINE, x, y)!, [x, y], 0);
      }),
    );
  });

  it("is the `[a, b, c, d, tx, ty]` COLUMN-PAIR convention", () => {
    // The origin goes to (tx, ty); the x unit vector to the FIRST pair
    // (a, b); the y unit vector to the SECOND pair (c, d). Getting this
    // transposed is the classic IDML ItemTransform mistake.
    fc.assert(
      fc.property(intAffine, (m) => {
        assertVecClose(applyAffine(m, 0, 0), [m[4], m[5]], 0, "origin");
        assertVecClose(applyAffine(m, 1, 0), [m[0] + m[4], m[1] + m[5]], 0, "x unit");
        assertVecClose(applyAffine(m, 0, 1), [m[2] + m[4], m[3] + m[5]], 0, "y unit");
      }),
    );
  });

  it("is affine: it maps midpoints to midpoints", () => {
    fc.assert(
      fc.property(anyAffine, vec2, vec2, (m, p, q) => {
        const mid = applyAffine(m, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
        const mp = applyAffine(m, p[0], p[1]);
        const mq = applyAffine(m, q[0], q[1]);
        assertVecClose(
          mid,
          [(mp[0] + mq[0]) / 2, (mp[1] + mq[1]) / 2],
          1e-9 * size(m) * Math.max(1, Math.abs(p[0]), Math.abs(p[1]), Math.abs(q[0]), Math.abs(q[1])),
        );
      }),
    );
  });
});

describe("affine — inverseApplyAffine (properties)", () => {
  it("undoes applyAffine", () => {
    fc.assert(
      fc.property(invertible, vec2, (m, [x, y]) => {
        const there = applyAffine(m, x, y);
        const back = inverseApplyAffine(m, there[0], there[1]);
        assertTrue(back !== null, "an invertible transform answered null");
        assertVecClose(back!, [x, y], 1e-7 * Math.max(1, Math.abs(x), Math.abs(y)));
      }),
    );
  });

  it("is undone by applyAffine", () => {
    fc.assert(
      fc.property(invertible, vec2, (m, [x, y]) => {
        const back = inverseApplyAffine(m, x, y);
        assertTrue(back !== null, "an invertible transform answered null");
        const there = applyAffine(m, back![0], back![1]);
        assertVecClose(
          there,
          [x, y],
          1e-7 * Math.max(1, Math.abs(x), Math.abs(y), Math.abs(m[4]), Math.abs(m[5])),
        );
      }),
    );
  });

  it("answers null for a SINGULAR matrix (rank ≤ 1, exactly)", () => {
    // An outer product of integer vectors: the determinant is 0 to the
    // bit, with no cancellation noise.
    const small = fc.integer({ min: -9, max: 9 });
    fc.assert(
      fc.property(small, small, small, small, coord, coord, vec2, (u0, u1, v0, v1, tx, ty, p) => {
        const m: Affine = [u0 * v0, u1 * v0, u0 * v1, u1 * v1, tx, ty];
        expect(det(m) === 0).toBe(true);
        expect(inverseApplyAffine(m, p[0], p[1])).toBeNull();
      }),
    );
  });
});

describe("affine — composeAffine (properties)", () => {
  it("compose(outer, inner) applies INNER first, then OUTER", () => {
    fc.assert(
      fc.property(anyAffine, anyAffine, vec2, (outer, inner, [x, y]) => {
        const step = applyAffine(inner, x, y);
        const expected = applyAffine(outer, step[0], step[1]);
        const got = applyAffine(composeAffine(outer, inner), x, y);
        const s = size(outer) * size(inner) * Math.max(1, Math.abs(x), Math.abs(y));
        assertVecClose(got, expected, 1e-9 * s);
      }),
    );
  });

  it("is associative (to the bit on integer matrices)", () => {
    fc.assert(
      fc.property(intAffine, intAffine, intAffine, (a, b, c) => {
        assertAffineExact(
          composeAffine(composeAffine(a, b), c),
          composeAffine(a, composeAffine(b, c)),
        );
      }),
    );
  });

  it("is associative within tolerance on arbitrary matrices", () => {
    fc.assert(
      fc.property(anyAffine, anyAffine, anyAffine, (a, b, c) => {
        const left = composeAffine(composeAffine(a, b), c);
        const right = composeAffine(a, composeAffine(b, c));
        const tol = 1e-9 * size(a) * size(b) * size(c);
        for (let i = 0; i < 6; i++) {
          assertClose(left[i], right[i], tol, `entry ${i}`);
        }
      }),
    );
  });

  it("IDENTITY_AFFINE is neutral on both sides", () => {
    fc.assert(
      fc.property(intAffine, (m) => {
        assertAffineExact(composeAffine(IDENTITY_AFFINE, m), m);
        assertAffineExact(composeAffine(m, IDENTITY_AFFINE), m);
      }),
    );
  });

  it("multiplies determinants", () => {
    fc.assert(
      fc.property(intAffine, intAffine, (a, b) => {
        assertClose(det(composeAffine(a, b)), det(a) * det(b), 0, "determinant");
      }),
    );
  });

  it("inverting a composition is inverting OUTER, then INNER", () => {
    fc.assert(
      fc.property(invertible, invertible, vec2, (outer, inner, [x, y]) => {
        const whole = inverseApplyAffine(composeAffine(outer, inner), x, y);
        const viaOuter = inverseApplyAffine(outer, x, y);
        assertTrue(whole !== null && viaOuter !== null, "answered null");
        const viaBoth = inverseApplyAffine(inner, viaOuter![0], viaOuter![1]);
        assertTrue(viaBoth !== null, "answered null");
        const s = Math.max(
          1,
          Math.abs(x),
          Math.abs(y),
          Math.abs(outer[4]),
          Math.abs(outer[5]),
          Math.abs(inner[4]),
          Math.abs(inner[5]),
        );
        assertVecClose(whole!, viaBoth!, 1e-6 * s);
      }),
    );
  });

  it("composing with a transform's own inverse-apply is the identity on points", () => {
    // compose/invert are inverses, stated through composition itself:
    // (A ∘ B) then A⁻¹ leaves exactly B.
    fc.assert(
      fc.property(invertible, invertible, vec2, (a, b, [x, y]) => {
        const through = applyAffine(composeAffine(a, b), x, y);
        const back = inverseApplyAffine(a, through[0], through[1]);
        assertTrue(back !== null, "answered null");
        const expected = applyAffine(b, x, y);
        assertVecClose(
          back!,
          expected,
          1e-6 * Math.max(1, Math.abs(expected[0]), Math.abs(expected[1]), Math.abs(a[4]), Math.abs(a[5])),
        );
      }),
    );
  });
});

describe("affine — affineScale (properties)", () => {
  it("is 1 for null, for the identity and for a matrix with no linear part", () => {
    fc.assert(
      fc.property(coord, coord, (tx, ty) => {
        expect(affineScale(null)).toBe(1);
        expect(affineScale(IDENTITY_AFFINE)).toBe(1);
        expect(affineScale([1, 0, 0, 1, tx, ty])).toBe(1);
        expect(affineScale([0, 0, 0, 0, tx, ty])).toBe(1);
      }),
    );
  });

  it("is |s| for a rotation times a uniform scale s, wherever it translates", () => {
    fc.assert(
      fc.property(angleRad, scaleFactor, coord, coord, (theta, s, tx, ty) => {
        const m: Affine = [
          s * Math.cos(theta),
          s * Math.sin(theta),
          -s * Math.sin(theta),
          s * Math.cos(theta),
          tx,
          ty,
        ];
        assertClose(affineScale(m), Math.abs(s), 1e-12 * Math.abs(s));
      }),
    );
  });

  it("is the mean of the two column norms, and positive", () => {
    fc.assert(
      fc.property(anyAffine, (m) => {
        const mean = (Math.hypot(m[0], m[1]) + Math.hypot(m[2], m[3])) / 2;
        const s = affineScale(m);
        assertTrue(s > 0, `scale ${s} is not positive`);
        assertClose(s, mean > 0 ? mean : 1, 1e-12 * Math.max(1, mean));
      }),
    );
  });

  it("scales with the transform: k · M has |k| times the scale", () => {
    fc.assert(
      fc.property(invertible, scaleFactor, (m, k) => {
        const scaled = composeAffine([k, 0, 0, k, 0, 0], m);
        assertClose(
          affineScale(scaled),
          Math.abs(k) * affineScale(m),
          1e-9 * Math.abs(k) * affineScale(m),
        );
      }),
    );
  });
});
