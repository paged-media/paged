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

// Calligraphic brush-width math (brush tools v0). Pure, zero-dep — the
// same host-free tier as pressure.ts: a brush machine turns a stroke's
// local TANGENT ANGLE + a fixed NIB + a per-sample pressure into the
// per-anchor width stops the engine's variable-width outline op
// (`outlineStrokeVariable`) sweeps into a filled shape.
//
// The model — a flat calligraphic nib is a thin bar of length `size`
// held at the fixed angle θ:
//
//   · moving the pen PERPENDICULAR to the bar paints the bar's full
//     length → maximum width `size`;
//   · moving ALONG the bar paints only the bar's thickness →
//     minimum width `roundness · size`;
//   · in between, the deposited width follows |sin(tangent − θ)|.
//
//   width(tangent, p) = size · (r + (1 − r)·|sin(tangent − θ)|) · 2·p
//
// with r = roundness and p the clamped Pointer-Events pressure. The
// pressure factor is 2·p so a mouse's constant NEUTRAL_PRESSURE (0.5)
// lands exactly at the un-scaled model width (factor 1), full pressure
// doubles it, and a zero-pressure sample floors at
// MIN_BRUSH_WIDTH_RATIO·size (never a zero-width stop — the outline
// kernel would collapse the sweep there).

import { clampPressure, NEUTRAL_PRESSURE } from "./pressure";
import type { AnchorTriple } from "./types";

const EPS = 1e-9;

/** A calligraphic nib: a flat bar of length `size` (pt) held at the
 *  fixed `angle` (radians, from +x toward +y), with `roundness` the
 *  thickness-to-length ratio (0 = an ideal razor nib, 1 = a round nib —
 *  angle-independent width). */
export interface NibProfile {
  /** Nib angle in radians (from +x toward +y). */
  angle: number;
  /** Thickness-to-length ratio, clamped to 0..1. 1 = round nib. */
  roundness: number;
  /** Full nib width in pt (the width painted perpendicular to the nib
   *  at neutral pressure). */
  size: number;
}

/** Floor on the width a stop may reach, as a fraction of `size` — a
 *  zero-pressure / razor-edge sample still deposits a hairline instead
 *  of a zero-width stop the outline kernel would collapse. */
export const MIN_BRUSH_WIDTH_RATIO = 0.05;

/**
 * The calligraphic width deposited at one sample: the stroke's local
 * `tangentAngle` (radians) against the nib, scaled by pressure.
 * Absent pressure = NEUTRAL_PRESSURE (a mouse) → the un-scaled model
 * width. Non-positive / non-finite `size` yields 0.
 */
export function calligraphicWidth(
  tangentAngle: number,
  nib: NibProfile,
  pressure: number = NEUTRAL_PRESSURE,
): number {
  const size = Number.isFinite(nib.size) && nib.size > 0 ? nib.size : 0;
  if (size === 0) return 0;
  const r = Number.isFinite(nib.roundness)
    ? Math.min(1, Math.max(0, nib.roundness))
    : 1;
  const anisotropy = r + (1 - r) * Math.abs(Math.sin(tangentAngle - nib.angle));
  const pressureFactor = 2 * clampPressure(pressure); // neutral 0.5 → 1
  const width = size * anisotropy * pressureFactor;
  return Math.max(width, size * MIN_BRUSH_WIDTH_RATIO);
}

/**
 * The stroke's tangent angle (radians) at anchor `index` of a committed
 * run. A smooth (Catmull-Rom-fitted) anchor carries its true tangent in
 * the handles — the `left → right` chord; a corner anchor (collapsed
 * handles) falls back to the neighbor central difference (wrapping when
 * `closed`, one-sided at open endpoints). A degenerate run answers 0.
 */
export function anchorTangentAngle(
  anchors: readonly AnchorTriple[],
  index: number,
  closed = false,
): number {
  const a = anchors[index];
  if (!a) return 0;
  const hx = a.right[0] - a.left[0];
  const hy = a.right[1] - a.left[1];
  if (Math.hypot(hx, hy) > EPS) return Math.atan2(hy, hx);
  const n = anchors.length;
  if (n < 2) return 0;
  const prev =
    index > 0 ? anchors[index - 1] : closed ? anchors[n - 1] : anchors[index];
  const next =
    index < n - 1 ? anchors[index + 1] : closed ? anchors[0] : anchors[index];
  const dx = next.anchor[0] - prev.anchor[0];
  const dy = next.anchor[1] - prev.anchor[1];
  if (Math.hypot(dx, dy) <= EPS) return 0;
  return Math.atan2(dy, dx);
}
