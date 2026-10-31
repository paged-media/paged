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

// WIDTH POINTS (WP6.4, engine ADR 10XX) — the live variable-width stroke
// as data: a list of `[t, width]`, `t` the arc-length fraction along each
// contour (0 its start, 1 its end), `width` the stroke's width there as a
// multiple of its weight. The engine draws it (the `widthProfile` stroke
// style); this module is what the Width tool and the profile library
// compute it with, and the overlay preview draws it.
//
// The easing between two points is the engine's (`WidthProfileParams::
// factor_at`, smoothstep), so the preview and the drawn band agree.

import type { AnchorTriple, Vec2 } from "./types";
import {
  measureAnchorRun,
  pointAtFraction,
  type PathMetric,
} from "./along-path";

/** One width point: `[t, width]`. */
export type WidthPoint = readonly [number, number];

/** The most points a profile keeps (the engine's cap). */
export const MAX_WIDTH_POINTS = 256;

/** Two points closer than this (in `t`) are one point: a drag on an
 *  existing point moves it instead of adding a neighbour. */
export const WIDTH_POINT_MERGE = 0.02;

/** The canonical list: finite, `t` clamped to 0..1, width to 0..100,
 *  sorted by `t`, at most {@link MAX_WIDTH_POINTS}. */
export function normalizeWidthPoints(
  points: readonly WidthPoint[],
): [number, number][] {
  return points
    .filter(([t, w]) => Number.isFinite(t) && Number.isFinite(w))
    .map(
      ([t, w]) =>
        [Math.min(1, Math.max(0, t)), Math.min(100, Math.max(0, w))] as [
          number,
          number,
        ],
    )
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_WIDTH_POINTS);
}

/** The width factor at `t` (1 without points): smoothstep between two
 *  points, held before the first and after the last. */
export function widthFactorAt(
  points: readonly WidthPoint[],
  t: number,
): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return 1;
  if (t <= first[0]) return first[1];
  if (t >= last[0]) return last[1];
  for (let i = 0; i + 1 < points.length; i++) {
    const [ta, wa] = points[i]!;
    const [tb, wb] = points[i + 1]!;
    if (t >= ta && t <= tb) {
      const span = tb - ta;
      if (span <= 1e-7) return wb;
      const u = (t - ta) / span;
      return wa + (wb - wa) * u * u * (3 - 2 * u);
    }
  }
  return last[1];
}

/** `points` with a point of `width` at `t`: an existing point within
 *  {@link WIDTH_POINT_MERGE} moves there, else one is added. A profile
 *  that had no points starts uniform (1 at both ends), so one dragged
 *  point bulges the stroke instead of setting all of it. */
export function withWidthPoint(
  points: readonly WidthPoint[],
  t: number,
  width: number,
): [number, number][] {
  const base: WidthPoint[] =
    points.length > 0
      ? [...points]
      : [
          [0, 1],
          [1, 1],
        ];
  const near = base.findIndex(([pt]) => Math.abs(pt - t) <= WIDTH_POINT_MERGE);
  const next =
    near >= 0
      ? base.map((p, i) => (i === near ? ([p[0], width] as WidthPoint) : p))
      : [...base, [t, width] as WidthPoint];
  return normalizeWidthPoints(next);
}

/** `points` without the point nearest `t` (within the merge distance). */
export function withoutWidthPoint(
  points: readonly WidthPoint[],
  t: number,
): [number, number][] {
  const near = points.findIndex(
    ([pt]) => Math.abs(pt - t) <= WIDTH_POINT_MERGE,
  );
  return normalizeWidthPoints(points.filter((_, i) => i !== near));
}

/** Where on a measured run `p` is nearest: the arc-length fraction, the
 *  point there, the unit left normal (y-down page) and the distance. */
export interface RunLocation {
  u: number;
  point: Vec2;
  normal: Vec2;
  distance: number;
}

export function nearestOnRun(metric: PathMetric, p: Vec2): RunLocation | null {
  const st = metric.stations;
  if (st.length < 2 || metric.length <= 0) return null;
  let best: RunLocation | null = null;
  for (let i = 0; i + 1 < st.length; i++) {
    const a = st[i]!;
    const b = st[i + 1]!;
    const dx = b.point[0] - a.point[0];
    const dy = b.point[1] - a.point[1];
    const len2 = dx * dx + dy * dy;
    if (len2 <= 0) continue;
    const f = Math.min(
      1,
      Math.max(0, ((p[0] - a.point[0]) * dx + (p[1] - a.point[1]) * dy) / len2),
    );
    const q: Vec2 = [a.point[0] + dx * f, a.point[1] + dy * f];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (!best || d < best.distance) {
      const len = Math.sqrt(len2);
      best = {
        u: (a.s + (b.s - a.s) * f) / metric.length,
        point: q,
        normal: [dy / len, -dx / len],
        distance: d,
      };
    }
  }
  return best;
}

/** The outline a profile gives a run, as ONE closed polyline (left edge
 *  out, right edge back) — the Width tool's overlay preview. */
export function widthOutlinePolyline(
  anchors: readonly AnchorTriple[],
  closed: boolean,
  weight: number,
  points: readonly WidthPoint[],
): Vec2[] {
  const metric = measureAnchorRun(anchors, { close: closed });
  if (metric.stations.length < 2 || metric.length <= 0) return [];
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  // Evenly in arc length (a straight run measures as one chord).
  const steps = 64;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const at = pointAtFraction(metric, u);
    const rad = (at.tangentDeg * Math.PI) / 180;
    const half = (weight * widthFactorAt(points, u)) / 2;
    const n: Vec2 = [Math.sin(rad) * half, -Math.cos(rad) * half];
    left.push([at.point[0] + n[0], at.point[1] + n[1]]);
    right.push([at.point[0] - n[0], at.point[1] - n[1]]);
  }
  return [...left, ...right.reverse(), left[0]!];
}

/** A width profile of the library: an id, an English name, its points. */
export interface WidthProfilePreset {
  id: string;
  name: string;
  points: readonly WidthPoint[];
}

/** The width profile library: Illustrator's uniform stroke and six
 *  profiles of the same family (a lens, tapers, a bulge, a pinch). */
export const WIDTH_PROFILE_PRESETS: readonly WidthProfilePreset[] = [
  { id: "uniform", name: "Uniform", points: [] },
  {
    id: "lens",
    name: "Lens",
    points: [
      [0, 0],
      [0.5, 1],
      [1, 0],
    ],
  },
  {
    id: "taperEnd",
    name: "Taper to the end",
    points: [
      [0, 1],
      [1, 0],
    ],
  },
  {
    id: "taperStart",
    name: "Taper from the start",
    points: [
      [0, 0],
      [1, 1],
    ],
  },
  {
    id: "bulge",
    name: "Bulge",
    points: [
      [0, 0.5],
      [0.5, 1.5],
      [1, 0.5],
    ],
  },
  {
    id: "pinch",
    name: "Pinch",
    points: [
      [0, 1],
      [0.5, 0.2],
      [1, 1],
    ],
  },
  {
    id: "teardrop",
    name: "Teardrop",
    points: [
      [0, 0],
      [0.25, 1],
      [1, 0],
    ],
  },
];

export const WIDTH_PROFILE_IDS = WIDTH_PROFILE_PRESETS.map((p) => p.id);
