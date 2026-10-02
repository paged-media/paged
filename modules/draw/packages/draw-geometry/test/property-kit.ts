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

// The shared half of the `*.property.spec.ts` files: ONE fast-check
// configuration, the arbitraries every module's properties draw from, and
// the INDEPENDENT reference implementations the properties compare the
// kernel against.
//
// REPRODUCIBILITY. Every property spec imports `fc` FROM HERE, never from
// "fast-check" directly, so the global configuration below is applied in
// each test file's module graph before its first `fc.assert`. The seed is
// FIXED: a red property is red on every machine and on every re-run, and
// fast-check prints the seed, the shrink path and the minimal
// counterexample with it. To explore instead of replay, run with
// `PAGED_PROPERTY_SEED=<n>` (and `PAGED_PROPERTY_RUNS=<n>` to dig deeper).
//
// THE REFERENCES ARE DELIBERATELY NOT THE KERNEL'S ALGORITHMS. A property
// that re-derives its expectation with the code under test proves only
// that the code agrees with itself. So the cubic is evaluated by repeated
// lerp where the kernel uses the Bernstein form, containment is decided by
// angle summation where the kernel casts a ray, and so on. Each reference
// says which algorithm it is and why it is a different one.
//
// PINNED DEFECTS. Where a property found the CODE wrong, the code was not
// touched and the property was not weakened. The defect is recorded where
// it was found as `it.fails("DEFECT …")`: a comment block naming the
// function, the minimal counterexample, expected vs actual and who it
// bites, then the failing assertion itself. An `it.fails` is GREEN while
// the defect exists and goes RED the moment it is fixed — that red is the
// instruction to flip it to `it`. The passing property beside it states
// its exclusion (an `fc.pre`, or a narrower generator) in so many words.
// `grep -rn "it.fails(" test/` is the defect list.

import fc from "fast-check";

import type { AnchorTable, AnchorTriple, Vec2, Vec2Mut } from "../src";

const envInt = (name: string): number | undefined => {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
};

/** The fixed seed. 2026-10-02 is the day these properties were written. */
export const PROPERTY_SEED = envInt("PAGED_PROPERTY_SEED") ?? 20261002;
/** Runs per property. Pure math: 200 runs of every property in the
 *  package is about three seconds of work, spread over the worker pool. */
export const PROPERTY_RUNS = envInt("PAGED_PROPERTY_RUNS") ?? 200;

fc.configureGlobal({ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS });

export { fc };

// ------------------------------------------------------------ numbers

/**
 * UNIFORM IN VALUE over `[min, max]`.
 *
 * This exists because `fc.double({ min, max })` is NOT that. fast-check
 * draws doubles uniformly over the REPRESENTABLE doubles in the range, and
 * most representable doubles are tiny: over [0, 1] fewer than 1 draw in
 * 100 is above 0.01, and the typical draw is ~1e-150. A "parameter in
 * [0, 1]" built on it is, for every practical purpose, the constant 0 —
 * and a property fed the constant 0 passes whatever the code does. The
 * first mutation pass over these specs showed exactly that: an ease curve
 * replaced by its square root, a colour mix replaced by a sine and a
 * winding rule that never alternated all went unnoticed until the
 * parameters were drawn from here.
 *
 * 2^30 steps; shrinks toward `min`.
 */
export const uniform = (min: number, max: number): fc.Arbitrary<number> =>
  fc
    .integer({ min: 0, max: 1 << 30 })
    .map((n) => min + ((max - min) * n) / (1 << 30));

/**
 * The number arbitrary every property here uses for a real quantity:
 * mostly {@link uniform}, plus the two ends of the range, plus a share of
 * `fc.double` for what IT is good at — ±0, denormals, the value one ulp
 * inside an end.
 */
export const real = (min: number, max: number): fc.Arbitrary<number> =>
  fc.oneof(
    { weight: 8, arbitrary: uniform(min, max) },
    { weight: 1, arbitrary: fc.constantFrom(min, max) },
    { weight: 1, arbitrary: fc.double({ min, max, noNaN: true }) },
  );

/** A page-scale coordinate. Half the draws are small INTEGERS — they
 *  collide, line up and cancel, which is where geometry code breaks — and
 *  half are reals in a ±1000 pt box. */
export const coord: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: -20, max: 20 }),
  real(-1000, 1000),
);

/** A coordinate with no sub-0.001 detail: integers and a few decimals.
 *  For properties whose subject ROUNDS (the SVG serializer). */
export const gridCoord: fc.Arbitrary<number> = fc
  .integer({ min: -4000, max: 4000 })
  .map((n) => n / 8);

export const vec2: fc.Arbitrary<Vec2Mut> = fc.tuple(coord, coord);
export const smallVec2: fc.Arbitrary<Vec2Mut> = fc.tuple(
  fc.integer({ min: -12, max: 12 }),
  fc.integer({ min: -12, max: 12 }),
);

/** A parameter in [0, 1], ends included. */
export const unit: fc.Arbitrary<number> = real(0, 1);

/** An angle in radians, a few turns either way. */
export const angleRad: fc.Arbitrary<number> = real(-4 * Math.PI, 4 * Math.PI);

/** An angle in degrees, mixing the round values a UI produces with
 *  arbitrary ones. */
export const angleDeg: fc.Arbitrary<number> = fc.oneof(
  fc.constantFrom(0, 30, 45, 90, 135, 180, 270, 360, -45, -90, -180),
  real(-720, 720),
);

// ----------------------------------------------------------- geometry

/** The four control points of one cubic, as `[start, startRight,
 *  endLeft, end]` — the kernel's argument order. */
export type Cubic = [Vec2Mut, Vec2Mut, Vec2Mut, Vec2Mut];
export const cubic: fc.Arbitrary<Cubic> = fc.tuple(vec2, vec2, vec2, vec2);
/** Integer control points in a small box: cusps, loops and collinear
 *  polygons turn up constantly. */
export const smallCubic: fc.Arbitrary<Cubic> = fc.tuple(
  smallVec2,
  smallVec2,
  smallVec2,
  smallVec2,
);

export const cornerOf = (p: Vec2): AnchorTriple => ({
  anchor: [p[0], p[1]],
  left: [p[0], p[1]],
  right: [p[0], p[1]],
});

/** An anchor that is a corner half the time and carries two FREE handles
 *  (not mirrored — the general wire shape) the other half. */
export const anchorTriple: fc.Arbitrary<AnchorTriple> = fc.oneof(
  vec2.map(cornerOf),
  fc.record({ anchor: vec2, left: vec2, right: vec2 }),
);
export const smallAnchorTriple: fc.Arbitrary<AnchorTriple> = fc.oneof(
  smallVec2.map(cornerOf),
  fc.record({ anchor: smallVec2, left: smallVec2, right: smallVec2 }),
);

export const anchorRun = (
  minLength: number,
  maxLength: number,
  item: fc.Arbitrary<AnchorTriple> = anchorTriple,
): fc.Arbitrary<AnchorTriple[]> => fc.array(item, { minLength, maxLength });

export const polyline = (
  minLength: number,
  maxLength: number,
  point: fc.Arbitrary<Vec2Mut> = vec2,
): fc.Arbitrary<Vec2Mut[]> => fc.array(point, { minLength, maxLength });

/**
 * A SIMPLE polygon (no self-intersection), by construction: star-shaped
 * about `center`. Vertex k sits at angle `2π·(k + jitter_k)/n` with
 * `|jitter| ≤ 0.24`, at an arbitrary positive radius. The angles are then
 * strictly increasing AND consecutive vertices are less than a half turn
 * apart even for a triangle (120°·1.48 = 177.6°), so the centre sees
 * every edge from the same side: any ray from the centre meets the ring
 * exactly once. That is what makes "inside" unambiguous under BOTH fill
 * rules — the precondition of the even-odd-vs-non-zero agreement
 * property.
 */
export interface StarPolygon {
  center: Vec2Mut;
  ring: Vec2Mut[];
  /** Largest vertex radius — the polygon lies inside this disc. */
  reach: number;
}
export const starPolygon: fc.Arbitrary<StarPolygon> = fc
  .tuple(
    fc.tuple(fc.integer({ min: -50, max: 50 }), fc.integer({ min: -50, max: 50 })),
    fc.array(
      fc.tuple(
        real(1, 100),
        real(-0.24, 0.24),
      ),
      { minLength: 3, maxLength: 12 },
    ),
    fc.boolean(),
  )
  .map(([center, spokes, clockwise]) => {
    const n = spokes.length;
    const ring = spokes.map(([r, jitter], k): Vec2Mut => {
      const a = (2 * Math.PI * (k + jitter)) / n;
      return [center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)];
    });
    if (clockwise) ring.reverse();
    return {
      center,
      ring,
      reach: Math.max(...spokes.map(([r]) => r)),
    };
  });

/**
 * A table the SVG path parser itself could have produced, built
 * directly: 1..3 contours of 1..5 anchors on the 1/8 pt lattice (so three
 * decimals print it exactly). Open contours keep their two OUTWARD
 * handles collapsed (path data has nowhere to put them); closed contours
 * of 2+ anchors do not end on their own start (the stacked-close shape —
 * svg-path's pinned round-trip defect).
 */
export const canonicalTable: fc.Arbitrary<AnchorTable> = (() => {
  const same = (a: Vec2, b: Vec2): boolean => a[0] === b[0] && a[1] === b[1];
  const point = fc.tuple(gridCoord, gridCoord);
  const anchor: fc.Arbitrary<AnchorTriple> = fc.oneof(
    point.map(cornerOf),
    fc.record({ anchor: point, left: point, right: point }),
  );
  const contour = fc
    .tuple(fc.array(anchor, { minLength: 1, maxLength: 5 }), fc.boolean())
    .map(([anchors, open]) => {
      const run = anchors.map(
        (a): AnchorTriple => ({
          anchor: [a.anchor[0], a.anchor[1]],
          left: [a.left[0], a.left[1]],
          right: [a.right[0], a.right[1]],
        }),
      );
      if (open) {
        run[0].left = [run[0].anchor[0], run[0].anchor[1]];
        const last = run[run.length - 1];
        last.right = [last.anchor[0], last.anchor[1]];
      }
      return { run, open };
    })
    .filter(
      ({ run, open }) =>
        open || run.length < 2 || !same(run[run.length - 1].anchor, run[0].anchor),
    );
  return fc.array(contour, { minLength: 1, maxLength: 3 }).map((contours) => {
    const anchors: AnchorTriple[] = [];
    const subpathStarts: number[] = [];
    const subpathOpen: boolean[] = [];
    for (const { run, open } of contours) {
      subpathStarts.push(anchors.length);
      subpathOpen.push(open);
      anchors.push(...run);
    }
    return { anchors, subpathStarts, subpathOpen };
  });
})();

// --------------------------------------------------------- references

/** REFERENCE cubic evaluation: de Casteljau (three rounds of lerp). The
 *  kernel's `evalCubic` uses the expanded Bernstein weights. */
export function refEvalCubic(c: Cubic, t: number): Vec2Mut {
  const lerp = (a: Vec2, b: Vec2): Vec2Mut => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
  ];
  const q0 = lerp(c[0], c[1]);
  const q1 = lerp(c[1], c[2]);
  const q2 = lerp(c[2], c[3]);
  return lerp(lerp(q0, q1), lerp(q1, q2));
}

/** REFERENCE point→segment distance: project onto the segment's unit
 *  direction and split into the three regions explicitly (before `a`,
 *  past `b`, alongside). The kernel clamps a normalised parameter. */
export function refSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const ux = (b[0] - a[0]) / len;
  const uy = (b[1] - a[1]) / len;
  const along = (p[0] - a[0]) * ux + (p[1] - a[1]) * uy;
  if (along <= 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  if (along >= len) return Math.hypot(p[0] - b[0], p[1] - b[1]);
  return Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux);
}

/** Distance from `p` to an OPEN polyline (∞ for an empty one). */
export function refPolylineDistance(p: Vec2, pts: readonly Vec2[]): number {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]);
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    best = Math.min(best, refSegmentDistance(p, pts[i], pts[i + 1]));
  }
  return best;
}

/** Distance from `p` to a CLOSED ring's boundary. */
export function refRingDistance(p: Vec2, ring: readonly Vec2[]): number {
  if (ring.length === 0) return Infinity;
  return refPolylineDistance(p, [...ring, ring[0]]);
}

/**
 * REFERENCE winding number of a closed ring about `p`, by ANGLE
 * SUMMATION: the signed angle each edge subtends at `p`, summed, is
 * `2π · winding`. No ray, no crossing rule — a different algorithm from
 * the kernel's ray cast, and the textbook definition of the NON-ZERO
 * rule (`winding !== 0` is inside), which is the rule the engine fills
 * with. Meaningless for a point ON the boundary; callers keep clear.
 */
export function refWindingNumber(p: Vec2, ring: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const ax = a[0] - p[0];
    const ay = a[1] - p[1];
    const bx = b[0] - p[0];
    const by = b[1] - p[1];
    sum += Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  }
  return Math.round(sum / (2 * Math.PI));
}

/**
 * REFERENCE even-odd containment with a VERTICAL ray (toward +y). The
 * kernel casts its ray toward +x, so the two count crossings of entirely
 * different edges; they must still agree on parity for any point off the
 * boundary.
 */
export function refEvenOddVertical(p: Vec2, ring: readonly Vec2[]): boolean {
  let crossings = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a[0] > p[0] === b[0] > p[0]) continue;
    const yAt = a[1] + ((p[0] - a[0]) * (b[1] - a[1])) / (b[0] - a[0]);
    if (yAt > p[1]) crossings++;
  }
  return crossings % 2 === 1;
}

/** Shoelace signed area of a ring (the textbook `Σ xᵢ·yᵢ₊₁ − xᵢ₊₁·yᵢ`
 *  ordering; the kernel walks `j = i − 1`). */
export function refSignedArea(ring: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/** Length of an open polyline. */
export function refPolylineLength(pts: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    sum += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  }
  return sum;
}

// ------------------------------------------------------------ asserts

/** The largest coordinate magnitude in a bag of points (≥ 1), the scale
 *  a relative tolerance is taken against. */
export function magnitude(...pts: readonly Vec2[]): number {
  let m = 1;
  for (const p of pts) m = Math.max(m, Math.abs(p[0]), Math.abs(p[1]));
  return m;
}

/** `|a − b| ≤ tol`, with a message that names both values (fast-check
 *  prints the counterexample; this prints why it is one). */
export function assertClose(
  actual: number,
  expected: number,
  tol: number,
  what = "value",
): void {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(
      `${what}: expected ${expected} ± ${tol}, got ${actual} ` +
        `(off by ${Math.abs(actual - expected)})`,
    );
  }
}

export function assertVecClose(
  actual: Vec2,
  expected: Vec2,
  tol: number,
  what = "point",
): void {
  const d = Math.hypot(actual[0] - expected[0], actual[1] - expected[1]);
  if (!(d <= tol)) {
    throw new Error(
      `${what}: expected [${expected[0]}, ${expected[1]}] ± ${tol}, ` +
        `got [${actual[0]}, ${actual[1]}] (off by ${d})`,
    );
  }
}

export function assertTrue(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

/** Deep structural equality on anchor tables, to a tolerance. */
export function assertTableClose(
  actual: AnchorTable,
  expected: AnchorTable,
  tol: number,
  what = "table",
): void {
  if (actual.anchors.length !== expected.anchors.length) {
    throw new Error(
      `${what}: ${actual.anchors.length} anchors, expected ${expected.anchors.length}`,
    );
  }
  const starts = (t: AnchorTable) => JSON.stringify(t.subpathStarts);
  if (starts(actual) !== starts(expected)) {
    throw new Error(
      `${what}: subpathStarts ${starts(actual)}, expected ${starts(expected)}`,
    );
  }
  const open = (t: AnchorTable) =>
    JSON.stringify(t.subpathStarts.map((_, i) => t.subpathOpen?.[i] ?? false));
  if (open(actual) !== open(expected)) {
    throw new Error(
      `${what}: subpathOpen ${open(actual)}, expected ${open(expected)}`,
    );
  }
  for (let i = 0; i < expected.anchors.length; i++) {
    for (const key of ["anchor", "left", "right"] as const) {
      assertVecClose(
        actual.anchors[i][key],
        expected.anchors[i][key],
        tol,
        `${what}: anchors[${i}].${key}`,
      );
    }
  }
}
