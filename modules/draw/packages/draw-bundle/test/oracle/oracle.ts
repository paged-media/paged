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

// The ORACLE lane's shared half: what a recorded answer looks like, how
// to load one, and how to MEASURE a path so two engines can be compared
// by shape instead of by anchor table.
//
// An oracle fixture is Adobe Illustrator's answer to one path operation,
// recorded once on a maintainer's Mac by `scripts/illustrator/run-probe.sh`
// and committed beside this lane as
// `test/fixtures/oracle/<probe>.illustrator.json`. CI never drives
// Illustrator; it replays the committed file against the real headless
// engine (`conformance/host.ts`).
//
// WHY SHAPE AND NOT ANCHORS. Two correct offsets of the same rectangle
// can start at different corners, run in opposite directions, and — for
// a round join — spend a different number of cubics on the same arc.
// None of that is a difference a user can see. So a comparison reads
// three things that do not depend on the traversal: the enclosed AREA,
// the BOUNDS, and the ANCHOR COUNT (the last being the one place a
// convention difference such as "one cubic per quarter arc" shows up,
// which is why it is compared and not ignored).
//
// COORDINATES. Everything here is in POINTS, page-local, origin top-left,
// Y DOWN — the engine's own convention. Illustrator scripts in Y-UP
// document coordinates; each probe negates Y on the way in and on the
// way out, so a fixture is already in this frame. Mirroring Y flips the
// SIGN of a signed area, so `winding` is always stated in THIS frame:
// "cw" is clockwise as drawn on a Y-down page (positive shoelace sum).

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Vec2 = [number, number];

/** One anchor with both handles — the engine's `PathAnchorTriple`, and
 *  the shape a probe records. A corner has `left == right == anchor`. */
export interface OracleAnchor {
  anchor: Vec2;
  left: Vec2;
  right: Vec2;
}

/** A path as a probe BUILDS it. */
export interface OraclePath {
  closed: boolean;
  anchors: OracleAnchor[];
}

export type Winding = "cw" | "ccw" | "none";

/** A path as a probe MEASURES it: the geometry plus what Illustrator
 *  itself reports about it. `area` is |PathItem.area|; `areaSignedApp`
 *  is that property verbatim (Illustrator's own Y-up sign) and
 *  `polarity` is `PathItem.polarity` — both kept raw so a convention
 *  question can be answered from the fixture without re-recording. */
export interface OracleMeasuredPath extends OraclePath {
  area: number;
  /** `[minX, minY, maxX, maxY]`, Y down. From `geometricBounds`. */
  bounds: [number, number, number, number];
  winding: Winding;
  areaSignedApp?: number;
  polarity?: string;
  /** Index of the compound path this subpath belongs to, when the
   *  result is a compound path; absent for a plain path. */
  compound?: number;
}

export interface OracleCase<P> {
  id: string;
  input: { paths: OraclePath[] };
  parameters: P;
  measured: { paths: OracleMeasuredPath[] };
}

export interface OracleFixture<P> {
  fixture: string;
  produced_by: {
    app: string;
    version: string;
    script: string;
    recorded_at: string;
    [extra: string]: unknown;
  };
  units: "pt";
  coordinates: string;
  operation: string;
  cases: OracleCase<P>[];
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where a probe's recorded answer lives. */
export const oracleFixturePath = (probe: string): string =>
  resolve(HERE, "../fixtures/oracle", `${probe}.illustrator.json`);

/** Load a recorded answer. A spec exists only for a probe that HAS been
 *  recorded, so a missing fixture THROWS (a deleted recording must not
 *  turn its replay into nothing), and so does a malformed one. */
export function loadOracle<P>(probe: string): OracleFixture<P> {
  const path = oracleFixturePath(probe);
  if (!existsSync(path)) {
    throw new Error(
      `${path} is missing — record it with scripts/illustrator/run-probe.sh ` +
        `scripts/illustrator/probes/${probe}.jsx <that path> (see scripts/illustrator/README.md)`,
    );
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as OracleFixture<P>;
  if (parsed.fixture !== probe) {
    throw new Error(
      `${path}: fixture is "${parsed.fixture}", expected "${probe}"`,
    );
  }
  if (parsed.units !== "pt") {
    throw new Error(`${path}: units are "${parsed.units}", expected "pt"`);
  }
  for (const key of ["app", "version", "script", "recorded_at"] as const) {
    if (typeof parsed.produced_by?.[key] !== "string") {
      throw new Error(`${path}: produced_by.${key} is missing`);
    }
  }
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error(`${path}: no cases — an empty recording is not an answer`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Measuring a path
// ---------------------------------------------------------------------------

const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];

/** The four control points of the cubic that leaves anchor `a` and
 *  arrives at anchor `b`. */
const segment = (a: OracleAnchor, b: OracleAnchor): [Vec2, Vec2, Vec2, Vec2] => [
  a.anchor,
  a.right,
  b.left,
  b.anchor,
];

/** EXACT signed area of a closed path of cubic Béziers (Green's theorem,
 *  integrated in closed form per segment — no flattening, so a round
 *  join's area is exact for the cubics that were recorded). Positive =
 *  clockwise on a Y-down page. An open path is measured as if closed by
 *  a straight chord, which is what a fill would paint. */
export function signedArea(path: OraclePath): number {
  const n = path.anchors.length;
  if (n < 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    const a = path.anchors[i];
    const b = path.anchors[(i + 1) % n];
    if (last && !path.closed) {
      // The implicit closing chord of an open path: a straight line.
      sum += cross(a.anchor, b.anchor) / 2;
      continue;
    }
    const [p0, p1, p2, p3] = segment(a, b);
    sum +=
      (6 * cross(p0, p1) +
        3 * cross(p0, p2) +
        cross(p0, p3) +
        3 * cross(p1, p2) +
        3 * cross(p1, p3) +
        6 * cross(p2, p3)) /
      20;
  }
  return sum;
}

/** Roots in (0,1) of the derivative of one cubic coordinate. */
function extremaT(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const out: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) out.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      out.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  return out.filter((t) => t > 0 && t < 1);
}

const cubicAt = (p0: number, p1: number, p2: number, p3: number, t: number) => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

/** EXACT bounds of a path's curve (not of its control polygon): the
 *  anchors plus every interior extremum of every segment. */
export function pathBounds(path: OraclePath): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const take = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  const n = path.anchors.length;
  for (let i = 0; i < n; i++) {
    const a = path.anchors[i];
    take(a.anchor[0], a.anchor[1]);
    if (i === n - 1 && !path.closed) break;
    const [p0, p1, p2, p3] = segment(a, path.anchors[(i + 1) % n]);
    for (const t of extremaT(p0[0], p1[0], p2[0], p3[0])) {
      take(cubicAt(p0[0], p1[0], p2[0], p3[0], t), cubicAt(p0[1], p1[1], p2[1], p3[1], t));
    }
    for (const t of extremaT(p0[1], p1[1], p2[1], p3[1])) {
      take(cubicAt(p0[0], p1[0], p2[0], p3[0], t), cubicAt(p0[1], p1[1], p2[1], p3[1], t));
    }
  }
  return [minX, minY, maxX, maxY];
}

export const windingOf = (signed: number): Winding =>
  signed > 1e-9 ? "cw" : signed < -1e-9 ? "ccw" : "none";

/** How far a handle may sit off its chord and still be "on" it: 0.02 pt.
 *  Measured, not chosen: the engine's offset kernel snaps its output to a
 *  1/64 pt grid before resolving it, so the third-point handles of a
 *  STRAIGHT connector land up to 0.011 pt off the line (a triangle's
 *  bevel came back with a handle 0.007 pt off). The sagitta of a real 90°
 *  round join is 0.29 × its radius, so any offset above ~0.1 pt still
 *  reads as curved. */
export const STRAIGHT_TOL = 0.02;

/** True when the cubic from `a` to `b` is not a straight line: a handle
 *  sits off the chord. Handles that lie ON the chord (the engine writes a
 *  straight edge as a cubic with its handles at the third points;
 *  Illustrator writes it with both handles collapsed onto the anchors)
 *  are the same line, and must not read as a difference. */
export function isCurvedSegment(a: OracleAnchor, b: OracleAnchor): boolean {
  const [p0, p1, p2, p3] = segment(a, b);
  const chord: Vec2 = [p3[0] - p0[0], p3[1] - p0[1]];
  const len = Math.hypot(chord[0], chord[1]);
  if (len < STRAIGHT_TOL) {
    // A zero-length chord is curved exactly when a handle leaves it.
    return (
      Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) > STRAIGHT_TOL ||
      Math.hypot(p2[0] - p0[0], p2[1] - p0[1]) > STRAIGHT_TOL
    );
  }
  const off = (p: Vec2) => Math.abs(cross(chord, [p[0] - p0[0], p[1] - p0[1]])) / len;
  return off(p1) > STRAIGHT_TOL || off(p2) > STRAIGHT_TOL;
}

/** What two engines are compared on. */
export interface ShapeSummary {
  /** Number of paths (subpaths). */
  paths: number;
  /** Total anchors over all paths. */
  anchors: number;
  /** Segments that are genuinely curved (see `isCurvedSegment`). */
  curvedSegments: number;
  /** Sum of |signed area| per path. */
  area: number;
  /** |Σ signed area| — what a NON-ZERO fill of a correctly wound
   *  compound path encloses (holes subtract). Equals `area` for one
   *  path. */
  netArea: number;
  /** Union bounds `[minX, minY, maxX, maxY]`. */
  bounds: [number, number, number, number];
  /** Winding per path, in path order. */
  windings: Winding[];
  /** Whether every path is closed. */
  allClosed: boolean;
}

export function summarize(paths: readonly OraclePath[]): ShapeSummary {
  let anchors = 0;
  let curvedSegments = 0;
  let area = 0;
  let net = 0;
  const bounds: [number, number, number, number] = [
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
  ];
  const windings: Winding[] = [];
  for (const p of paths) {
    anchors += p.anchors.length;
    const n = p.anchors.length;
    for (let i = 0; i < (p.closed ? n : n - 1); i++) {
      if (isCurvedSegment(p.anchors[i], p.anchors[(i + 1) % n])) curvedSegments++;
    }
    const s = signedArea(p);
    area += Math.abs(s);
    net += s;
    windings.push(windingOf(s));
    const b = pathBounds(p);
    bounds[0] = Math.min(bounds[0], b[0]);
    bounds[1] = Math.min(bounds[1], b[1]);
    bounds[2] = Math.max(bounds[2], b[2]);
    bounds[3] = Math.max(bounds[3], b[3]);
  }
  return {
    paths: paths.length,
    anchors,
    curvedSegments,
    area,
    netArea: Math.abs(net),
    bounds,
    windings,
    allClosed: paths.every((p) => p.closed),
  };
}

/** The engine's `pathAnchors` reply, split into one `OraclePath` per
 *  subpath. `subpathStarts` is EMPTY for the common single-contour case
 *  and `subpathOpen` then carries the one flag. */
export function pathsOfTable(table: {
  anchors: readonly OracleAnchor[];
  subpathStarts: readonly number[];
  subpathOpen?: readonly boolean[];
}): OraclePath[] {
  const starts = table.subpathStarts.length > 0 ? [...table.subpathStarts] : [0];
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : table.anchors.length;
    return {
      closed: !(table.subpathOpen?.[i] ?? false),
      anchors: table.anchors.slice(start, end).map((a) => ({
        anchor: [a.anchor[0], a.anchor[1]],
        left: [a.left[0], a.left[1]],
        right: [a.right[0], a.right[1]],
      })),
    };
  });
}

/** A straight-edged closed polygon as an `OraclePath`. */
export const polygon = (points: readonly Vec2[]): OraclePath => ({
  closed: true,
  anchors: points.map((p) => ({
    anchor: [p[0], p[1]],
    left: [p[0], p[1]],
    right: [p[0], p[1]],
  })),
});

// ---------------------------------------------------------------------------
// Tolerances — STATED, and the same for every probe unless a spec says why
// ---------------------------------------------------------------------------

/** Area agrees within 0.1 % (relative). Tight enough that a wrong join
 *  (bevel for miter on a 10 pt offset of a 100 pt square is 1.4 %) or a
 *  doubled delta cannot hide; loose enough for two different cubic
 *  approximations of the same arc (the standard one-cubic quarter circle
 *  errs by 0.03 % of the ARC's area, far less of the shape's). */
export const AREA_REL_TOL = 1e-3;

/** Bounds agree within 0.05 pt per edge: above the engine's own grid
 *  (its offset kernel snaps to 1/64 pt = 0.0156 pt), and far under
 *  anything a join convention moves — a miter-vs-bevel corner on a
 *  non-axis-aligned shape, or a round-vs-miter apex, moves a bound by
 *  whole points at a 10 pt offset. */
export const BOUNDS_ABS_TOL = 0.05;

export const relDiff = (ours: number, theirs: number): number =>
  theirs === 0 ? Math.abs(ours) : Math.abs(ours - theirs) / Math.abs(theirs);

export const boundsDiff = (
  ours: readonly number[],
  theirs: readonly number[],
): number => Math.max(...ours.map((v, i) => Math.abs(v - theirs[i])));
