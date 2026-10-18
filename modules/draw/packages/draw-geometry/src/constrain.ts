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

// Angle constraint (Shift) — snap a point to the nearest multiple of
// `stepDeg` around `origin`, preserving the distance. The pen uses it
// both for Shift-click anchor placement (45° from the previous
// anchor) and Shift-drag handle pulls.

import type { Vec2, Vec2Mut } from "./types";

const TAU = Math.PI * 2;

/** How much nearer (radians) a candidate from the other side of the
 *  ±180° cut must be before it replaces the one on the arm's own side.
 *  Two candidates that are the SAME direction (+180° and −180° for a
 *  step dividing 180°) tie exactly on paper and differ by rounding in
 *  floating point; this keeps the tie on the arm's own side, which is
 *  the answer this function has always given for such a step. */
const CUT_TIE = 1e-12;

/**
 * Snap `point` onto the nearest multiple of `stepDeg` around `origin`,
 * keeping its distance from `origin`. Angles are measured from the +x
 * axis toward +y (y-down page space: clockwise on screen).
 *
 * THE CONTRACT — which directions are candidates, and which one wins:
 *
 * · CANDIDATES. The directions `k · stepDeg` for the integers `k` with
 *   `|k| ≤ round(180° / stepDeg)`: the fan of multiples counted from the
 *   +x axis BOTH ways, out to the multiple nearest the half turn. For a
 *   step that divides 360° that is every multiple there is (45° gives
 *   the eight compass directions, 120° gives three, 72° five). For a
 *   step that does NOT divide 360° the multiples never close up — 100°
 *   generates every multiple of 20°, an irrational ratio comes
 *   arbitrarily near every direction — so "the nearest multiple" has no
 *   meaning until the set is cut off, and the fan is that cut: 100°
 *   gives 0°, ±100° and ±200° (i.e. ∓160°), with an uneven gap at the
 *   back. That fan leaves no gap wider than a step, and it is exactly
 *   the set of directions this function could always answer — what the
 *   contract settles is which of them wins.
 * · NEAREST ON THE CIRCLE. The winner is the candidate that turns the
 *   arm least, measured the short way round — so +180° and −180° are
 *   one direction, and a candidate just across the ±180° cut is as near
 *   as it looks. The arm is never turned by more than half a step.
 * · IDEMPOTENT. A point already on a candidate stays on it, for every
 *   step, so snapping twice is snapping once.
 * · NO STEP, NO CONSTRAINT. A step of 0, or one that is not a finite
 *   number, has no multiples to snap to: the point comes back unchanged
 *   (as a fresh tuple). The sign of the step is ignored. A point ON the
 *   origin has no direction and also comes back unchanged.
 */
export function constrainAngle(
  origin: Vec2,
  point: Vec2,
  stepDeg = 45,
): Vec2Mut {
  const dx = point[0] - origin[0];
  const dy = point[1] - origin[1];
  const r = Math.hypot(dx, dy);
  if (r === 0) return [point[0], point[1]];
  const step = (Math.abs(stepDeg) * Math.PI) / 180;
  if (!(step > 0) || !Number.isFinite(step)) return [point[0], point[1]];

  const angle = Math.atan2(dy, dx); // in (−π, π]
  // The candidate on the arm's own side of the cut. `|angle| ≤ π`, so
  // its index is within the fan.
  let snapped = Math.round(angle / step) * step;
  let turn = Math.abs(snapped - angle);
  // The same arm read one lap either way meets the fan's far ends — the
  // candidates that lie across the cut. Take one only if it is nearer.
  const reach = Math.round(Math.PI / step);
  for (const lap of [-TAU, TAU]) {
    const alias = angle + lap;
    const k = Math.min(reach, Math.max(-reach, Math.round(alias / step)));
    const across = Math.abs(k * step - alias);
    if (across < turn - CUT_TIE) {
      turn = across;
      snapped = k * step;
    }
  }
  return [origin[0] + r * Math.cos(snapped), origin[1] + r * Math.sin(snapped)];
}
