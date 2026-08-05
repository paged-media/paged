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

// ALONG-PATH PLACEMENT — the ONE arc-length kernel behind Illustrator
// §16.2's blend SPINE and §16.3's objects-on-a-path. Pure math, zero
// deps, host-free.
//
// ------------------------------------------- why this is shared, once
// Two Phase-3 rows landed together and the question "is there a common
// placement kernel, or is that a forced abstraction?" had to be answered
// with facts rather than a preference. The fact is that BOTH rows need
// exactly the same non-trivial thing:
//
//   given an anchor run and a fraction of its LENGTH, where is that
//   point and which way is the path pointing there
//
// and both then need the same distribution rule on top (n slots by
// COUNT, or slots every d points by SPACING). That is ~150 lines of
// flattening, cumulative arc length, a lookup and a tangent — the exact
// shape of thing that goes wrong twice if it is written twice.
//
// What is deliberately NOT here is everything ABOVE the slot list,
// because there the two rows need DIFFERENT facts:
//   · a BLEND interpolates NEW geometry between two shapes and then
//     offsets it onto the spine (`commands/blend.ts`);
//   · OBJECTS ON A PATH move EXISTING elements — their own geometry,
//     their own ids — onto the slots about a pivot
//     (`commands/objects-on-path.ts`).
// Those two are three lines each and share nothing but the word
// "affine". Forcing them into one helper would have bought a parameter
// object and cost the ability to read either.
//
// ------------------------------------------------------- conventions
// · PAGE SPACE HAS Y DOWN (the repeat.ts convention, repeated because
//   it is the one that gets read backwards). So `tangentDeg` is
//   `atan2(dy, dx)` in DEGREES in a y-down frame: 0° points right, +90°
//   points DOWN the page.
// · A path is FLATTENED before it is measured. A cubic has no
//   closed-form arc length, so every implementation samples; this one
//   samples per segment and says how many times, rather than pretending
//   to be exact. `samplesPerSegment` is the knob and the default (24)
//   is twice the preview flattener's, because a placement error is
//   permanent artwork where a preview error is one frame.
// · A STRAIGHT segment (both inner handles collapsed onto their
//   anchors) is emitted as ONE chord, not 24 — exact, and it makes the
//   default straight-line blend spine exactly a lerp.

import type { AnchorTriple, Vec2 } from "./types";

const DEG = 180 / Math.PI;

/** One point of the flattened arc-length table. */
export interface PathStation {
  point: Vec2;
  /** Cumulative arc length from the run's start. */
  s: number;
}

/** A flattened path with its cumulative arc length — build it once,
 *  query it many times. */
export interface PathMetric {
  stations: PathStation[];
  /** Total flattened length. Zero for a degenerate run. */
  length: number;
  closed: boolean;
}

/** A point ON the path plus the direction the path is going there. */
export interface PathPoint {
  point: Vec2;
  /** Degrees, y-down: 0 = right, +90 = DOWN the page. */
  tangentDeg: number;
  /** Arc length from the start. */
  s: number;
  /** `s / length` — 0 at the start, 1 at the end. */
  u: number;
}

const isCollapsed = (a: Vec2, b: Vec2): boolean =>
  a[0] === b[0] && a[1] === b[1];

/**
 * Flatten an anchor run and accumulate its arc length. `close` walks the
 * closing segment from the last anchor back to the first.
 *
 * A run of fewer than two anchors yields a single station and a length
 * of 0 — a caller then gets that one point back for every fraction,
 * which is the honest degenerate answer (no throw).
 */
export function measureAnchorRun(
  anchors: readonly AnchorTriple[],
  options?: { close?: boolean; samplesPerSegment?: number },
): PathMetric {
  const closed = options?.close ?? false;
  const samples = Math.max(1, Math.round(options?.samplesPerSegment ?? 24));
  const n = anchors.length;
  if (n === 0) {
    return { stations: [{ point: [0, 0], s: 0 }], length: 0, closed };
  }
  const stations: PathStation[] = [
    { point: [anchors[0].anchor[0], anchors[0].anchor[1]], s: 0 },
  ];
  let s = 0;
  const push = (p: Vec2) => {
    const prev = stations[stations.length - 1].point;
    s += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    stations.push({ point: [p[0], p[1]], s });
  };
  const segmentCount = closed ? n : n - 1;
  for (let i = 0; i < segmentCount; i++) {
    const a = anchors[i];
    const b = anchors[(i + 1) % n];
    if (isCollapsed(a.right, a.anchor) && isCollapsed(b.left, b.anchor)) {
      push(b.anchor);
      continue;
    }
    for (let k = 1; k <= samples; k++) {
      const t = k / samples;
      const u = 1 - t;
      const w0 = u * u * u;
      const w1 = 3 * u * u * t;
      const w2 = 3 * u * t * t;
      const w3 = t * t * t;
      push([
        w0 * a.anchor[0] + w1 * a.right[0] + w2 * b.left[0] + w3 * b.anchor[0],
        w0 * a.anchor[1] + w1 * a.right[1] + w2 * b.left[1] + w3 * b.anchor[1],
      ]);
    }
  }
  return { stations, length: s, closed };
}

/** The straight-line metric between two points — the DEFAULT blend
 *  spine, expressed through the same kernel so nothing downstream needs
 *  a "no spine" branch. */
export function measureSegment(from: Vec2, to: Vec2): PathMetric {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return {
    stations: [
      { point: [from[0], from[1]], s: 0 },
      { point: [to[0], to[1]], s: len },
    ],
    length: len,
    closed: false,
  };
}

/** The tangent direction between two stations, in degrees (y-down). */
function tangentBetween(a: Vec2, b: Vec2): number {
  return Math.atan2(b[1] - a[1], b[0] - a[0]) * DEG;
}

/**
 * The point (and tangent) at ABSOLUTE arc length `s`. `s` is clamped to
 * `[0, length]` — a caller that wants "past the end" dropped must test
 * for it, because silently wrapping would be a different feature.
 *
 * A degenerate metric (length 0) answers its single point with a 0°
 * tangent.
 */
export function pointAtLength(metric: PathMetric, s: number): PathPoint {
  const stations = metric.stations;
  if (stations.length < 2 || !(metric.length > 0)) {
    return { point: [...stations[0].point] as Vec2, tangentDeg: 0, s: 0, u: 0 };
  }
  const want = Math.min(metric.length, Math.max(0, Number.isFinite(s) ? s : 0));
  // Binary search for the segment containing `want`.
  let lo = 0;
  let hi = stations.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (stations[mid].s <= want) lo = mid;
    else hi = mid;
  }
  const a = stations[lo];
  const b = stations[hi];
  const span = b.s - a.s;
  const t = span > 0 ? (want - a.s) / span : 0;
  return {
    point: [
      a.point[0] + (b.point[0] - a.point[0]) * t,
      a.point[1] + (b.point[1] - a.point[1]) * t,
    ],
    tangentDeg: tangentBetween(a.point, b.point),
    s: want,
    u: want / metric.length,
  };
}

/** The point at FRACTION `u` of the total length. */
export function pointAtFraction(metric: PathMetric, u: number): PathPoint {
  return pointAtLength(metric, (Number.isFinite(u) ? u : 0) * metric.length);
}

// ------------------------------------------------------- distribution

/** Where the endpoints of a COUNT distribution sit.
 *  · `inclusive` — the first slot is at the path's START and the last at
 *    its END (an open path). Objects on a path want this: a row of
 *    objects that spans the whole path.
 *  · `interior` — every slot sits strictly BETWEEN the ends, at
 *    `k / (count + 1)`. A blend wants this: the intermediates go between
 *    the two key objects, never on top of them. */
export type SlotEndpoints = "inclusive" | "interior";

/** How the slots are spaced. */
export type SlotMode = "count" | "spacing";

/** One placement slot along a path. */
export interface PathSlot extends PathPoint {
  index: number;
}

export interface DistributeArgs {
  metric: PathMetric;
  mode: SlotMode;
  /** `count` mode: how many slots. Clamped to ≥ 1. */
  count?: number;
  /** `spacing` mode: the arc-length gap between consecutive slots. A
   *  non-positive spacing yields NO slots (rather than an infinite
   *  loop). */
  spacingPt?: number;
  /** Arc length the FIRST slot is offset by — "move along path". A
   *  CLOSED path wraps it; an open path clamps. Applies to both modes. */
  startOffsetPt?: number;
  /** `count` mode only (see {@link SlotEndpoints}). */
  endpoints?: SlotEndpoints;
  /** `spacing` mode: how many slots may be produced before the walk
   *  gives up. Exists so a 0.001 pt spacing REFUSES rather than builds
   *  a million-op batch. */
  maxSlots?: number;
}

/**
 * The slots `args` asks for, in path order.
 *
 * COUNT mode divides the path:
 *   · `interior`: `k / (count + 1)` for k = 1…count — the blend lane.
 *   · `inclusive` on an OPEN path: `j / (count - 1)` for j = 0…count-1,
 *     so the first and last slots sit exactly on the ends. A count of 1
 *     puts its single slot at the START (predictable beats clever).
 *   · `inclusive` on a CLOSED path: `j / count`, because the "end" IS
 *     the start and a slot on both would be two objects in one place.
 *
 * SPACING mode walks: `startOffset + j · spacing`, stopping at the
 * path's end for an OPEN path and WRAPPING for a closed one (a closed
 * path has no end to run off; it stops after one full lap so a ring
 * cannot be paved twice).
 *
 * `startOffsetPt` shifts every slot along the path. On an open path
 * that means the tail slots can run PAST the end — they are not
 * produced, and the caller compares `slots.length` against what it
 * asked for to report the shortfall.
 */
export function distributeAlongPath(args: DistributeArgs): PathSlot[] {
  const { metric } = args;
  const offset = Number.isFinite(args.startOffsetPt)
    ? (args.startOffsetPt as number)
    : 0;
  const out: PathSlot[] = [];
  const at = (s: number, index: number): PathSlot => ({
    ...pointAtLength(metric, wrapOrClamp(metric, s)),
    index,
  });

  if (args.mode === "count") {
    const count = Math.max(1, Math.round(args.count ?? 1));
    const endpoints = args.endpoints ?? "inclusive";
    for (let j = 0; j < count; j++) {
      const u =
        endpoints === "interior"
          ? (j + 1) / (count + 1)
          : metric.closed
            ? j / count
            : count === 1
              ? 0
              : j / (count - 1);
      const s = u * metric.length + offset;
      if (!metric.closed && (s < 0 || s > metric.length + 1e-9)) continue;
      // A COUNT distribution stays well defined on a DEGENERATE path,
      // and it must: two concentric key objects give a blend a spine of
      // length ZERO, and collapsing that to one intermediate would
      // silently throw away every step of a perfectly ordinary
      // concentric blend. Every slot lands on the one point the path
      // has, and each keeps the FRACTION it was asked for — which is
      // what the caller re-parameterizes against.
      out.push({ ...at(s, j), u });
    }
    return out;
  }

  if (!(metric.length > 0)) {
    // SPACING has no meaning without length: there are no gaps to walk,
    // so there is exactly one place to be.
    return [{ ...pointAtLength(metric, 0), index: 0 }];
  }

  const spacing = args.spacingPt ?? 0;
  if (!(spacing > 0)) return out;
  const max = Math.max(1, Math.round(args.maxSlots ?? 1000));
  // A closed path stops after ONE lap; an open one at its end.
  const limit = metric.length + (metric.closed ? -1e-9 : 1e-9);
  for (let j = 0; j < max; j++) {
    const s = offset + j * spacing;
    const walked = metric.closed ? j * spacing : s;
    if (walked > limit) break;
    if (!metric.closed && s < 0) continue;
    out.push(at(s, j));
  }
  return out;
}

/** Arc length normalised into the metric: wrapped for a closed path,
 *  clamped for an open one. */
export function wrapOrClamp(metric: PathMetric, s: number): number {
  if (!(metric.length > 0)) return 0;
  if (!metric.closed) return Math.min(metric.length, Math.max(0, s));
  const m = s % metric.length;
  return m < 0 ? m + metric.length : m;
}

// ------------------------------------------------------------- easing

/** The four acceleration curves the §16.2 row's "easing" asks for.
 *  `linear` is the identity, which is what makes it the honest default:
 *  every other feature in this repo that says "the default changes
 *  nothing" can be asserted, and so can this one. */
export type EaseKind = "linear" | "easeIn" | "easeOut" | "easeInOut";

export const EASE_KINDS: readonly EaseKind[] = [
  "linear",
  "easeIn",
  "easeOut",
  "easeInOut",
];

/**
 * Ease `t ∈ [0, 1]` by `kind` at `strength ∈ [0, 1]`.
 *
 * STRENGTH IS A BLEND, not an exponent, and that is the whole point: at
 * `strength = 0` EVERY kind is the identity, so "easing strength 0" and
 * "easing linear" mean the same thing and neither can silently move
 * artwork. At `strength = 1` the curve is the full quadratic
 * accelerate / decelerate. In between it is a plain lerp between the
 * two, which keeps the map MONOTONIC — a non-monotonic ease would
 * reorder the intermediates of a blend, and that is a bug, not an
 * effect.
 */
export function ease(t: number, kind: EaseKind, strength = 1): number {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const k = Math.min(1, Math.max(0, Number.isFinite(strength) ? strength : 0));
  if (kind === "linear" || k === 0) return x;
  let curved: number;
  if (kind === "easeIn") curved = x * x;
  else if (kind === "easeOut") curved = 1 - (1 - x) * (1 - x);
  else curved = x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
  return x + (curved - x) * k;
}
