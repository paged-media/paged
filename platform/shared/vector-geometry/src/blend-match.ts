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

// BLEND STRUCTURE MATCHING (WP6.6) — the pure half of "blend two paths
// whose anchor counts differ", and of a blend between GRADIENT fills.
//
// A blend interpolates anchor for anchor (`interpolateAnchors`), so the two
// keys must share a structure. v1 refused a mismatch. This module builds
// the common structure instead, WITHOUT CHANGING EITHER SHAPE:
//
//   · ANCHOR COUNTS — the run with fewer anchors gets more, by splitting
//     its longest segment in half (de Casteljau) until the counts agree.
//     A split adds an anchor ON the curve and leaves the curve exactly as
//     it was, so the key itself is untouched; only the intermediates see
//     the extra anchors. (Illustrator adds anchors the same way.)
//   · START AND DIRECTION of a CLOSED run whose counts DIFFERED — such a
//     contour has no anchor correspondence of its own, so the other key's
//     run is rotated and, when that fits better, reversed, to the
//     correspondence that moves the anchors least (centred on each run's
//     centroid, sum of squared distances). Without it a square blended to
//     a twelve-point star twists through the steps. Runs whose counts
//     already agree keep the anchor order the user drew (v1's blend, and
//     Illustrator's: the start points correspond), so a blend that
//     matched before this module blends exactly as it did.
//   · SUBPATH COUNTS — a key with fewer contours gets degenerate ones: the
//     counterpart contour collapsed onto its own centroid, so an extra
//     hole GROWS out of a point across the steps instead of being refused.
//
// What is still REFUSED, with the reason as a sentence: an OPEN contour
// against a CLOSED one (an intermediate would have to be both).
//
// GRADIENT STOPS: two ramps blend stop for stop. Same locations ⇒ as is;
// different ones ⇒ both are RESAMPLED at the union of their locations
// (each evaluated where the other has a stop), which keeps both ramps
// exactly — as long as every midpoint is the default 50 %. A midpoint
// other than 50 % between stops that must be split would change the ramp,
// so that case is refused with its reason.

import { splitSegmentDeCasteljau } from "./bezier";
import type { Rgb } from "./svg-color";
import type { AnchorTriple, Vec2Mut } from "./types";

/** One key's geometry: page-space contour runs plus their open flags
 *  (the blend command's `BlendSource`). */
export interface ContourSet {
  subpaths: AnchorTriple[][];
  open: boolean[];
}

/** A successful match, or why there is none. */
export type MatchResult<T> =
  { ok: true; a: T; b: T; added: number } | { ok: false; reason: string };

const cloneTriple = (p: AnchorTriple): AnchorTriple => ({
  anchor: [p.anchor[0], p.anchor[1]],
  left: [p.left[0], p.left[1]],
  right: [p.right[0], p.right[1]],
});

const chord = (a: AnchorTriple, b: AnchorTriple): number =>
  // Control-polygon length: an upper bound of the arc, cheap and
  // monotone under splitting — enough to pick "the longest segment".
  Math.hypot(a.right[0] - a.anchor[0], a.right[1] - a.anchor[1]) +
  Math.hypot(b.left[0] - a.right[0], b.left[1] - a.right[1]) +
  Math.hypot(b.anchor[0] - b.left[0], b.anchor[1] - b.left[1]);

/**
 * Add anchors to `run` until it has `count`, splitting the longest
 * segment at its middle each time (the first of equal ones). The curve is
 * unchanged. A closed run's closing segment counts as a segment.
 */
export function subdivideRun(
  run: readonly AnchorTriple[],
  closed: boolean,
  count: number,
): AnchorTriple[] {
  const out = run.map(cloneTriple);
  if (out.length === 0) return out;
  if (out.length === 1) {
    while (out.length < count) out.push(cloneTriple(out[0]));
    return out;
  }
  while (out.length < count) {
    const segments = closed ? out.length : out.length - 1;
    let best = 0;
    let bestLen = -1;
    for (let s = 0; s < segments; s++) {
      const l = chord(out[s], out[(s + 1) % out.length]);
      if (l > bestLen) {
        bestLen = l;
        best = s;
      }
    }
    const a = out[best];
    const bIndex = (best + 1) % out.length;
    const b = out[bIndex];
    const split = splitSegmentDeCasteljau(
      a.anchor,
      a.right,
      b.left,
      b.anchor,
      0.5,
    );
    a.right = split.startRight;
    b.left = split.endLeft;
    const mid: AnchorTriple = {
      anchor: split.midAnchor,
      left: split.midLeft,
      right: split.midRight,
    };
    out.splice(best + 1, 0, mid);
  }
  return out;
}

/** The same closed run walked the other way (handles swap). */
export function reverseRun(run: readonly AnchorTriple[]): AnchorTriple[] {
  return run
    .slice()
    .reverse()
    .map((p) => ({
      anchor: [p.anchor[0], p.anchor[1]],
      left: [p.right[0], p.right[1]],
      right: [p.left[0], p.left[1]],
    }));
}

const centroid = (run: readonly AnchorTriple[]): Vec2Mut => {
  let x = 0;
  let y = 0;
  for (const p of run) {
    x += p.anchor[0];
    y += p.anchor[1];
  }
  return run.length ? [x / run.length, y / run.length] : [0, 0];
};

/**
 * Rotate (and maybe reverse) closed run `b` so its anchors correspond to
 * `a`'s with the least movement, both centred on their centroids. Equal
 * counts expected. Answers the re-ordered copy of `b`.
 */
export function alignClosedRun(
  a: readonly AnchorTriple[],
  b: readonly AnchorTriple[],
): AnchorTriple[] {
  const n = a.length;
  if (n !== b.length || n < 2) return b.map(cloneTriple);
  const ca = centroid(a);
  const cb = centroid(b);
  let best: AnchorTriple[] = b.map(cloneTriple);
  let bestCost = Infinity;
  for (const candidate of [b.map(cloneTriple), reverseRun(b)]) {
    for (let shift = 0; shift < n; shift++) {
      let cost = 0;
      for (let i = 0; i < n; i++) {
        const p = a[i].anchor;
        const q = candidate[(i + shift) % n].anchor;
        cost +=
          (p[0] - ca[0] - (q[0] - cb[0])) ** 2 +
          (p[1] - ca[1] - (q[1] - cb[1])) ** 2;
      }
      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        best = candidate
          .slice(shift)
          .concat(candidate.slice(0, shift))
          .map(cloneTriple);
      }
    }
  }
  return best;
}

/** A run collapsed onto its centroid: `count` anchors, all handles on
 *  the point. What an extra contour grows out of. */
export function collapsedRun(
  like: readonly AnchorTriple[],
  count = like.length,
): AnchorTriple[] {
  const c = centroid(like);
  return Array.from({ length: Math.max(1, count) }, () => ({
    anchor: [c[0], c[1]],
    left: [c[0], c[1]],
    right: [c[0], c[1]],
  }));
}

/**
 * Bring two keys to ONE structure (module header): equal subpath counts,
 * equal anchor counts per subpath, closed runs aligned. Neither shape
 * changes. `added` counts the anchors (and collapsed contours' anchors)
 * the match introduced, for the command's log.
 */
export function matchContourSets(
  a: ContourSet,
  b: ContourSet,
): MatchResult<ContourSet> {
  const subA = a.subpaths.map((r) => r.map(cloneTriple));
  const subB = b.subpaths.map((r) => r.map(cloneTriple));
  const openA = [...a.open];
  const openB = [...b.open];
  let added = 0;
  // Pad the side with fewer contours with collapsed copies of the other's.
  while (subA.length < subB.length) {
    const k = subA.length;
    subA.push(collapsedRun(subB[k]));
    openA.push(openB[k] ?? false);
    added += subB[k].length;
  }
  while (subB.length < subA.length) {
    const k = subB.length;
    subB.push(collapsedRun(subA[k]));
    openB.push(openA[k] ?? false);
    added += subA[k].length;
  }
  for (let s = 0; s < subA.length; s++) {
    const oa = openA[s] ?? false;
    const ob = openB[s] ?? false;
    if (oa !== ob) {
      return {
        ok: false,
        reason:
          `contour ${s + 1} is open in one key and closed in the other — ` +
          "an intermediate cannot be both; close the open one or open the " +
          "closed one first",
      };
    }
    const n = Math.max(subA[s].length, subB[s].length);
    const differed = subA[s].length !== subB[s].length;
    added += n - subA[s].length + (n - subB[s].length);
    subA[s] = subdivideRun(subA[s], !oa, n);
    subB[s] = subdivideRun(subB[s], !ob, n);
    if (!oa && differed) subB[s] = alignClosedRun(subA[s], subB[s]);
  }
  return {
    ok: true,
    a: { subpaths: subA, open: openA },
    b: { subpaths: subB, open: openB },
    added,
  };
}

// ----------------------------------------------------------- gradient stops

/** One gradient stop as a blend sees it: display colour, location and
 *  midpoint toward the next stop, both in percent. */
export interface RampStop {
  rgb: Rgb;
  location: number;
  midpoint: number;
}

const DEFAULT_MIDPOINT = 50;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** The ramp's colour at `location` (percent), midpoints honoured. */
export function rampColorAt(stops: readonly RampStop[], location: number): Rgb {
  if (stops.length === 0) return [0, 0, 0];
  const sorted = [...stops].sort((p, q) => p.location - q.location);
  if (location <= sorted[0].location) return [...sorted[0].rgb] as Rgb;
  const last = sorted[sorted.length - 1];
  if (location >= last.location) return [...last.rgb] as Rgb;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const p = sorted[i];
    const q = sorted[i + 1];
    if (location < p.location || location > q.location) continue;
    const span = q.location - p.location;
    let t = span <= 0 ? 0 : (location - p.location) / span;
    // A midpoint m maps t = m/100 to 0.5 (piecewise linear, the IDML ramp).
    const m = Math.min(99, Math.max(1, p.midpoint)) / 100;
    t = t <= m ? (t / m) * 0.5 : 0.5 + ((t - m) / (1 - m)) * 0.5;
    return [
      Math.round(lerp(p.rgb[0], q.rgb[0], t)),
      Math.round(lerp(p.rgb[1], q.rgb[1], t)),
      Math.round(lerp(p.rgb[2], q.rgb[2], t)),
    ];
  }
  return [...last.rgb] as Rgb;
}

/** A solid colour as a two-stop ramp — what a flat key blends as against
 *  a gradient key. */
export const solidRamp = (rgb: Rgb): RampStop[] => [
  { rgb, location: 0, midpoint: DEFAULT_MIDPOINT },
  { rgb, location: 100, midpoint: DEFAULT_MIDPOINT },
];

/**
 * Bring two ramps to the same stop locations (module header). Answers the
 * resampled pair, or the reason it cannot be done exactly.
 */
export function matchRamps(
  a: readonly RampStop[],
  b: readonly RampStop[],
): MatchResult<RampStop[]> {
  if (a.length === 0 || b.length === 0) {
    return {
      ok: false,
      reason: "a gradient without stops has no colour to blend",
    };
  }
  const sa = [...a].sort((p, q) => p.location - q.location);
  const sb = [...b].sort((p, q) => p.location - q.location);
  const same =
    sa.length === sb.length &&
    sa.every((s, i) => Math.abs(s.location - sb[i].location) < 1e-6);
  if (same) {
    return {
      ok: true,
      a: sa.map((s) => ({ ...s })),
      b: sb.map((s) => ({ ...s })),
      added: 0,
    };
  }
  // The last stop's midpoint is never used, so it does not count.
  const movesMidpoint = (stops: readonly RampStop[]): boolean =>
    stops
      .slice(0, -1)
      .some((s) => Math.abs(s.midpoint - DEFAULT_MIDPOINT) > 1e-6);
  const nonDefault = movesMidpoint(sa) || movesMidpoint(sb);
  if (nonDefault) {
    return {
      ok: false,
      reason:
        "the two gradients have their stops in different places and one of " +
        "them moves a midpoint off 50 % — resampling its stops would change " +
        "the ramp, so the gradients cannot be blended stop for stop",
    };
  }
  const locations = [...new Set([...sa, ...sb].map((s) => s.location))].sort(
    (p, q) => p - q,
  );
  const sample = (stops: RampStop[]): RampStop[] =>
    locations.map((location) => ({
      rgb: rampColorAt(stops, location),
      location,
      midpoint: DEFAULT_MIDPOINT,
    }));
  const ra = sample(sa);
  const rb = sample(sb);
  return {
    ok: true,
    a: ra,
    b: rb,
    added: ra.length - sa.length + (rb.length - sb.length),
  };
}

/** Stop-for-stop interpolation of two MATCHED ramps at `t` (0 = `a`). */
export function interpolateRamps(
  a: readonly RampStop[],
  b: readonly RampStop[],
  t: number,
): RampStop[] {
  const tt = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  return a.map((s, i) => {
    const q = b[i] ?? s;
    return {
      rgb: [
        Math.round(lerp(s.rgb[0], q.rgb[0], tt)),
        Math.round(lerp(s.rgb[1], q.rgb[1], tt)),
        Math.round(lerp(s.rgb[2], q.rgb[2], tt)),
      ],
      location: lerp(s.location, q.location, tt),
      midpoint: lerp(s.midpoint, q.midpoint, tt),
    };
  });
}
