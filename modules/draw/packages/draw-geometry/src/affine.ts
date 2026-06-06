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
