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

// Snapping for drawing tools (RFI C-68, the plugin-side route).
//
// The engine snaps only its own translate gesture, against page and
// sibling edges. Drawing tools — the Pen, Direct Selection, Curvature,
// Measure — place POINTS, and the useful targets are other points: the
// anchors of nearby paths, the page's edges and centre, ruler guides.
// All of those are readable through doors a plugin already has
// (`pathAnchors`, the page size, the guides collection), so the snapper
// is pure geometry over a candidate list the host gathers once per
// gesture. It is applied to the pointer BEFORE a machine sees it, so the
// machines stay unaware of it.
//
// Precedence, Illustrator's: a POINT wins outright (the pointer lands
// exactly on it); otherwise the x and y axes snap INDEPENDENTLY to the
// nearest alignment line within tolerance (smart guides: "in line with
// that anchor"); otherwise the nearest point ON a segment. Tolerance is
// in the same page-local units as the pointer (the host converts screen
// pixels at the current zoom).

import type { Vec2 } from "./types";

export type SnapTarget =
  | { kind: "point"; at: Vec2; tag?: string }
  /** A vertical alignment line x = `x`. */
  | { kind: "x"; x: number; tag?: string }
  /** A horizontal alignment line y = `y`. */
  | { kind: "y"; y: number; tag?: string }
  | { kind: "segment"; a: Vec2; b: Vec2; tag?: string };

export interface SnapResult {
  /** The pointer after snapping (the input when nothing snapped). */
  point: Vec2;
  /** The point target it landed on, if any. */
  point_target: SnapTarget | null;
  /** The alignment lines it was pulled onto, per axis — what a host
   *  draws as smart guides. */
  x_target: SnapTarget | null;
  y_target: SnapTarget | null;
  /** The segment it landed on, if any. */
  segment_target: SnapTarget | null;
}

const none = (p: Vec2): SnapResult => ({
  point: [p[0], p[1]],
  point_target: null,
  x_target: null,
  y_target: null,
  segment_target: null,
});

/** The closest point to `p` on segment ab. */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return [a[0], a[1]];
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + t * dx, a[1] + t * dy];
}

/** Snap `p` against `targets` within `tolerance`. Pure; never throws.
 *  A non-finite or non-positive tolerance snaps nothing. */
export function snapPoint(
  p: Vec2,
  targets: readonly SnapTarget[],
  tolerance: number,
): SnapResult {
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) return none(p);
  // 1. points — the nearest within tolerance wins outright.
  let best: { t: SnapTarget; d: number } | null = null;
  for (const t of targets) {
    if (t.kind !== "point") continue;
    const d = Math.hypot(t.at[0] - p[0], t.at[1] - p[1]);
    if (d <= tolerance && (!best || d < best.d)) best = { t, d };
  }
  if (best && best.t.kind === "point") {
    return { ...none(best.t.at), point_target: best.t };
  }
  // 2. alignment lines, each axis on its own.
  let bx: { t: SnapTarget; d: number } | null = null;
  let by: { t: SnapTarget; d: number } | null = null;
  for (const t of targets) {
    if (t.kind === "x") {
      const d = Math.abs(t.x - p[0]);
      if (d <= tolerance && (!bx || d < bx.d)) bx = { t, d };
    } else if (t.kind === "y") {
      const d = Math.abs(t.y - p[1]);
      if (d <= tolerance && (!by || d < by.d)) by = { t, d };
    }
  }
  if (bx || by) {
    const x = bx && bx.t.kind === "x" ? bx.t.x : p[0];
    const y = by && by.t.kind === "y" ? by.t.y : p[1];
    return {
      ...none([x, y]),
      x_target: bx ? bx.t : null,
      y_target: by ? by.t : null,
    };
  }
  // 3. segments — the nearest point on the nearest segment.
  let bs: { t: SnapTarget; d: number; at: Vec2 } | null = null;
  for (const t of targets) {
    if (t.kind !== "segment") continue;
    const at = closestOnSegment(p, t.a, t.b);
    const d = Math.hypot(at[0] - p[0], at[1] - p[1]);
    if (d <= tolerance && (!bs || d < bs.d)) bs = { t, d, at };
  }
  if (bs) return { ...none(bs.at), segment_target: bs.t };
  return none(p);
}

/** Candidate targets from a set of anchor points: each point itself,
 *  plus its x and y alignment lines (smart guides). Duplicate lines are
 *  merged, so a grid of aligned anchors yields one line per row. */
export function anchorTargets(
  points: readonly Vec2[],
  tag = "anchor",
): SnapTarget[] {
  const out: SnapTarget[] = [];
  const xs = new Set<number>();
  const ys = new Set<number>();
  for (const p of points) {
    out.push({ kind: "point", at: [p[0], p[1]], tag });
    xs.add(p[0]);
    ys.add(p[1]);
  }
  for (const x of xs) out.push({ kind: "x", x, tag });
  for (const y of ys) out.push({ kind: "y", y, tag });
  return out;
}

/** Candidate targets for a page of `width` × `height` (page-local, origin
 *  top-left): its corners and centre as points, its edges and centre
 *  lines as alignment lines. */
export function pageTargets(width: number, height: number): SnapTarget[] {
  const tag = "page";
  const corners: Vec2[] = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
    [width / 2, height / 2],
  ];
  return [
    ...corners.map((at): SnapTarget => ({ kind: "point", at, tag })),
    { kind: "x", x: 0, tag },
    { kind: "x", x: width / 2, tag },
    { kind: "x", x: width, tag },
    { kind: "y", y: 0, tag },
    { kind: "y", y: height / 2, tag },
    { kind: "y", y: height, tag },
  ];
}
