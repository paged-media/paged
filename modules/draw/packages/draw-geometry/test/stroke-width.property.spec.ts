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

// Property tests for the three modules that turn a stroke into width
// stops for `outlineStrokeVariable`: pressure.ts (pressure → width),
// brush.ts (the calligraphic nib) and width.ts (the width tool's peaked
// profile). One file because they share one contract: a stop is a finite,
// non-negative width.

import { describe, expect, it } from "vitest";

import {
  MIN_BRUSH_WIDTH_RATIO,
  NEUTRAL_PRESSURE,
  anchorTangentAngle,
  calligraphicWidth,
  clampPressure,
  peakedWidthProfile,
  smoothAnchorsThrough,
  strokeWidthFromPressure,
  type NibProfile,
} from "../src";
import {
  angleRad,
  assertClose,
  assertTrue,
  cornerOf,
  fc,
  polyline,
  real,
  smallVec2,
  unit,
} from "./property-kit";

const anyNumber = fc.oneof(
  real(-10, 10),
  fc.constantFrom(Number.NaN, Infinity, -Infinity, 0, 1, 0.5),
);
const widthPt = real(0, 200);

describe("pressure — clampPressure / strokeWidthFromPressure (properties)", () => {
  it("clampPressure lands in [0, 1], leaves an in-range sample alone and is idempotent", () => {
    fc.assert(
      fc.property(anyNumber, (p) => {
        const c = clampPressure(p);
        assertTrue(c >= 0 && c <= 1, `clamped to ${c}`);
        if (p >= 0 && p <= 1) assertClose(c, p, 0, "an in-range sample");
        assertClose(clampPressure(c), c, 0, "clamped twice");
      }),
    );
  });

  it("clampPressure never moves a sample past the nearer end", () => {
    fc.assert(
      fc.property(real(-100, 100), (p) => {
        assertClose(clampPressure(p), Math.min(1, Math.max(0, p)), 0);
      }),
    );
    expect(clampPressure(Number.NaN)).toBe(NEUTRAL_PRESSURE);
  });

  it("the width is `min` at no pressure, `max` at full, and between them otherwise", () => {
    fc.assert(
      fc.property(widthPt, widthPt, anyNumber, (min, max, p) => {
        const profile = { min, max };
        const tol = 1e-9 * Math.max(1, min, max);
        assertClose(strokeWidthFromPressure(0, profile), min, 0, "at 0");
        assertClose(strokeWidthFromPressure(1, profile), max, tol, "at 1");
        const w = strokeWidthFromPressure(p, profile);
        assertTrue(
          w >= Math.min(min, max) - tol && w <= Math.max(min, max) + tol,
          `width ${w} is outside [${min}, ${max}]`,
        );
      }),
    );
  });

  it("more pressure is never thinner on a rising ramp (nor thicker on a falling one)", () => {
    fc.assert(
      fc.property(widthPt, widthPt, unit, unit, (min, max, p1, p2) => {
        const profile = { min, max };
        const lo = strokeWidthFromPressure(Math.min(p1, p2), profile);
        const hi = strokeWidthFromPressure(Math.max(p1, p2), profile);
        const tol = 1e-9 * Math.max(1, min, max);
        assertTrue(max >= min ? lo <= hi + tol : lo >= hi - tol, `${lo} → ${hi}`);
      }),
    );
  });

  it("a mouse (no pressure axis) lands exactly mid-ramp", () => {
    fc.assert(
      fc.property(widthPt, widthPt, (min, max) => {
        assertClose(
          strokeWidthFromPressure(NEUTRAL_PRESSURE, { min, max }),
          (min + max) / 2,
          1e-9 * Math.max(1, min, max),
        );
      }),
    );
  });
});

describe("brush — calligraphicWidth (properties)", () => {
  const nib: fc.Arbitrary<NibProfile> = fc.record({
    angle: angleRad,
    roundness: unit,
    size: real(0.1, 100),
  });

  it("is never thinner than the hairline floor nor wider than twice the nib", () => {
    fc.assert(
      fc.property(angleRad, nib, anyNumber, (tangent, n, pressure) => {
        const w = calligraphicWidth(tangent, n, pressure);
        assertTrue(
          w >= n.size * MIN_BRUSH_WIDTH_RATIO && w <= 2 * n.size * (1 + 1e-12),
          `width ${w} for a nib of ${n.size}`,
        );
      }),
    );
  });

  it("at neutral pressure is the un-scaled model: size·(r + (1 − r)·|sin(tangent − θ)|)", () => {
    fc.assert(
      fc.property(angleRad, nib, (tangent, n) => {
        const model = n.size * (n.roundness + (1 - n.roundness) * Math.abs(Math.sin(tangent - n.angle)));
        const expected = Math.max(model, n.size * MIN_BRUSH_WIDTH_RATIO);
        assertClose(calligraphicWidth(tangent, n), expected, 1e-9 * n.size, "default pressure");
        assertClose(calligraphicWidth(tangent, n, NEUTRAL_PRESSURE), expected, 1e-9 * n.size);
      }),
    );
  });

  it("depends only on the angle BETWEEN stroke and nib, and not on the stroke's direction of travel", () => {
    fc.assert(
      fc.property(angleRad, nib, unit, angleRad, (tangent, n, pressure, turn) => {
        const w = calligraphicWidth(tangent, n, pressure);
        const tol = 1e-9 * n.size;
        // Turn the stroke and the nib together.
        assertClose(
          calligraphicWidth(tangent + turn, { ...n, angle: n.angle + turn }, pressure),
          w,
          tol,
          "turned together",
        );
        // Travel the other way along the same line.
        assertClose(calligraphicWidth(tangent + Math.PI, n, pressure), w, tol, "reversed");
      }),
    );
  });

  it("is widest ACROSS the nib and thinnest ALONG it", () => {
    fc.assert(
      fc.property(angleRad, nib, unit, (tangent, n, pressure) => {
        const w = calligraphicWidth(tangent, n, pressure);
        const across = calligraphicWidth(n.angle + Math.PI / 2, n, pressure);
        const along = calligraphicWidth(n.angle, n, pressure);
        const tol = 1e-9 * n.size;
        assertTrue(w <= across + tol && w >= along - tol, `${along} ≤ ${w} ≤ ${across} fails`);
      }),
    );
  });

  it("a round nib (roundness 1) does not care about the angle at all", () => {
    fc.assert(
      fc.property(angleRad, angleRad, nib, unit, (t1, t2, n, pressure) => {
        const round = { ...n, roundness: 1 };
        assertClose(
          calligraphicWidth(t1, round, pressure),
          calligraphicWidth(t2, round, pressure),
          1e-12 * n.size,
        );
      }),
    );
  });

  it("more pressure is never thinner; full pressure is twice neutral (above the floor)", () => {
    fc.assert(
      fc.property(angleRad, nib, unit, unit, (tangent, n, p1, p2) => {
        const lo = calligraphicWidth(tangent, n, Math.min(p1, p2));
        const hi = calligraphicWidth(tangent, n, Math.max(p1, p2));
        assertTrue(lo <= hi + 1e-12 * n.size, `${lo} → ${hi}`);
        const neutral = calligraphicWidth(tangent, n, NEUTRAL_PRESSURE);
        if (neutral > n.size * MIN_BRUSH_WIDTH_RATIO) {
          assertClose(calligraphicWidth(tangent, n, 1), 2 * neutral, 1e-9 * n.size, "full pressure");
        }
      }),
    );
  });

  it("clamps roundness to [0, 1], reads a non-finite roundness as round, and a bad size as no width", () => {
    fc.assert(
      fc.property(angleRad, nib, unit, real(0, 5), (tangent, n, pressure, over) => {
        const tol = 1e-12 * n.size;
        assertClose(
          calligraphicWidth(tangent, { ...n, roundness: 1 + over }, pressure),
          calligraphicWidth(tangent, { ...n, roundness: 1 }, pressure),
          tol,
        );
        assertClose(
          calligraphicWidth(tangent, { ...n, roundness: -over }, pressure),
          calligraphicWidth(tangent, { ...n, roundness: 0 }, pressure),
          tol,
        );
        assertClose(
          calligraphicWidth(tangent, { ...n, roundness: Number.NaN }, pressure),
          calligraphicWidth(tangent, { ...n, roundness: 1 }, pressure),
          tol,
        );
        for (const bad of [0, -n.size, Number.NaN, Infinity]) {
          expect(calligraphicWidth(tangent, { ...n, size: bad }, pressure)).toBe(0);
        }
      }),
    );
  });
});

describe("brush — anchorTangentAngle (properties)", () => {
  const sameDirection = (a: number, b: number): boolean =>
    Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 1e-9;

  it("a smooth anchor's tangent is its left → right handle chord", () => {
    fc.assert(
      fc.property(smallVec2, smallVec2, fc.boolean(), (anchor, drag, closed) => {
        fc.pre(drag[0] !== 0 || drag[1] !== 0);
        const a = {
          anchor,
          left: [anchor[0] - drag[0], anchor[1] - drag[1]] as [number, number],
          right: [anchor[0] + drag[0], anchor[1] + drag[1]] as [number, number],
        };
        const run = [cornerOf([-99, 7]), a, cornerOf([42, 42])];
        assertTrue(
          sameDirection(anchorTangentAngle(run, 1, closed), Math.atan2(drag[1], drag[0])),
          "tangent is not along the handles",
        );
      }),
    );
  });

  it("a corner's tangent is the chord between its neighbours — wrapping when closed, one-sided at an open end", () => {
    const distinct = polyline(3, 7, smallVec2).filter(
      (pts) => new Set(pts.map((p) => `${p[0]},${p[1]}`)).size === pts.length,
    );
    fc.assert(
      fc.property(distinct, fc.nat(20), fc.boolean(), (pts, pick, closed) => {
        const n = pts.length;
        const i = pick % n;
        const run = pts.map(cornerOf);
        const prev = i > 0 ? pts[i - 1] : closed ? pts[n - 1] : pts[i];
        const next = i < n - 1 ? pts[i + 1] : closed ? pts[0] : pts[i];
        assertTrue(
          sameDirection(
            anchorTangentAngle(run, i, closed),
            Math.atan2(next[1] - prev[1], next[0] - prev[0]),
          ),
          `corner ${i} of ${n}`,
        );
      }),
    );
  });

  it("agrees with the curve smoothAnchorsThrough fitted: the tangent at point i runs from point i−1 to point i+1", () => {
    const distinct = polyline(3, 7, smallVec2).filter((pts) =>
      pts.every((p, i) => {
        const q = pts[(i + 2) % pts.length];
        return p[0] !== q[0] || p[1] !== q[1];
      }),
    );
    fc.assert(
      fc.property(distinct, fc.nat(20), (pts, pick) => {
        const n = pts.length;
        const i = pick % n;
        const anchors = smoothAnchorsThrough(pts, undefined, true);
        const prev = pts[(i - 1 + n) % n];
        const next = pts[(i + 1) % n];
        assertTrue(
          sameDirection(
            anchorTangentAngle(anchors, i, true),
            Math.atan2(next[1] - prev[1], next[0] - prev[0]),
          ),
          `point ${i} of ${n}`,
        );
      }),
    );
  });

  it("an out-of-range index, a lone anchor and a fully collapsed run all answer 0", () => {
    fc.assert(
      fc.property(smallVec2, fc.integer({ min: 1, max: 5 }), fc.boolean(), (p, n, closed) => {
        const stacked = Array.from({ length: n }, () => cornerOf(p));
        expect(anchorTangentAngle(stacked, 0, closed)).toBe(0);
        expect(anchorTangentAngle(stacked, n, closed)).toBe(0);
        expect(anchorTangentAngle(stacked, -1, closed)).toBe(0);
        expect(anchorTangentAngle([], 0, closed)).toBe(0);
      }),
    );
  });
});

describe("width — peakedWidthProfile (properties)", () => {
  const n = fc.integer({ min: 1, max: 40 });
  /** Includes 0 and negative values: the docstring clamps the falloff to
   *  ≥ 1, so they must behave exactly like 1. */
  const falloff = fc.oneof(real(0.1, 12), fc.constantFrom(0, -1, -7.5, 1, 2));
  const index = real(-5, 45);

  it("is one non-negative, finite width per anchor", () => {
    fc.assert(
      fc.property(n, index, widthPt, widthPt, falloff, (count, peakIndex, peak, base, f) => {
        const out = peakedWidthProfile(count, peakIndex, peak, base, f);
        expect(out).toHaveLength(count);
        for (const w of out) assertTrue(Number.isFinite(w) && w >= 0, `width ${w}`);
      }),
    );
  });

  it("peaks at the (clamped, rounded) index and has fully decayed `falloff` anchors away", () => {
    fc.assert(
      fc.property(n, index, widthPt, widthPt, falloff, (count, peakIndex, peak, base, f) => {
        const out = peakedWidthProfile(count, peakIndex, peak, base, f);
        const at = Math.min(count - 1, Math.max(0, Math.round(peakIndex)));
        const reach = Math.max(1, f);
        // `base + (peak − base)` is `peak` only to an ulp.
        assertClose(out[at], peak, 1e-12 * Math.max(1, peak, base), "the peak");
        out.forEach((w, i) => {
          if (Math.abs(i - at) >= reach) assertClose(w, base, 0, `stop ${i}`);
        });
      }),
    );
  });

  it("every width lies between base and peak, and falls away monotonically either side", () => {
    fc.assert(
      fc.property(n, index, widthPt, widthPt, falloff, (count, peakIndex, peak, base, f) => {
        const out = peakedWidthProfile(count, peakIndex, peak, base, f);
        const at = Math.min(count - 1, Math.max(0, Math.round(peakIndex)));
        const lo = Math.min(base, peak);
        const hi = Math.max(base, peak);
        const tol = 1e-9 * Math.max(1, hi);
        out.forEach((w, i) => {
          assertTrue(w >= lo - tol && w <= hi + tol, `width ${w} outside [${lo}, ${hi}]`);
          if (i === at) return;
          // One step nearer the peak is at least as far toward `peak`.
          const nearer = out[i < at ? i + 1 : i - 1];
          assertTrue(
            peak >= base ? nearer >= w - tol : nearer <= w + tol,
            `not monotone at ${i}: ${w} then ${nearer}`,
          );
        });
      }),
    );
  });

  it("is symmetric about the peak", () => {
    fc.assert(
      fc.property(n, index, widthPt, widthPt, falloff, (count, peakIndex, peak, base, f) => {
        const out = peakedWidthProfile(count, peakIndex, peak, base, f);
        const at = Math.min(count - 1, Math.max(0, Math.round(peakIndex)));
        for (let d = 1; at - d >= 0 && at + d < count; d++) {
          expect(out[at - d]).toBe(out[at + d]);
        }
      }),
    );
  });

  it("is the stated formula, floored at 0 — a thinning peak is allowed, a negative stop is not", () => {
    const signed = real(-50, 200);
    fc.assert(
      fc.property(n, index, signed, signed, falloff, (count, peakIndex, peak, base, f) => {
        const out = peakedWidthProfile(count, peakIndex, peak, base, f);
        const at = Math.min(count - 1, Math.max(0, Math.round(peakIndex)));
        const reach = Math.max(1, f);
        out.forEach((w, i) => {
          const influence = Math.max(0, 1 - Math.abs(i - at) / reach);
          assertClose(w, Math.max(0, base + (peak - base) * influence), 1e-9 * 200, `stop ${i}`);
          assertTrue(w >= 0, `negative stop ${w}`);
        });
      }),
    );
  });

  it("answers [] for a count below 1 or any non-finite argument; a fractional count is floored", () => {
    fc.assert(
      fc.property(real(-10, 0.99), real(1, 30), (few, fractional) => {
        expect(peakedWidthProfile(few, 0, 4, 1)).toEqual([]);
        expect(peakedWidthProfile(fractional, 0, 4, 1)).toHaveLength(Math.floor(fractional));
        for (const bad of [Number.NaN, Infinity, -Infinity]) {
          expect(peakedWidthProfile(bad, 0, 4, 1)).toEqual([]);
          expect(peakedWidthProfile(5, bad, 4, 1)).toEqual([]);
          expect(peakedWidthProfile(5, 0, bad, 1)).toEqual([]);
          expect(peakedWidthProfile(5, 0, 4, bad)).toEqual([]);
          expect(peakedWidthProfile(5, 0, 4, 1, bad)).toEqual([]);
        }
      }),
    );
  });
});
