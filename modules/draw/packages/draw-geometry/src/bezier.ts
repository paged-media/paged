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

// Cubic-Bezier helpers. `splitSegmentDeCasteljau` / `closestTOnCubic`
// mirror the editor's overlay math (packages/shell/src/overlays/
// path-math.ts), which itself mirrors core's
// `paged-mutate/src/path_math.rs` — three copies of six lerps is the
// price of main-thread interactivity without a wasm round-trip; this
// one is the extraction target the other two converge on.

import type { Vec2, Vec2Mut } from "./types";
import type { AnchorTriple } from "./types";

function lerp(a: Vec2, b: Vec2, t: number): Vec2Mut {
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

export interface SegmentSplit {
  /** Adjusted right handle on the segment-start anchor. */
  startRight: Vec2Mut;
  /** New mid-anchor's left handle. */
  midLeft: Vec2Mut;
  /** New mid-anchor's on-curve position. */
  midAnchor: Vec2Mut;
  /** New mid-anchor's right handle. */
  midRight: Vec2Mut;
  /** Adjusted left handle on the segment-end anchor. */
  endLeft: Vec2Mut;
}

/**
 * Split the cubic `start → end` (with `startRight` = start's outgoing
 * handle, `endLeft` = end's incoming handle) at parameter t ∈ [0, 1].
 * The two resulting segments trace the same curve as the original.
 */
export function splitSegmentDeCasteljau(
  start: Vec2,
  startRight: Vec2,
  endLeft: Vec2,
  end: Vec2,
  t: number,
): SegmentSplit {
  const q0 = lerp(start, startRight, t);
  const q1 = lerp(startRight, endLeft, t);
  const q2 = lerp(endLeft, end, t);
  const r0 = lerp(q0, q1, t);
  const r1 = lerp(q1, q2, t);
  const mid = lerp(r0, r1, t);
  return {
    startRight: q0,
    midLeft: r0,
    midAnchor: mid,
    midRight: r1,
    endLeft: q2,
  };
}

/** Evaluate the cubic at `t`. */
export function evalCubic(
  start: Vec2,
  startRight: Vec2,
  endLeft: Vec2,
  end: Vec2,
  t: number,
): Vec2Mut {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return [
    w0 * start[0] + w1 * startRight[0] + w2 * endLeft[0] + w3 * end[0],
    w0 * start[1] + w1 * startRight[1] + w2 * endLeft[1] + w3 * end[1],
  ];
}

function evalCubicDerivative(
  start: Vec2,
  startRight: Vec2,
  endLeft: Vec2,
  end: Vec2,
  t: number,
): Vec2Mut {
  const u = 1 - t;
  const w0 = 3 * u * u;
  const w1 = 6 * u * t;
  const w2 = 3 * t * t;
  return [
    w0 * (startRight[0] - start[0]) +
      w1 * (endLeft[0] - startRight[0]) +
      w2 * (end[0] - endLeft[0]),
    w0 * (startRight[1] - start[1]) +
      w1 * (endLeft[1] - startRight[1]) +
      w2 * (end[1] - endLeft[1]),
  ];
}

/**
 * Parameter `t ∈ [0, 1]` minimising the distance from the cubic to
 * `click`. Coarse N-sample search + one Newton refinement step on the
 * squared-distance derivative (skipping the second-derivative term —
 * under-counts, but converges from the coarse start; stability over
 * speed).
 */
export function closestTOnCubic(
  start: Vec2,
  startRight: Vec2,
  endLeft: Vec2,
  end: Vec2,
  click: Vec2,
  samples = 30,
): number {
  let bestT = 0;
  let bestDist = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const p = evalCubic(start, startRight, endLeft, end, t);
    const dx = p[0] - click[0];
    const dy = p[1] - click[1];
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      bestT = t;
    }
  }
  const p = evalCubic(start, startRight, endLeft, end, bestT);
  const pp = evalCubicDerivative(start, startRight, endLeft, end, bestT);
  const diff: Vec2 = [p[0] - click[0], p[1] - click[1]];
  const f = diff[0] * pp[0] + diff[1] * pp[1];
  const fp = pp[0] * pp[0] + pp[1] * pp[1];
  if (Math.abs(fp) < 1e-6) return bestT;
  const refined = bestT - f / fp;
  if (refined < 0 || refined > 1) return bestT;
  return refined;
}

export interface SegmentReshape {
  /** New outgoing handle of the segment-start anchor. */
  startRight: Vec2Mut;
  /** New incoming handle of the segment-end anchor. */
  endLeft: Vec2Mut;
}

/** Parameters closer than this to a segment end are clamped by
 *  `reshapeSegmentByDrag` — see its note on the gain. */
export const SEGMENT_DRAG_T_MIN = 0.05;

/**
 * How much of a segment drag the END handle absorbs, as a function of
 * the grabbed parameter: 0 near the start (only the start's handle
 * moves), 1 near the end, ½ in the middle, with a C¹ cubic ease between
 * the sixths. The piecewise form is the one curve editors converged on
 * (Inkscape's curve-drag is the reference):
 *
 *   w(t) = 0                              t ≤ 1/6
 *        = ((6t − 1) / 2)³ / 2            1/6 < t ≤ 1/2
 *        = 1 − ((6(1 − t) − 1) / 2)³ / 2  1/2 < t ≤ 5/6
 *        = 1                              t > 5/6
 */
export function segmentDragWeight(t: number): number {
  if (t <= 1 / 6) return 0;
  if (t <= 0.5) return Math.pow((6 * t - 1) / 2, 3) / 2;
  if (t <= 5 / 6) return 1 - Math.pow((6 * (1 - t) - 1) / 2, 3) / 2;
  return 1;
}

/**
 * The direct-manipulation solve for dragging a point ON a cubic: move
 * the two inner control points so the curve point at parameter `t`
 * travels by exactly `delta`, the anchors staying put.
 *
 * With B(t) = (1−t)³P0 + 3(1−t)²t·P1 + 3(1−t)t²·P2 + t³P3 and the
 * anchors P0/P3 fixed, offsetting the handles by o1/o2 moves the point
 * by
 *
 *   ΔB(t) = 3(1−t)²t · o1 + 3(1−t)t² · o2
 *
 * One vector equation, two unknowns: a one-parameter family. Fix it with
 * the weight w = `segmentDragWeight(t)`:
 *
 *   o1 = (1 − w) / (3(1−t)²t) · delta
 *   o2 =      w  / (3(1−t)t²) · delta
 *
 * which gives ΔB(t) = (1 − w)·delta + w·delta = delta for every w — the
 * grabbed point follows the pointer exactly — while w decides which end
 * of the segment bends.
 *
 * THE GAIN. Both denominators vanish at the ends (a point AT an anchor
 * cannot be moved by its handles), so the handle travel per unit of
 * pointer travel grows without bound as t → 0 or 1. `t` is therefore
 * clamped to [`SEGMENT_DRAG_T_MIN`, 1 − `SEGMENT_DRAG_T_MIN`]; inside
 * that range the follow is exact, outside it the grabbed point lags the
 * pointer rather than the handles running away. A host hit-tests
 * anchors before segments, so a grab that close to an end is rare.
 */
export function reshapeSegmentByDrag(
  startRight: Vec2,
  endLeft: Vec2,
  t: number,
  delta: Vec2,
): SegmentReshape {
  const tc = Math.min(
    1 - SEGMENT_DRAG_T_MIN,
    Math.max(SEGMENT_DRAG_T_MIN, t),
  );
  const u = 1 - tc;
  const w = segmentDragWeight(tc);
  const k1 = (1 - w) / (3 * u * u * tc);
  const k2 = w / (3 * u * tc * tc);
  return {
    startRight: [startRight[0] + k1 * delta[0], startRight[1] + k1 * delta[1]],
    endLeft: [endLeft[0] + k2 * delta[0], endLeft[1] + k2 * delta[1]],
  };
}

/**
 * Flatten an anchor run into a polyline for preview rendering — the
 * host's tool-preview signal draws polylines only (a v0 API gap,
 * logged in BREAKAGE_LOG.md), so in-progress pen paths sample their
 * cubics. Straight segments (both inner handles collapsed) emit no
 * intermediate samples.
 */
export function flattenAnchorRun(
  anchors: readonly AnchorTriple[],
  options?: { close?: boolean; samplesPerSegment?: number },
): Vec2Mut[] {
  const samples = options?.samplesPerSegment ?? 12;
  const n = anchors.length;
  if (n === 0) return [];
  const out: Vec2Mut[] = [[anchors[0].anchor[0], anchors[0].anchor[1]]];
  const segmentCount = options?.close ? n : n - 1;
  for (let i = 0; i < segmentCount; i++) {
    const a = anchors[i];
    const b = anchors[(i + 1) % n];
    const straight =
      a.right[0] === a.anchor[0] &&
      a.right[1] === a.anchor[1] &&
      b.left[0] === b.anchor[0] &&
      b.left[1] === b.anchor[1];
    if (straight) {
      out.push([b.anchor[0], b.anchor[1]]);
      continue;
    }
    for (let s = 1; s <= samples; s++) {
      out.push(evalCubic(a.anchor, a.right, b.left, b.anchor, s / samples));
    }
  }
  return out;
}
