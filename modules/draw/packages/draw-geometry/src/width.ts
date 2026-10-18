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

// Width-tool profile math (wave 2) — the per-anchor width array the
// engine's `outlineStrokeVariable` op consumes (stops distributed
// uniformly over the centerline's arc length by index — see the
// ENGINE NOTE in draw-bundle handlers/brush.ts). Pure, zero-dep.

/**
 * A per-anchor width profile PEAKED at one anchor with a linear
 * falloff over its neighbors:
 *
 *   width(i) = base + (peak − base) · max(0, 1 − |i − peakIndex| / falloff)
 *
 * `falloff` is the neighbor distance (in anchors) at which the profile
 * has fully decayed back to `base` (clamped to ≥ 1); `peakIndex` is
 * clamped into range. `peakWidth` below `base` thins instead of
 * bulging — allowed. Outputs are floored at 0 (the outline kernel
 * gets no negative stop). `count ≤ 0` or non-finite input yields `[]`.
 */
export function peakedWidthProfile(
  count: number,
  peakIndex: number,
  peakWidth: number,
  baseWidth: number,
  falloff = 2,
): number[] {
  if (
    !Number.isFinite(count) ||
    !Number.isFinite(peakIndex) ||
    !Number.isFinite(peakWidth) ||
    !Number.isFinite(baseWidth) ||
    !Number.isFinite(falloff)
  ) {
    return [];
  }
  const n = Math.floor(count);
  if (n <= 0) return [];
  const peak = Math.min(n - 1, Math.max(0, Math.round(peakIndex)));
  const decay = Math.max(1, falloff);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const influence = Math.max(0, 1 - Math.abs(i - peak) / decay);
    out.push(Math.max(0, baseWidth + (peakWidth - baseWidth) * influence));
  }
  return out;
}
