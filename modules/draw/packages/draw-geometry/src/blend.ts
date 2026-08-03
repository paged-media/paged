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

// Blend interpolation math (wave 2) — the pure half of the
// blendSelected command: anchor-run interpolation between two paths
// with MATCHING anchor counts, and the sRGB colour lerp its fill
// interpolation uses. Pure, zero-dep.

import type { AnchorTriple } from "./types";
import type { Rgb } from "./svg-color";

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Linear interpolation between two anchor runs at parameter `t`
 * (0 = `a`, 1 = `b`): each triple's anchor AND both handles lerp
 * componentwise, so straight segments stay straight and curved
 * handles morph continuously. The runs must have the SAME length —
 * a mismatch answers `[]` (the caller's honest-diagnostic cue), never
 * a throw. `t` is not clamped (extrapolation is the caller's choice).
 */
export function interpolateAnchors(
  a: readonly AnchorTriple[],
  b: readonly AnchorTriple[],
  t: number,
): AnchorTriple[] {
  if (a.length !== b.length || !Number.isFinite(t)) return [];
  const out: AnchorTriple[] = [];
  for (let i = 0; i < a.length; i++) {
    const pa = a[i];
    const pb = b[i];
    out.push({
      anchor: [lerp(pa.anchor[0], pb.anchor[0], t), lerp(pa.anchor[1], pb.anchor[1], t)],
      left: [lerp(pa.left[0], pb.left[0], t), lerp(pa.left[1], pb.left[1], t)],
      right: [lerp(pa.right[0], pb.right[0], t), lerp(pa.right[1], pb.right[1], t)],
    });
  }
  return out;
}

/** Componentwise sRGB lerp (rounded, clamped 0..255) — the blend
 *  command's fill interpolation. `t` clamps to 0..1. */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const tt = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const mix = (x: number, y: number): number =>
    Math.max(0, Math.min(255, Math.round(x + (y - x) * tt)));
  return [mix(a[0], b[0]), mix(a[1], b[1]), mix(a[2], b[2])];
}
