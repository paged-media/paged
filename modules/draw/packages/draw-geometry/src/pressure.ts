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

// Pressure → stroke-width math (B-08, §13.12 Tier B). Pure, zero-dep:
// a draw tool turns a per-sample Pointer-Events pressure (0..1) into a
// stroke width in pt, the width PROFILE the engine's variable-width
// outline op (`OutlineStrokeVariable`) consumes. Lives here in
// draw-geometry — not draw-tools — because it is host-free math the
// editor's built-in Pencil re-imports across the same D1 seam as
// `simplifyRdp` (its only plugin-draw value dependency), keeping a
// single unit-tested source for both the paged.draw machines and the
// editor consumer.

/** Neutral pressure a non-pressure device (a mouse) reports / we assume
 *  for a synthetic sample — mid-range, so a mouse-drawn path lands at a
 *  sensible constant width without special-casing. */
export const NEUTRAL_PRESSURE = 0.5;

/** Clamp a raw pressure sample into the Pointer-Events 0..1 range
 *  (defensive against a misbehaving device / a non-finite value). */
export function clampPressure(p: number): number {
  if (!Number.isFinite(p)) return NEUTRAL_PRESSURE;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/** Linear stroke-width ramp: `min` pt at pressure 0, `max` pt at 1. */
export interface StrokeWidthProfile {
  /** Width at pressure 0, pt. */
  min: number;
  /** Width at pressure 1, pt. */
  max: number;
}

/**
 * Map a normalized pressure (0..1) to a stroke width in pt by linear
 * interpolation between `profile.min` and `profile.max`. A mouse's
 * constant `0.5` lands mid-range.
 */
export function strokeWidthFromPressure(
  pressure: number,
  profile: StrokeWidthProfile,
): number {
  const p = clampPressure(pressure);
  return profile.min + (profile.max - profile.min) * p;
}
