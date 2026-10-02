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

// Property tests for blend.ts — anchor-run interpolation and the sRGB
// colour mix of the blend command.

import { describe, expect, it } from "vitest";

import {
  interpolateAnchors,
  isCornerAnchor,
  mixRgb,
  type AnchorTriple,
  type Rgb,
} from "../src";
import {
  anchorRun,
  anchorTriple,
  assertTrue,
  assertVecClose,
  fc,
  magnitude,
  real,
  unit,
} from "./property-kit";

const KEYS = ["anchor", "left", "right"] as const;

/** Two runs of the SAME length. */
const pair: fc.Arbitrary<[AnchorTriple[], AnchorTriple[]]> = fc
  .integer({ min: 0, max: 6 })
  .chain((n) =>
    fc.tuple(
      fc.array(anchorTriple, { minLength: n, maxLength: n }),
      fc.array(anchorTriple, { minLength: n, maxLength: n }),
    ),
  );

const sizeOf = (...runs: AnchorTriple[][]): number =>
  magnitude(...runs.flatMap((run) => run.flatMap((a) => [a.anchor, a.left, a.right])));

const channel = fc.integer({ min: 0, max: 255 });
const rgb: fc.Arbitrary<Rgb> = fc.tuple(channel, channel, channel);

describe("blend — interpolateAnchors (properties)", () => {
  it("is the first run at t = 0 (exactly) and the second at t = 1 (to an ulp)", () => {
    fc.assert(
      fc.property(pair, ([a, b]) => {
        const at0 = interpolateAnchors(a, b, 0);
        const at1 = interpolateAnchors(a, b, 1);
        expect(at0).toHaveLength(a.length);
        expect(at1).toHaveLength(a.length);
        const tol = 1e-9 * sizeOf(a, b);
        a.forEach((_, i) => {
          for (const key of KEYS) {
            assertVecClose(at0[i][key], a[i][key], 0, `t=0 [${i}].${key}`);
            assertVecClose(at1[i][key], b[i][key], tol, `t=1 [${i}].${key}`);
          }
        });
      }),
    );
  });

  it("every point moves along the straight line between its two keys, in proportion to t", () => {
    fc.assert(
      fc.property(pair, real(-2, 3), ([a, b], t) => {
        const out = interpolateAnchors(a, b, t);
        const tol = 1e-9 * sizeOf(a, b);
        a.forEach((_, i) => {
          for (const key of KEYS) {
            const p = a[i][key];
            const q = b[i][key];
            assertVecClose(
              out[i][key],
              [p[0] * (1 - t) + q[0] * t, p[1] * (1 - t) + q[1] * t],
              tol,
              `[${i}].${key}`,
            );
          }
        });
      }),
    );
  });

  it("blending a → b at t is blending b → a at 1 − t", () => {
    fc.assert(
      fc.property(pair, unit, ([a, b], t) => {
        const forward = interpolateAnchors(a, b, t);
        const backward = interpolateAnchors(b, a, 1 - t);
        const tol = 1e-9 * sizeOf(a, b);
        forward.forEach((anchor, i) => {
          for (const key of KEYS) {
            assertVecClose(backward[i][key], anchor[key], tol, `[${i}].${key}`);
          }
        });
      }),
    );
  });

  it("a corner in BOTH keys stays a corner at every step — straight segments stay straight", () => {
    fc.assert(
      fc.property(pair, real(-1, 2), ([a, b], t) => {
        interpolateAnchors(a, b, t).forEach((anchor, i) => {
          const bothCorners =
            KEYS.every((k) => a[i][k][0] === a[i].anchor[0] && a[i][k][1] === a[i].anchor[1]) &&
            KEYS.every((k) => b[i][k][0] === b[i].anchor[0] && b[i][k][1] === b[i].anchor[1]);
          if (!bothCorners) return;
          // Exactly collapsed, not merely within the classifier's 1e-3.
          assertVecClose(anchor.left, anchor.anchor, 0, `[${i}].left`);
          assertVecClose(anchor.right, anchor.anchor, 0, `[${i}].right`);
          assertTrue(isCornerAnchor(anchor), "not a corner");
        });
      }),
    );
  });

  it("blending a run with itself is that run", () => {
    fc.assert(
      fc.property(anchorRun(0, 6), unit, (a, t) => {
        const tol = 1e-9 * sizeOf(a);
        interpolateAnchors(a, a, t).forEach((anchor, i) => {
          for (const key of KEYS) assertVecClose(anchor[key], a[i][key], tol);
        });
      }),
    );
  });

  it("answers [] for mismatched lengths or a non-finite t, never a throw", () => {
    fc.assert(
      fc.property(anchorRun(0, 5), anchorRun(0, 5), unit, (a, b, t) => {
        if (a.length !== b.length) expect(interpolateAnchors(a, b, t)).toEqual([]);
        for (const bad of [Number.NaN, Infinity, -Infinity]) {
          expect(interpolateAnchors(a, a, bad)).toEqual([]);
        }
      }),
    );
  });

  it("returns fresh anchors: mutating the output leaves both keys alone", () => {
    fc.assert(
      fc.property(pair, unit, ([a, b], t) => {
        const [ca, cb] = structuredClone([a, b]);
        const before = JSON.stringify([ca, cb]);
        for (const anchor of interpolateAnchors(ca, cb, t)) {
          for (const key of KEYS) anchor[key][0] = Number.NaN;
        }
        expect(JSON.stringify([ca, cb])).toBe(before);
      }),
    );
  });
});

describe("blend — mixRgb (properties)", () => {
  it("is the first colour at t = 0 and the second at t = 1", () => {
    fc.assert(
      fc.property(rgb, rgb, (a, b) => {
        expect(mixRgb(a, b, 0)).toEqual(a);
        expect(mixRgb(a, b, 1)).toEqual(b);
      }),
    );
  });

  it("every channel is an integer between its two keys", () => {
    fc.assert(
      fc.property(rgb, rgb, real(-3, 4), (a, b, t) => {
        mixRgb(a, b, t).forEach((v, i) => {
          assertTrue(Number.isInteger(v), `channel ${i} = ${v}`);
          assertTrue(
            v >= Math.min(a[i], b[i]) && v <= Math.max(a[i], b[i]),
            `channel ${i} = ${v} is outside [${a[i]}, ${b[i]}]`,
          );
        });
      }),
    );
  });

  it("moves each channel MONOTONICALLY from the first colour to the second", () => {
    fc.assert(
      fc.property(rgb, rgb, unit, unit, (a, b, t1, t2) => {
        const lo = mixRgb(a, b, Math.min(t1, t2));
        const hi = mixRgb(a, b, Math.max(t1, t2));
        for (let i = 0; i < 3; i++) {
          const rising = b[i] >= a[i];
          assertTrue(
            rising ? lo[i] <= hi[i] : lo[i] >= hi[i],
            `channel ${i} went the wrong way: ${lo[i]} → ${hi[i]}`,
          );
        }
      }),
    );
  });

  it("is within half a level of the exact linear mix", () => {
    fc.assert(
      fc.property(rgb, rgb, unit, (a, b, t) => {
        mixRgb(a, b, t).forEach((v, i) => {
          const exact = a[i] + (b[i] - a[i]) * t;
          assertTrue(Math.abs(v - exact) <= 0.5 + 1e-9, `channel ${i}: ${v} vs ${exact}`);
        });
      }),
    );
  });

  it("clamps t to [0, 1] and reads NaN as 0", () => {
    fc.assert(
      fc.property(rgb, rgb, real(0, 50), (a, b, beyond) => {
        expect(mixRgb(a, b, -beyond)).toEqual(a);
        expect(mixRgb(a, b, 1 + beyond)).toEqual(b);
        expect(mixRgb(a, b, Number.NaN)).toEqual(a);
      }),
    );
  });

  it("clamps out-of-gamut input into 0..255", () => {
    const loose = real(-500, 800);
    fc.assert(
      fc.property(fc.tuple(loose, loose, loose), fc.tuple(loose, loose, loose), unit, (a, b, t) => {
        for (const v of mixRgb(a, b, t)) {
          assertTrue(Number.isInteger(v) && v >= 0 && v <= 255, `channel = ${v}`);
        }
      }),
    );
  });
});
