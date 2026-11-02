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

// THE TRANSFORM MATH of Object > Transform: the 2D affine algebra, the
// reflection, a selection's centre, and the session's LAST TRANSFORM that
// Transform Again repeats. One implementation (PM-0017): the editor's
// Reflect and Transform Again commands, its Rotate / Scale / Shear tools
// (which record what they did) and the transform-target writer all build on
// it.
//
// A record is PARAMETRIC, not a matrix: "again" re-centres it on the
// selection it is applied to (Illustrator's behaviour: a repeated reflect
// mirrors the new selection about its own centre). A reflect is its axis
// angle; every other transform (rotate, scale, shear, a mix) is its linear
// part, which is all a transform about a pivot is besides the pivot.

/** `[a, b, c, d, tx, ty]`: x' = a·x + c·y + tx, y' = b·x + d·y + ty. */
export type Affine = readonly [number, number, number, number, number, number];
/** IDML bounds, `[top, left, bottom, right]`. */
export type Bounds = readonly [number, number, number, number];
/** The 2x2 part of an affine, `[a, b, c, d]`. */
export type Linear = readonly [number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** `m ∘ n`: n first, then m. */
export function compose(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** The inverse; null when `m` is singular or not finite. */
export function invert(m: Affine): Affine | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function translate(dx: number, dy: number): Affine {
  return [1, 0, 0, 1, dx, dy];
}

export function apply(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** The axis-aligned box of `bounds` through `m`. */
export function transformBounds(bounds: Bounds, m: Affine | null): Bounds {
  if (!m) return bounds;
  const [t, l, b, r] = bounds;
  const pts = [apply(m, l, t), apply(m, r, t), apply(m, r, b), apply(m, l, b)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...ys), Math.min(...xs), Math.max(...ys), Math.max(...xs)];
}

/** Reflection about the LINE through `about` whose direction is `deg`
 *  (from +x, y down). `deg = 90` is a VERTICAL axis (a left to right flip);
 *  `deg = 0` is a HORIZONTAL axis (a top to bottom flip). */
export function reflectMatrix(
  deg: number,
  about: readonly [number, number],
): Affine {
  const r = (2 * deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const [cx, cy] = about;
  return [
    cos,
    sin,
    sin,
    -cos,
    cx - (cos * cx + sin * cy),
    cy - (sin * cx - cos * cy),
  ];
}

/** The centre of the union of `boxes`; null for none. */
export function selectionCentre(
  boxes: readonly Bounds[],
): [number, number] | null {
  if (boxes.length === 0) return null;
  let t = Infinity;
  let l = Infinity;
  let b = -Infinity;
  let r = -Infinity;
  for (const [top, left, bottom, right] of boxes) {
    t = Math.min(t, top);
    l = Math.min(l, left);
    b = Math.max(b, bottom);
    r = Math.max(r, right);
  }
  return [(l + r) / 2, (t + b) / 2];
}

// ------------------------------------------------------- the record

/** One transform Transform Again can repeat. */
export type TransformRecord =
  | {
      kind: "reflect";
      /** The mirror axis' angle, degrees from +x (y down). */
      angleDeg: number;
      /** Leave the original and transform a copy. */
      copy: boolean;
    }
  | {
      /** A rotate, scale, shear or a mix: its linear part. */
      kind: "linear";
      linear: Linear;
      copy: false;
    };

/** The spread-space matrix of `record` about `centre`. */
export function transformMatrixOf(
  record: TransformRecord,
  centre: readonly [number, number],
): Affine {
  if (record.kind === "reflect") return reflectMatrix(record.angleDeg, centre);
  const [a, b, c, d] = record.linear;
  const [cx, cy] = centre;
  return [a, b, c, d, cx - (a * cx + c * cy), cy - (b * cx + d * cy)];
}

/** How far a linear part may sit from the identity and still be "nothing
 *  happened" (a click, a zero drag). */
const NOTHING = 1e-6;

/**
 * The linear part of the transform that took an item from `before` to
 * `after` (their stored or page-space matrices, null = identity): the 2x2 of
 * `after ∘ before⁻¹`. Null when `before` cannot be inverted or the change
 * is no change. A rotate, scale or shear about any pivot has the same linear
 * part for every item it moved.
 */
export function linearChange(
  before: Affine | null,
  after: Affine | null,
): Linear | null {
  const inv = invert(before ?? IDENTITY);
  if (!inv) return null;
  const m = compose(after ?? IDENTITY, inv);
  const same =
    Math.abs(m[0] - 1) < NOTHING &&
    Math.abs(m[1]) < NOTHING &&
    Math.abs(m[2]) < NOTHING &&
    Math.abs(m[3] - 1) < NOTHING;
  return same ? null : [m[0], m[1], m[2], m[3]];
}

// ------------------------------------------------------- the memory

/** The last transform of ONE session (one editor: the editor keeps one per
 *  scope). Session state, like Illustrator's; never the document's. */
export interface TransformMemory {
  /** Remember `record` (by value) as the last transform. */
  remember(record: TransformRecord): void;
  /** The last transform, or null. */
  last(): TransformRecord | null;
  /** Forget it. */
  forget(): void;
}

const copy = (r: TransformRecord): TransformRecord =>
  r.kind === "reflect"
    ? { ...r }
    : {
        kind: "linear",
        linear: [...r.linear] as unknown as Linear,
        copy: false,
      };

export function createTransformMemory(): TransformMemory {
  let last: TransformRecord | null = null;
  return {
    remember(record) {
      last = copy(record);
    },
    last: () => (last ? copy(last) : null),
    forget() {
      last = null;
    },
  };
}
