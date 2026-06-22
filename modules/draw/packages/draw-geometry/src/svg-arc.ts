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

// SVG elliptical-arc → cubic-Bezier conversion. The path `d` parser
// (svg-path.ts) lowers every `A`/`a` command through here: the standard
// endpoint→center parameterization (SVG implementation-notes §F.6.5),
// then each ≤90° sweep slice cubic-approximated by the well-known
// `k = 4/3·tan(θ/4)` control-handle rule (§F.6.6). Pure + host-free.

import type { Vec2 } from "./types";

/** One cubic slice the arc decomposes into: the two control points + the
 *  end on-curve point (the start point is the previous slice's end, or
 *  the arc's start for the first slice). All in user space. */
export interface ArcCubic {
  c1: Vec2;
  c2: Vec2;
  end: Vec2;
}

const TAU = Math.PI * 2;

/**
 * Convert an SVG elliptical-arc command to a list of cubic slices.
 *
 * @param start    current point (arc start), user space
 * @param rxIn     x radius (sign ignored per spec)
 * @param ryIn     y radius
 * @param phiDeg   x-axis rotation in DEGREES
 * @param largeArc large-arc flag
 * @param sweep    sweep flag (clockwise in SVG's y-down space)
 * @param end      arc end point, user space
 *
 * Out-of-range radii are corrected per spec (§F.6.6): zero radius / a
 * coincident endpoint collapses to a single straight cubic (a degenerate
 * line), never throws.
 */
export function arcToCubics(
  start: Vec2,
  rxIn: number,
  ryIn: number,
  phiDeg: number,
  largeArc: boolean,
  sweep: boolean,
  end: Vec2,
): ArcCubic[] {
  const [x1, y1] = start;
  const [x2, y2] = end;

  // Degenerate: endpoints coincide → no arc (spec: omit the segment).
  if (x1 === x2 && y1 === y2) return [];

  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  // Degenerate radius → straight line (a single linear cubic).
  if (rx === 0 || ry === 0) {
    return [{ c1: start, c2: end, end }];
  }

  const phi = (phiDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  // Step 1: compute (x1', y1') — midpoint frame, rotated to ellipse axes.
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  // Step 1b: correct out-of-range radii (§F.6.6 step 3).
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  // Step 2: compute (cx', cy').
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const x1p2 = x1p * x1p;
  const y1p2 = y1p * y1p;
  let num = rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2;
  const den = rx2 * y1p2 + ry2 * x1p2;
  if (num < 0) num = 0; // clamp FP noise
  let coef = Math.sqrt(num / den);
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * (rx * y1p)) / ry;
  const cyp = (coef * -(ry * x1p)) / rx;

  // Step 3: compute (cx, cy) in user space.
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  // Step 4: compute start angle θ1 and sweep Δθ.
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = angle(1, 0, ux, uy);
  let dTheta = angle(ux, uy, vx, vy);
  if (!sweep && dTheta > 0) dTheta -= TAU;
  else if (sweep && dTheta < 0) dTheta += TAU;

  // Step 5: slice into ≤90° arcs and cubic-approximate each.
  const segments = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const delta = dTheta / segments;
  // k controls the handle length for one slice of angular width `delta`.
  const t = (4 / 3) * Math.tan(delta / 4);

  const out: ArcCubic[] = [];
  let theta = theta1;
  // Point on the ellipse (user space) at angle θ.
  const point = (th: number): Vec2 => {
    const cosT = Math.cos(th);
    const sinT = Math.sin(th);
    const ex = rx * cosT;
    const ey = ry * sinT;
    return [cosPhi * ex - sinPhi * ey + cx, sinPhi * ex + cosPhi * ey + cy];
  };
  // Tangent direction (unnormalized derivative) at angle θ, user space.
  const tangent = (th: number): Vec2 => {
    const cosT = Math.cos(th);
    const sinT = Math.sin(th);
    const dx = -rx * sinT;
    const dy = ry * cosT;
    return [cosPhi * dx - sinPhi * dy, sinPhi * dx + cosPhi * dy];
  };

  for (let i = 0; i < segments; i++) {
    const th0 = theta;
    const th1 = theta + delta;
    const p0 = point(th0);
    const p1 = point(th1);
    const tan0 = tangent(th0);
    const tan1 = tangent(th1);
    const c1: Vec2 = [p0[0] + t * tan0[0], p0[1] + t * tan0[1]];
    const c2: Vec2 = [p1[0] - t * tan1[0], p1[1] - t * tan1[1]];
    out.push({ c1, c2, end: p1 });
    theta = th1;
  }
  return out;
}
