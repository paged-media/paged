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

// Parametric shape generators (wave 2) — pure anchor-table producers
// for the insert-shape commands. The arc reuses the svg-arc math
// (≤90° slices, the `k = 4/3·tan(θ/4)` control-handle rule, SVG
// implementation-notes §F.6.6); the spiral extends the same rule with
// the log-spiral's exact tangent; the grids compose the svg-shapes
// line/circle lowerings. All angles are RADIANS from +x toward +y
// (y-down page space, matching the rest of this package). Pure,
// host-free, zero deps.

import type { AnchorTable, AnchorTriple, Vec2 } from "./types";
import { circleToPath, lineToPath } from "./svg-shapes";

const TAU = Math.PI * 2;

const EMPTY: AnchorTable = { anchors: [], subpathStarts: [], subpathOpen: [] };

const finite = (...ns: number[]): boolean => ns.every(Number.isFinite);

/**
 * An elliptical arc as a single contour: center `(cx, cy)`, radii
 * `rx`/`ry`, from `startAngle` sweeping `sweep` radians (signed;
 * positive = toward +y). |sweep| is clamped to a full turn. `closed`
 * marks the contour closed — the closing edge is the straight CHORD
 * from the arc end back to its start (both closing handles are
 * collapsed corners). Degenerate input (non-positive radius, zero
 * sweep, non-finite anything) yields an empty table — never a throw.
 */
export function arcPath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  startAngle: number,
  sweep: number,
  closed = false,
): AnchorTable {
  if (!finite(cx, cy, rx, ry, startAngle, sweep)) return EMPTY;
  if (rx <= 0 || ry <= 0 || sweep === 0) return EMPTY;
  const clamped = Math.sign(sweep) * Math.min(Math.abs(sweep), TAU);
  const segments = Math.max(1, Math.ceil(Math.abs(clamped) / (Math.PI / 2)));
  const delta = clamped / segments;
  const k = (4 / 3) * Math.tan(delta / 4);

  const point = (th: number): Vec2 => [cx + rx * Math.cos(th), cy + ry * Math.sin(th)];
  const tangent = (th: number): Vec2 => [-rx * Math.sin(th), ry * Math.cos(th)];

  const anchors: AnchorTriple[] = [];
  for (let i = 0; i <= segments; i++) {
    const th = startAngle + i * delta;
    const p = point(th);
    const t = tangent(th);
    // Interior boundaries carry both handles; the endpoints collapse
    // the outward-facing handle (an open arc starts/ends as a corner).
    const left: Vec2 = i > 0 ? [p[0] - k * t[0], p[1] - k * t[1]] : p;
    const right: Vec2 = i < segments ? [p[0] + k * t[0], p[1] + k * t[1]] : p;
    anchors.push({
      anchor: [p[0], p[1]],
      left: [left[0], left[1]],
      right: [right[0], right[1]],
    });
  }
  return { anchors, subpathStarts: [0], subpathOpen: [!closed] };
}

/**
 * A logarithmic spiral: starts at radius `r0` at angle 0 and winds
 * `turns` full turns; each full turn multiplies the radius by `decay`
 * (`decay < 1` tightens inward, `1` degenerates to a circle-like
 * closed-radius wind, `> 1` grows outward). `segmentsPerTurn` anchors
 * per turn (≥ 2). Handles use the arc handle rule scaled by the
 * spiral's EXACT tangent `p'(θ)` (including the radial `dr/dθ` term),
 * so the contour is smooth through every anchor. Open contour.
 * Degenerate input yields an empty table.
 */
export function spiralPath(
  cx: number,
  cy: number,
  r0: number,
  decay: number,
  turns: number,
  segmentsPerTurn: number,
): AnchorTable {
  if (!finite(cx, cy, r0, decay, turns, segmentsPerTurn)) return EMPTY;
  if (r0 <= 0 || decay <= 0 || turns <= 0 || segmentsPerTurn < 2) return EMPTY;
  const segments = Math.max(1, Math.round(turns * segmentsPerTurn));
  const delta = TAU / segmentsPerTurn;
  const k = (4 / 3) * Math.tan(delta / 4);
  const lnDecayPerRad = Math.log(decay) / TAU;

  const anchors: AnchorTriple[] = [];
  for (let i = 0; i <= segments; i++) {
    const th = i * delta;
    const r = r0 * Math.pow(decay, th / TAU);
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    const p: Vec2 = [cx + r * cos, cy + r * sin];
    // p'(θ) = [r'·cosθ − r·sinθ, r'·sinθ + r·cosθ], r' = r·ln(decay)/2π.
    const rp = r * lnDecayPerRad;
    const t: Vec2 = [rp * cos - r * sin, rp * sin + r * cos];
    const left: Vec2 = i > 0 ? [p[0] - k * t[0], p[1] - k * t[1]] : p;
    const right: Vec2 = i < segments ? [p[0] + k * t[0], p[1] + k * t[1]] : p;
    anchors.push({
      anchor: [p[0], p[1]],
      left: [left[0], left[1]],
      right: [right[0], right[1]],
    });
  }
  return { anchors, subpathStarts: [0], subpathOpen: [true] };
}

/**
 * A rectangular grid as LINE paths (one open 2-anchor contour per
 * line): `rows`×`cols` cells inside `bounds` `[top, left, bottom,
 * right]` — that is `rows + 1` horizontal lines then `cols + 1`
 * vertical lines, INCLUDING the border. Degenerate bounds or counts
 * < 1 yield an empty list.
 */
export function rectGridPaths(
  bounds: readonly [number, number, number, number],
  rows: number,
  cols: number,
): AnchorTable[] {
  const [top, left, bottom, right] = bounds;
  if (!finite(top, left, bottom, right, rows, cols)) return [];
  if (rows < 1 || cols < 1 || bottom <= top || right <= left) return [];
  const out: AnchorTable[] = [];
  const h = bottom - top;
  const w = right - left;
  for (let i = 0; i <= rows; i++) {
    const y = top + (h * i) / rows;
    out.push(lineToPath(left, y, right, y));
  }
  for (let j = 0; j <= cols; j++) {
    const x = left + (w * j) / cols;
    out.push(lineToPath(x, top, x, bottom));
  }
  return out;
}

/**
 * A polar grid: `rings` concentric circles (closed 4-anchor
 * κ-approximated contours, radii `r·i/rings`, outermost = `r`)
 * followed by `radials` straight spokes from the center to the rim
 * (open 2-anchor contours at angles `2π·j/radials` from +x). Either
 * count may be 0 to omit that family; non-positive `r` (or both
 * counts < 1) yields an empty list.
 */
export function polarGridPaths(
  cx: number,
  cy: number,
  r: number,
  rings: number,
  radials: number,
): AnchorTable[] {
  if (!finite(cx, cy, r, rings, radials)) return [];
  if (r <= 0) return [];
  const nRings = Math.max(0, Math.floor(rings));
  const nRadials = Math.max(0, Math.floor(radials));
  if (nRings < 1 && nRadials < 1) return [];
  const out: AnchorTable[] = [];
  for (let i = 1; i <= nRings; i++) {
    out.push(circleToPath(cx, cy, (r * i) / nRings));
  }
  for (let j = 0; j < nRadials; j++) {
    const th = (TAU * j) / nRadials;
    out.push(lineToPath(cx, cy, cx + r * Math.cos(th), cy + r * Math.sin(th)));
  }
  return out;
}
