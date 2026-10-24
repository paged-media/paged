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

// SAME SHAPE — the geometry test behind Global Edit (Illustrator's
// "select objects whose geometry matches this one").
//
// Two anchor tables are the SAME SHAPE when they have the same contour
// structure (anchor count, contour boundaries, open flags) and every
// control point — anchor AND both handles — sits within `tolerance` pt of
// its partner once both are moved to a common origin (the lower-left of
// their control-point box, so POSITION never matters). With `anySize`,
// both are first scaled uniformly to a unit box and `tolerance` is read
// against the REFERENCE's size, so a copy scaled up or down still matches;
// without it the sizes must agree too.
//
// What is deliberately NOT matched: a rotated, skewed or mirrored copy
// (Illustrator's Global Edit does not match those either), and a closed
// contour that is the same outline walked in the OPPOSITE direction. A
// closed single-contour path that only STARTS at a different anchor does
// match — a drawn rectangle and a duplicated one need not agree on which
// corner is first.

import type { AnchorTable, AnchorTriple, Vec2 } from "./types";

/** How two shapes are compared. */
export interface SameShapeOptions {
  /** Largest per-point distance that still counts as the same (pt,
   *  inclusive, Chebyshev). Default {@link SAME_SHAPE_TOLERANCE}. */
  tolerance?: number;
  /** Match a uniformly scaled copy too. Default false. */
  anySize?: boolean;
}

/** The default per-point slack (pt): round-tripped floats, nothing more. */
export const SAME_SHAPE_TOLERANCE = 0.01;

/** Above this many anchors a closed contour is compared from its own
 *  start only (the start-shift search is quadratic). */
export const SAME_SHAPE_SHIFT_LIMIT = 512;

/** A table's contour structure: one `[start, end, open]` per contour. */
function contoursOf(t: AnchorTable): [number, number, boolean][] {
  const starts = t.subpathStarts.length > 0 ? t.subpathStarts : [0];
  return starts.map((from, i) => [
    from,
    i + 1 < starts.length ? starts[i + 1]! : t.anchors.length,
    t.subpathOpen?.[i] ?? false,
  ]);
}

/** The box of every control point: `[minX, minY, maxX, maxY]`. */
function boxOf(
  anchors: readonly AnchorTriple[],
): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const a of anchors) {
    for (const p of [a.anchor, a.left, a.right]) {
      if (p[0] < x0) x0 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[0] > x1) x1 = p[0];
      if (p[1] > y1) y1 = p[1];
    }
  }
  return [x0, y0, x1, y1];
}

/** The structural key two tables must share before any point is
 *  compared — cheap, so a caller can bucket a document by it. */
export function shapeStructureKey(t: AnchorTable): string {
  return contoursOf(t)
    .map(([from, to, open]) => `${to - from}${open ? "o" : "c"}`)
    .join(",");
}

/** Do `a` and `b` describe the same shape (see the module header)? Pure. */
export function sameShape(
  a: AnchorTable,
  b: AnchorTable,
  options: SameShapeOptions = {},
): boolean {
  const n = a.anchors.length;
  if (n === 0 || n !== b.anchors.length) return false;
  if (shapeStructureKey(a) !== shapeStructureKey(b)) return false;
  const tolerance =
    typeof options.tolerance === "number" &&
    Number.isFinite(options.tolerance) &&
    options.tolerance >= 0
      ? options.tolerance
      : SAME_SHAPE_TOLERANCE;

  const ba = boxOf(a.anchors);
  const bb = boxOf(b.anchors);
  const sizeA = Math.max(ba[2] - ba[0], ba[3] - ba[1]);
  const sizeB = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
  // Both tables into one frame: origin at the box's corner; with
  // `anySize`, b is scaled onto a's size, so the tolerance stays in a's pt.
  let k = 1;
  if (options.anySize) {
    if (sizeA === 0 || sizeB === 0) {
      if (sizeA !== sizeB) return false;
    } else {
      k = sizeA / sizeB;
    }
  }
  const pa = (p: Vec2): [number, number] => [p[0] - ba[0], p[1] - ba[1]];
  const pb = (p: Vec2): [number, number] => [
    (p[0] - bb[0]) * k,
    (p[1] - bb[1]) * k,
  ];
  const near = (p: Vec2, q: Vec2): boolean => {
    const u = pa(p);
    const v = pb(q);
    return (
      Math.abs(u[0] - v[0]) <= tolerance + 1e-9 &&
      Math.abs(u[1] - v[1]) <= tolerance + 1e-9
    );
  };
  const tripleNear = (x: AnchorTriple, y: AnchorTriple): boolean =>
    near(x.anchor, y.anchor) && near(x.left, y.left) && near(x.right, y.right);

  const matchFrom = (shift: number): boolean => {
    for (let i = 0; i < n; i++) {
      if (!tripleNear(a.anchors[i]!, b.anchors[(i + shift) % n]!)) {
        return false;
      }
    }
    return true;
  };
  if (matchFrom(0)) return true;
  // A closed single contour may start at another anchor.
  const contours = contoursOf(a);
  if (contours.length !== 1 || contours[0]![2] || n > SAME_SHAPE_SHIFT_LIMIT) {
    return false;
  }
  for (let shift = 1; shift < n; shift++) {
    if (matchFrom(shift)) return true;
  }
  return false;
}
