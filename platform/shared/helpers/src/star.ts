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

// THE STAR INSERT — Illustrator's Star (Radius 1, Radius 2, points, rotation)
// as the wire an insert writes. One implementation (PM-0017): the editor's
// `paged.insert.star` builds through it.
//
// A star the engine can draw itself is written LIVE (engine ADR 1047): the
// plain polygon on Radius 1, then its `frameShapeSides` and
// `frameShapeStarInset`, so the Transform panel's Shape section and the
// on-canvas widgets edit it later. That needs an UPRIGHT star (the engine's
// points start at twelve o'clock) whose Radius 2 is the smaller one (its
// inset is `1 - Radius 2 / Radius 1`, at most 99 %). Anything else
// (turned, Radius 2 larger, an inset past the ceiling) is the plain closed
// path of 2 x points corners. Pure: page-local pt, angles in degrees from
// +x toward +y (y down), the first tip straight up at rotation 0.

/** Illustrator's star point count range. */
export const STAR_MIN_POINTS = 3;
export const STAR_MAX_POINTS = 1000;

/** The engine's star-inset ceiling (engine ADR 1047, percent). */
export const MAX_LIVE_STAR_INSET = 99;

export interface StarParams {
  cx: number;
  cy: number;
  /** pt: the tips. */
  radius1: number;
  /** pt: the valleys between them. */
  radius2: number;
  points: number;
  rotationDeg: number;
}

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

/** One corner anchor (handles collapsed onto the point). */
export interface StarAnchor {
  anchor: [number, number];
  left: [number, number];
  right: [number, number];
}

const corner = (x: number, y: number): StarAnchor => ({
  anchor: [x, y],
  left: [x, y],
  right: [x, y],
});

/** The plain star: one closed contour of 2 x points corners, tip first; no
 *  anchors for a degenerate input (a non-finite value, both radii 0). */
export function starAnchors(p: StarParams): StarAnchor[] {
  const r1 = Math.abs(p.radius1);
  const r2 = Math.abs(p.radius2);
  if (![p.cx, p.cy, r1, r2, p.points].every(Number.isFinite)) return [];
  if (r1 === 0 && r2 === 0) return [];
  const n = Math.round(
    Math.min(STAR_MAX_POINTS, Math.max(STAR_MIN_POINTS, p.points)),
  );
  const base = (p.rotationDeg - 90) * (Math.PI / 180);
  const out: StarAnchor[] = [];
  for (let i = 0; i < 2 * n; i++) {
    const r = i % 2 === 0 ? r1 : r2;
    const a = base + (i * Math.PI) / n;
    out.push(corner(p.cx + r * Math.cos(a), p.cy + r * Math.sin(a)));
  }
  return out;
}

/** The regular polygon of `sides` corners on `radius`, first corner up. */
export function polygonAnchors(
  cx: number,
  cy: number,
  radius: number,
  sides: number,
): StarAnchor[] {
  const n = Math.max(3, Math.round(sides));
  const base = -Math.PI / 2;
  const out: StarAnchor[] = [];
  for (let i = 0; i < n; i++) {
    const a = base + (i * 2 * Math.PI) / n;
    out.push(corner(cx + radius * Math.cos(a), cy + radius * Math.sin(a)));
  }
  return out;
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
