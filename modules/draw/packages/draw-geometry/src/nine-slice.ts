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

// 9-SLICE SCALING (engine ADR 1039, draw ADR 365) — the mapping the
// engine's renderer applies to a scaled symbol instance whose definition
// (or the instance itself) carries guides, as a pure function: the
// overlay draws the guides where the engine draws the cuts, and the
// Illustrator oracle (`test/oracle/nine-slice.spec.ts`) checks it.
//
// Guides are four INSETS `[left, top, right, bottom]` from the
// definition's box, in definition space. The instance matrix's column
// lengths are its scale (`sx`, `sy`); the corners keep their size, the
// edge regions stretch along their own axis, the centre in both, and what
// the matrix holds besides its scale (rotation, translation) places the
// result. At its own size an instance is not sliced.

import type { Affine } from "./affine";
import type { Vec2 } from "./types";

export type NineSliceInsets = readonly [number, number, number, number];

/** The scale the engine reads off an instance matrix. */
export function nineSliceScale(m: Affine): [number, number] {
  return [Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3])];
}

/** Whether the engine slices an instance with this matrix. */
export function nineSliceApplies(m: Affine): boolean {
  const [sx, sy] = nineSliceScale(m);
  return (
    (Math.abs(sx - 1) > 1e-4 || Math.abs(sy - 1) > 1e-4) &&
    sx > 1e-6 &&
    sy > 1e-6
  );
}

/** One axis: the source cuts and where they land at `scale`. */
function axis(
  lo: number,
  hi: number,
  a: number,
  b: number,
  scale: number,
): {
  src: [number, number, number, number];
  dst: [number, number, number, number];
} {
  const size = hi - lo;
  const mid = Math.max(0, size * scale - a - b);
  const t0 = lo * scale;
  return {
    src: [lo, lo + a, hi - b, hi],
    dst: [t0, t0 + a, t0 + a + mid, t0 + a + mid + b],
  };
}

function mapAxis(
  v: number,
  src: readonly number[],
  dst: readonly number[],
): number {
  // The region the value falls in (outside the box: the outer region).
  const col = v < src[1]! ? 0 : v < src[2]! ? 1 : 2;
  const s0 = src[col]!;
  const s1 = src[col + 1]!;
  const d0 = dst[col]!;
  const d1 = dst[col + 1]!;
  if (s1 - s0 <= 1e-9) return d0 + (v - s0);
  return d0 + ((v - s0) * (d1 - d0)) / (s1 - s0);
}

/** `p` (definition space) under an instance with `matrix` sliced by
 *  `insets` over `box` `[x0, y0, x1, y1]`: where the engine draws it. An
 *  instance at its own size maps through its matrix unchanged. */
export function nineSlicePoint(
  p: Vec2,
  box: readonly [number, number, number, number],
  insets: NineSliceInsets,
  matrix: Affine,
): Vec2 {
  const [x, y] = p;
  if (!nineSliceApplies(matrix)) {
    const m = matrix;
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }
  const [sx, sy] = nineSliceScale(matrix);
  const [l, t, r, b] = insets;
  const ax = axis(box[0], box[2], l, r, sx);
  const ay = axis(box[1], box[3], t, b, sy);
  const u = mapAxis(x, ax.src, ax.dst);
  const v = mapAxis(y, ay.src, ay.dst);
  const m = matrix;
  // The matrix without its scale places the sliced result.
  const a = m[0] / sx;
  const bb = m[1] / sx;
  const c = m[2] / sy;
  const d = m[3] / sy;
  return [a * u + c * v + m[4], bb * u + d * v + m[5]];
}

/** The four guides of an instance on the page, as drawn: `[from, to]`
 *  segments across the instance's box, left, top, right, bottom. */
export function nineSliceGuides(
  box: readonly [number, number, number, number],
  insets: NineSliceInsets,
  matrix: Affine,
): [Vec2, Vec2][] {
  const [x0, y0, x1, y1] = box;
  const [l, t, r, b] = insets;
  const at = (x: number, y: number) =>
    nineSlicePoint([x, y], box, insets, matrix);
  return [
    [at(x0 + l, y0), at(x0 + l, y1)],
    [at(x0, y0 + t), at(x1, y0 + t)],
    [at(x1 - r, y0), at(x1 - r, y1)],
    [at(x0, y1 - b), at(x1, y1 - b)],
  ];
}

/** Insets clamped to the box: each ≥ 0, and each opposite pair leaving
 *  at least `minCentre` between them. */
export function clampNineSlice(
  box: readonly [number, number, number, number],
  insets: NineSliceInsets,
  minCentre = 0,
): [number, number, number, number] {
  const w = Math.max(0, box[2] - box[0]);
  const h = Math.max(0, box[3] - box[1]);
  const pair = (a: number, b: number, size: number): [number, number] => {
    const room = Math.max(0, size - minCentre);
    const ca = Math.min(Math.max(0, a), room);
    const cb = Math.min(Math.max(0, b), room - ca);
    return [ca, cb];
  };
  const [l, r] = pair(insets[0], insets[2], w);
  const [t, b] = pair(insets[1], insets[3], h);
  return [l, t, r, b];
}

/** Default guides: a quarter of the box from each side (a convention —
 *  a new Illustrator symbol reports no grid to a script, `[0, 0, 0, 0]`). */
export function defaultNineSlice(
  box: readonly [number, number, number, number],
): [number, number, number, number] {
  const w = Math.max(0, box[2] - box[0]) / 4;
  const h = Math.max(0, box[3] - box[1]) / 4;
  return [w, h, w, h];
}

/** Which guide: left, top, right, bottom. */
export type NineSliceGuide = 0 | 1 | 2 | 3;

/** The guide nearest `p` (page) within `tolerance`, or null. */
export function nineSliceGuideAt(
  p: Vec2,
  box: readonly [number, number, number, number],
  insets: NineSliceInsets,
  matrix: Affine,
  tolerance: number,
): NineSliceGuide | null {
  let best: NineSliceGuide | null = null;
  let bestD = tolerance;
  nineSliceGuides(box, insets, matrix).forEach(([a, b], i) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t =
      l2 === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2),
          );
    const d = Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
    if (d <= bestD) {
      bestD = d;
      best = i as NineSliceGuide;
    }
  });
  return best;
}

/** The insets with `guide` dragged to `p` (page): the pointer read in the
 *  instance's own unscaled frame, where a guide sits at its inset from
 *  the scaled box's edge (the corners keep their size). Clamped to the
 *  definition's box. */
export function nineSliceDrag(
  guide: NineSliceGuide,
  p: Vec2,
  box: readonly [number, number, number, number],
  insets: NineSliceInsets,
  matrix: Affine,
): [number, number, number, number] {
  const [sx, sy] = nineSliceScale(matrix);
  const a = matrix[0] / sx;
  const b = matrix[1] / sx;
  const c = matrix[2] / sy;
  const d = matrix[3] / sy;
  const det = a * d - b * c;
  const px = p[0] - matrix[4];
  const py = p[1] - matrix[5];
  const u = det === 0 ? px : (d * px - c * py) / det;
  const v = det === 0 ? py : (-b * px + a * py) / det;
  const next: [number, number, number, number] = [...insets] as [
    number,
    number,
    number,
    number,
  ];
  if (guide === 0) next[0] = u - box[0] * sx;
  else if (guide === 1) next[1] = v - box[1] * sy;
  else if (guide === 2) next[2] = box[2] * sx - u;
  else next[3] = box[3] * sy - v;
  // Keep the dragged guide inside, the others as they were.
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  next[0] = Math.min(Math.max(0, next[0]), w - next[2]);
  next[2] = Math.min(Math.max(0, next[2]), w - next[0]);
  next[1] = Math.min(Math.max(0, next[1]), h - next[3]);
  next[3] = Math.min(Math.max(0, next[3]), h - next[1]);
  return next;
}
