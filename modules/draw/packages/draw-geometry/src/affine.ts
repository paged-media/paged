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

// 2D affine helpers for itemTransform handling — `[a, b, c, d, tx,
// ty]` column-major pairs, the IDML/engine convention. Anchor tables
// live in the path's local frame; click points arrive page-local, so
// anchor-edit planning inverse-applies the element's transform first.

import type { Vec2, Vec2Mut } from "./types";

export type Affine = readonly [number, number, number, number, number, number];

export function applyAffine(m: Affine | null, x: number, y: number): Vec2Mut {
  if (!m) return [x, y];
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Inverse-apply; returns null when the matrix is singular. */
export function inverseApplyAffine(
  m: Affine | null,
  x: number,
  y: number,
): Vec2Mut | null {
  if (!m) return [x, y];
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  const px = x - m[4];
  const py = y - m[5];
  return [(m[3] * px - m[2] * py) / det, (-m[1] * px + m[0] * py) / det];
}

/** Compose two affines (`outer ∘ inner` — apply `inner` first, then
 *  `outer`). Both in the `[a, b, c, d, tx, ty]` column-pair convention. */
export function composeAffine(outer: Affine, inner: Affine): Affine {
  const [a1, b1, c1, d1, e1, f1] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/** The inverse matrix (`composeAffine(invertAffine(m), m)` is the
 *  identity); null when `m` is singular or not finite — the same rule as
 *  `inverseApplyAffine`. */
export function invertAffine(m: Affine): Affine | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** The identity affine. */
export const IDENTITY_AFFINE: Affine = [1, 0, 0, 1, 0, 0];

/** Scale factor the transform applies to lengths (uniform-ish
 *  approximation: average of the basis-vector norms). Used to keep
 *  pick tolerances meaningful in transformed local space. */
export function affineScale(m: Affine | null): number {
  if (!m) return 1;
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  const s = (sx + sy) / 2;
  return s > 0 ? s : 1;
}

export type { Vec2 };

/** The least-squares affine that maps `src[i]` onto `dst[i]` (at least
 *  three points not on one line); null when the points cannot determine
 *  one. Solves the normal equations of `[x y 1] · [a c e; b d f]ᵀ` once
 *  per output coordinate. */
export function fitAffine(
  src: readonly Vec2[],
  dst: readonly Vec2[],
): Affine | null {
  const n = Math.min(src.length, dst.length);
  if (n < 3) return null;
  // Centre both sets for conditioning.
  let sx = 0;
  let sy = 0;
  let tx = 0;
  let ty = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i]![0];
    sy += src[i]![1];
    tx += dst[i]![0];
    ty += dst[i]![1];
  }
  sx /= n;
  sy /= n;
  tx /= n;
  ty /= n;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  let xu = 0;
  let yu = 0;
  let xv = 0;
  let yv = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i]![0] - sx;
    const y = src[i]![1] - sy;
    const u = dst[i]![0] - tx;
    const v = dst[i]![1] - ty;
    xx += x * x;
    xy += x * y;
    yy += y * y;
    xu += x * u;
    yu += y * u;
    xv += x * v;
    yv += y * v;
  }
  const det = xx * yy - xy * xy;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9 * Math.max(1, xx * yy))
    return null;
  const a = (xu * yy - yu * xy) / det;
  const c = (yu * xx - xu * xy) / det;
  const b = (xv * yy - yv * xy) / det;
  const d = (yv * xx - xv * xy) / det;
  return [a, b, c, d, tx - a * sx - c * sy, ty - b * sx - d * sy];
}
