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

// FLARE and the regular polygon — the geometry that is parametric. Pure;
// page-space pt, angles in DEGREES from +x toward +y (y down), what the
// tools and the typed commands speak. (The star's geometry is the host's:
// `@paged-media/helpers`' `star`.)
//
// A FLARE is Illustrator's four parts: a filled CENTRE, a larger HALO
// around it, RAYS from the centre, and RINGS strung along the line from
// the centre to the flare's end point. Ray lengths and ring sizes vary
// the way Illustrator's do, but from a seeded generator, so the same
// parameters always give the same flare (a test can pin it; a redo
// replays it).

import type { AnchorTable, AnchorTriple, Vec2 } from "./types";
import { ellipseToPath, lineToPath } from "./svg-shapes";

const corner = (x: number, y: number): AnchorTriple => ({
  anchor: [x, y],
  left: [x, y],
  right: [x, y],
});

/** A regular polygon (`sides` corners on `radius`, first corner up) —
 *  the Shaper's polygon. */
export function regularPolygonPath(
  cx: number,
  cy: number,
  radius: number,
  sides: number,
  rotationDeg = 0,
): AnchorTable {
  const n = Math.max(3, Math.round(sides));
  const base = (rotationDeg - 90) * (Math.PI / 180);
  const anchors: AnchorTriple[] = [];
  for (let i = 0; i < n; i++) {
    const a = base + (i * 2 * Math.PI) / n;
    anchors.push(corner(cx + radius * Math.cos(a), cy + radius * Math.sin(a)));
  }
  return { anchors, subpathStarts: [0], subpathOpen: [false] };
}

// ---------------------------------------------------------------- flare

export interface FlareSpec {
  cx: number;
  cy: number;
  /** pt — the centre disc's radius. */
  centreRadius: number;
  /** The halo's radius as a multiple of the centre's (Illustrator's
   *  "Growth"-free halo; > 1). */
  haloScale: number;
  /** Ray count; 0 = no rays. */
  rays: number;
  /** pt — the longest ray. */
  rayLength: number;
  /** Ring count; 0 = no rings. */
  rings: number;
  /** pt — the rings run from the centre to this point. */
  end: Vec2;
  /** pt — the largest ring's radius. */
  ringRadius: number;
  /** The generator's seed (same seed, same flare). */
  seed?: number;
}

export interface FlareParts {
  centre: AnchorTable;
  halo: AnchorTable;
  rays: AnchorTable[];
  rings: AnchorTable[];
}

/** The Numerical Recipes LCG — deterministic "random" in `[0, 1)`
 *  (shared with the Symbol Sprayer's scatter, `symbolism.ts`). */
export function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Flare count ceilings — a typo is not data. */
export const FLARE_MAX_RAYS = 200;
export const FLARE_MAX_RINGS = 50;

/** The four parts of a flare (see the module header). Rays radiate at
 *  equal angles with seeded lengths between a third and all of
 *  `rayLength`; rings sit at seeded fractions of the centre→end line
 *  with seeded radii up to `ringRadius`. */
export function flareParts(spec: FlareSpec): FlareParts {
  const rand = lcg(spec.seed ?? 0x0f1a2e);
  const { cx, cy } = spec;
  const r = Math.max(0.1, Math.abs(spec.centreRadius));
  const halo = Math.max(r * 1.01, r * Math.max(1, spec.haloScale));
  const rays: AnchorTable[] = [];
  const rayCount = Math.min(FLARE_MAX_RAYS, Math.max(0, Math.round(spec.rays)));
  for (let i = 0; i < rayCount; i++) {
    const a = (i * 2 * Math.PI) / rayCount + rand() * 0.15;
    const l = Math.abs(spec.rayLength) * (1 / 3 + (2 / 3) * rand());
    rays.push(lineToPath(cx, cy, cx + l * Math.cos(a), cy + l * Math.sin(a)));
  }
  const rings: AnchorTable[] = [];
  const ringCount = Math.min(
    FLARE_MAX_RINGS,
    Math.max(0, Math.round(spec.rings)),
  );
  const dx = spec.end[0] - cx;
  const dy = spec.end[1] - cy;
  for (let i = 0; i < ringCount; i++) {
    // Spread along the line (jittered), the LAST ring at the end point.
    const at =
      i === ringCount - 1 ? 1 : 0.15 + (0.85 * (i + 0.5 * rand())) / ringCount;
    const rr = Math.max(0.5, Math.abs(spec.ringRadius) * (0.2 + 0.8 * rand()));
    rings.push(ellipseToPath(cx + dx * at, cy + dy * at, rr, rr));
  }
  return {
    centre: ellipseToPath(cx, cy, r, r),
    halo: ellipseToPath(cx, cy, halo, halo),
    rays,
    rings,
  };
}
