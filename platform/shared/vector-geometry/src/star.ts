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

// STAR, POLYGON and FLARE — the parametric geometry, one implementation
// (PM-0017) of the engine's live polygon (`paged_model::live_shape`) for
// TypeScript: the host Polygon tool and live-shape widgets, the host's
// Insert star, the Shaper and the image module's vector shapes all draw
// their points here. Pure; page-space pt, angles in DEGREES from +x toward
// +y (y down), what the tools and the typed commands speak.
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

import type { AnchorTable, AnchorTriple, Vec2, Vec2Mut } from "./types";
import { ellipseToPath, lineToPath } from "./svg-shapes";

const corner = (x: number, y: number): AnchorTriple => ({
  anchor: [x, y],
  left: [x, y],
  right: [x, y],
});

/** `count` points evenly round `(cx, cy)`, the first at `baseRad`, each on
 *  the radius `radiusAt(i)`: every star and polygon here is one of these. */
function radialPoints(
  cx: number,
  cy: number,
  count: number,
  baseRad: number,
  radiusAt: (i: number) => number,
): Vec2Mut[] {
  const out: Vec2Mut[] = [];
  for (let i = 0; i < count; i++) {
    const a = baseRad + (i * 2 * Math.PI) / count;
    const r = radiusAt(i);
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

const closed = (points: readonly Vec2[]): AnchorTable => ({
  anchors: points.map(([x, y]) => corner(x, y)),
  subpathStarts: [0],
  subpathOpen: [false],
});

/** The engine's live polygon on the unit circle
 *  (`paged_model::live_shape::unit_polygon`): `sides` points, the first at
 *  twelve o'clock, clockwise on a y-down page; with `starInset` > 0 (percent)
 *  a star's inner points at `1 - inset / 100` between them. The caller
 *  clamps `sides` and `starInset` as the engine does. */
export function unitLivePolygon(sides: number, starInset: number): Vec2Mut[] {
  const star = starInset > 0;
  const inner = 1 - starInset / 100;
  return radialPoints(0, 0, star ? sides * 2 : sides, -Math.PI / 2, (i) =>
    star && i % 2 === 1 ? inner : 1,
  );
}

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

/** The star's corners, tip first (2·points); none for degenerate input (a
 *  non-finite value, both radii 0). */
export function starAnchors(spec: StarSpec): AnchorTriple[] {
  const { cx, cy } = spec;
  const r1 = Math.abs(spec.radius1);
  const r2 = Math.abs(spec.radius2);
  const finite = [cx, cy, r1, r2, spec.points].every(Number.isFinite);
  if (!finite || (r1 === 0 && r2 === 0)) return [];
  const n = Math.round(
    Math.min(STAR_MAX_POINTS, Math.max(STAR_MIN_POINTS, spec.points)),
  );
  const base = ((spec.rotationDeg ?? 0) - 90) * (Math.PI / 180);
  return radialPoints(cx, cy, 2 * n, base, (i) => (i % 2 === 0 ? r1 : r2)).map(
    ([x, y]) => corner(x, y),
  );
}

/** The star as one CLOSED contour of 2·points corners, tip first.
 *  Degenerate input (a non-finite value, both radii 0) is an empty
 *  table. */
export function starPath(spec: StarSpec): AnchorTable {
  const anchors = starAnchors(spec);
  return anchors.length === 0
    ? { anchors: [], subpathStarts: [], subpathOpen: [] }
    : { anchors, subpathStarts: [0], subpathOpen: [false] };
}

/** The corners of a regular polygon (`sides` on `radius`, first corner up
 *  at rotation 0). */
export function polygonAnchors(
  cx: number,
  cy: number,
  radius: number,
  sides: number,
  rotationDeg = 0,
): AnchorTriple[] {
  const n = Math.max(3, Math.round(sides));
  const base = (rotationDeg - 90) * (Math.PI / 180);
  return radialPoints(cx, cy, n, base, () => radius).map(([x, y]) =>
    corner(x, y),
  );
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
  return closed(
    polygonAnchors(cx, cy, radius, sides, rotationDeg).map((a) => a.anchor),
  );
}

// ---------------------------------------------------------- star insert
//
// THE STAR INSERT — Illustrator's Star (Radius 1, Radius 2, points,
// rotation) as the wire an insert writes; the editor's `paged.insert.star`
// builds through it. A star the engine can draw itself is written LIVE
// (engine ADR 1047): the plain polygon on Radius 1, then its
// `frameShapeSides` and `frameShapeStarInset`, so the Transform panel's
// Shape section and the on-canvas widgets edit it later. That needs an
// UPRIGHT star (the engine's points start at twelve o'clock) whose Radius 2
// is the smaller one (its inset is `1 - Radius 2 / Radius 1`, at most
// 99 %). Anything else (turned, Radius 2 larger, an inset past the ceiling)
// is the plain closed path of 2 x points corners.

/** The engine's star-inset ceiling (engine ADR 1047, percent). */
export const MAX_LIVE_STAR_INSET = 99;

/** Complete star parameters (an insert's payload, read). */
export interface StarParams extends StarSpec {
  rotationDeg: number;
}

/** One corner anchor (handles collapsed onto the point). */
export type StarAnchor = AnchorTriple;

/** Illustrator's Star dialog defaults (Radius 1 50 pt, Radius 2 25 pt, 5
 *  points) at the page's top-left third. */
export const STAR_DEFAULTS: StarParams = {
  cx: 200,
  cy: 200,
  radius1: 50,
  radius2: 25,
  points: 5,
  rotationDeg: 0,
};

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** A payload as complete star parameters: unreadable fields are the
 *  defaults, radii are magnitudes, the point count is whole and in range. */
export function starParamsFrom(
  payload?: Record<string, unknown> | null,
  defaults: StarParams = STAR_DEFAULTS,
): StarParams {
  return {
    cx: num(payload?.cx, defaults.cx),
    cy: num(payload?.cy, defaults.cy),
    radius1: Math.abs(num(payload?.radius1, defaults.radius1)),
    radius2: Math.abs(num(payload?.radius2, defaults.radius2)),
    points: Math.min(
      STAR_MAX_POINTS,
      Math.max(
        STAR_MIN_POINTS,
        Math.round(num(payload?.points, defaults.points)),
      ),
    ),
    rotationDeg: num(payload?.rotationDeg, defaults.rotationDeg),
  };
}

/** The star-inset (percent, two decimals) of a live star, or null when the
 *  engine's live star cannot be this one. */
export function liveStarInset(p: StarParams): number | null {
  const turned = ((p.rotationDeg % 360) + 360) % 360 !== 0;
  if (turned || !(p.radius1 > 0) || !(p.radius2 < p.radius1)) return null;
  const inset = Math.round((1 - p.radius2 / p.radius1) * 1e4) / 100;
  return inset > MAX_LIVE_STAR_INSET ? null : inset;
}

const insertPath = (pageId: string, anchors: readonly StarAnchor[]) => ({
  op: "insertPath" as const,
  args: { pageId, anchors, open: false },
});

const setLength = (path: string, value: number) => ({
  op: "setElementProperty" as const,
  args: {
    elementId: { kind: "polygon", id: "$created" },
    path,
    value: { type: "length", value },
  },
});

/**
 * The LIVE star as ONE batch, or null when the engine's live star cannot be
 * this one (`liveStarInset`). The element is the batch's `$created`
 * polygon, so one undo takes the whole star back.
 */
export function liveStarMutationFor(pageId: string, p: StarParams) {
  const inset = liveStarInset(p);
  if (inset === null) return null;
  return {
    op: "batch" as const,
    args: {
      ops: [
        insertPath(pageId, polygonAnchors(p.cx, p.cy, p.radius1, p.points)),
        setLength("frameShapeSides", p.points),
        setLength("frameShapeStarInset", inset),
      ],
    },
  };
}

/** The star as the mutation an insert sends: live where the engine draws
 *  it, else the plain closed path; null for a degenerate star. */
export function starMutationFor(pageId: string, p: StarParams) {
  const live = liveStarMutationFor(pageId, p);
  if (live) return live;
  const anchors = starAnchors(p);
  return anchors.length < 3 ? null : insertPath(pageId, anchors);
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
