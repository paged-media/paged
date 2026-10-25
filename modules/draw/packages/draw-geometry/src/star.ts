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

// STAR and FLARE — the two Illustrator shape tools whose geometry is
// parametric. Pure; page-space pt, angles in DEGREES from +x toward +y
// (y down), what the tools and the typed commands speak.
//
// A STAR is Illustrator's: `points` tips on Radius 1, `points` valleys on
// Radius 2 between them, the first tip straight UP from the centre at
// rotation 0. Either radius may be the larger one — Illustrator lets the
// user drag Radius 2 past Radius 1 — so neither is called "outer".
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

/** Illustrator's star point count range. */
export const STAR_MIN_POINTS = 3;
export const STAR_MAX_POINTS = 1000;

export interface StarSpec {
  cx: number;
  cy: number;
  /** pt — the tips. */
  radius1: number;
  /** pt — the valleys between them. */
  radius2: number;
  /** Tips, clamped to 3…1000. */
  points: number;
  /** Degrees; 0 = the first tip straight up. */
  rotationDeg?: number;
}

/** The star as one CLOSED contour of 2·points corners, tip first.
 *  Degenerate input (a non-finite value, both radii 0) is an empty
 *  table. */
export function starPath(spec: StarSpec): AnchorTable {
  const { cx, cy } = spec;
  const r1 = Math.abs(spec.radius1);
  const r2 = Math.abs(spec.radius2);
  const finite = [cx, cy, r1, r2, spec.points].every(Number.isFinite);
  if (!finite || (r1 === 0 && r2 === 0))
    return { anchors: [], subpathStarts: [], subpathOpen: [] };
  const n = Math.round(
    Math.min(STAR_MAX_POINTS, Math.max(STAR_MIN_POINTS, spec.points)),
  );
  const base = ((spec.rotationDeg ?? 0) - 90) * (Math.PI / 180);
  const anchors: AnchorTriple[] = [];
  for (let i = 0; i < 2 * n; i++) {
    const r = i % 2 === 0 ? r1 : r2;
    const a = base + (i * Math.PI) / n;
    anchors.push(corner(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  return { anchors, subpathStarts: [0], subpathOpen: [false] };
}

/** A regular polygon (`sides` corners on `radius`, first corner up) —
 *  the Shaper's polygon and a star whose radii are equal halved. */
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

/** The Numerical Recipes LCG — deterministic "random". */
function lcg(seed: number): () => number {
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
