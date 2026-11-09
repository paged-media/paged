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

// THE PATH ERASER and THE JOIN TOOL — the two pure planners that cut a
// contour at points a gesture chose and put pieces back together.
//
// PATH ERASER. A drag along a path removes the part of the path the drag
// passed over: every stretch of the contour within `radius` of the drag
// polyline goes, and what is left are OPEN pieces that trace the original
// curve exactly (`subRun` — de Casteljau, not a re-fit). The two ends of
// an erased stretch are found by bisection on the curve itself, so a
// piece ends where the brush's edge crossed the path, not at the nearest
// flattening sample. This is distinct from the Eraser brush, which
// subtracts a swept AREA from FILLS; this one shortens STROKES.
//
// JOIN. A scrub (a short freehand gesture) over
//   · the GAP between two open endpoints joins them with a straight
//     segment (one path's two ends close it);
//   · the CROSSING of two open paths trims each one at the crossing —
//     dropping the overhang the scrub went over, or the shorter side when
//     the scrub does not say — and joins them THERE, a corner.
// The engine does the joining (`joinPaths` / `closePath`); this module
// says what each path must look like first so that the engine's own rule
// — it welds the NEAREST endpoint pair — welds the pair the scrub chose:
// the endpoint pair is made exactly coincident (distance 0, so nothing
// else can be nearer), which is also what makes the engine MERGE the two
// anchors rather than draw a segment between them.

import type { AnchorTriple, Vec2, Vec2Mut } from "./types";
import {
  locatedSamples,
  locationScalar,
  pointAtLocation,
  polylineDistance,
  polylineIntersections,
  polylineLength,
  segmentCount,
  subRun,
  locationAlongSamples,
  type PathLocation,
} from "./path-locate";

const SAMPLES = 48;

function fromScalar(s: number, segs: number): PathLocation {
  const clamped = Math.max(0, Math.min(segs, s));
  const segment = Math.min(segs - 1, Math.floor(clamped));
  return { segment, t: clamped - segment };
}

/** The boundary between a covered and an uncovered location, by
 *  bisection on the curve (`inside(a)` ≠ `inside(b)`). */
function boundary(
  anchors: readonly AnchorTriple[],
  segs: number,
  a: number,
  b: number,
  inside: (p: Vec2) => boolean,
): number {
  const ina = inside(pointAtLocation(anchors, fromScalar(a, segs)));
  let lo = a;
  let hi = b;
  for (let k = 0; k < 20; k++) {
    const mid = (lo + hi) / 2;
    const inm = inside(pointAtLocation(anchors, fromScalar(mid, segs)));
    if (inm === ina) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface ErasePlan {
  /** The OPEN pieces left, in contour order. Empty = all of it went. */
  pieces: AnchorTriple[][];
}

/** The pieces shorter than this (pt) are dropped: a sliver left at a
 *  brush's edge is not a path. */
export const ERASE_MIN_PIECE_PT = 0.25;

/**
 * Erase from ONE contour whatever lies within `radius` of `brush`. Null
 * when the brush touched nothing. A closed contour opens: its pieces are
 * open runs that may pass through anchor 0.
 */
export function planPathErase(
  anchors: readonly AnchorTriple[],
  closed: boolean,
  brush: readonly Vec2[],
  radius: number,
): ErasePlan | null {
  const segs = segmentCount(anchors.length, closed);
  if (segs === 0 || brush.length === 0) return null;
  const inside = (p: Vec2) => polylineDistance(p, brush) <= radius;
  const samples = locatedSamples(anchors, closed, SAMPLES);
  const covered = samples.map((s) => inside(s.point));
  if (!covered.some(Boolean)) return null;
  if (covered.every(Boolean)) return { pieces: [] };
  const scalars = samples.map((s) => locationScalar(s.at));
  // Every switch between covered and uncovered, refined on the curve.
  const switches: { at: number; entering: boolean }[] = [];
  for (let i = 1; i < samples.length; i++) {
    if (covered[i] === covered[i - 1]) continue;
    switches.push({
      at: boundary(anchors, segs, scalars[i - 1]!, scalars[i]!, inside),
      entering: covered[i]!,
    });
  }
  const kept: [number, number][] = [];
  if (!closed) {
    let start: number | null = covered[0] ? null : 0;
    for (const s of switches) {
      if (s.entering && start !== null) {
        kept.push([start, s.at]);
        start = null;
      } else if (!s.entering) start = s.at;
    }
    if (start !== null) kept.push([start, segs]);
  } else {
    // Closed: the samples' first and last are the same point, so the
    // switches alternate round the ring; pair each EXIT with the next
    // ENTRY, wrapping.
    const exits = switches.filter((s) => !s.entering).map((s) => s.at);
    const entries = switches.filter((s) => s.entering).map((s) => s.at);
    for (const x of exits) {
      const next = entries.find((e) => e > x) ?? entries[0]! + segs;
      kept.push([x, next]);
    }
  }
  const pieces: AnchorTriple[][] = [];
  for (const [a, b] of kept) {
    const from = fromScalar(a, segs);
    const to = b > segs ? fromScalar(b - segs, segs) : fromScalar(b, segs);
    const run = subRun(anchors, closed, from, to);
    if (!run) continue;
    const pts = locatedSamples(run, false, 8).map((s) => s.point);
    if (polylineLength(pts) < ERASE_MIN_PIECE_PT) continue;
    pieces.push(run);
  }
  return { pieces };
}

// ----------------------------------------------------------------- join

/** One candidate path for the Join tool: ONE open contour, in a space
 *  every candidate shares. */
export interface JoinCandidate {
  anchors: readonly AnchorTriple[];
}

export type JoinPlan =
  /** Close candidate `path`'s own gap. */
  | { kind: "close"; path: number }
  /** Join `a` and `b` across a gap: `a` is rewritten to `aAnchors` (a
   *  straight extension to `b`'s endpoint), then the engine welds. */
  | { kind: "gap"; a: number; b: number; aAnchors: AnchorTriple[] }
  /** Trim both at their crossing `point` and weld them there. */
  | {
      kind: "crossing";
      a: number;
      b: number;
      point: Vec2Mut;
      aAnchors: AnchorTriple[];
      bAnchors: AnchorTriple[];
    };

const copy = (a: AnchorTriple): AnchorTriple => ({
  anchor: [a.anchor[0], a.anchor[1]],
  left: [a.left[0], a.left[1]],
  right: [a.right[0], a.right[1]],
});

/** How far along `scrub` (arc length) its nearest point to `p` is. */
function alongScrub(p: Vec2, scrub: readonly Vec2[]): number {
  let best = Infinity;
  let at = 0;
  let acc = 0;
  for (let i = 1; i < scrub.length; i++) {
    const a = scrub[i - 1]!;
    const b = scrub[i]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const u =
      l2 > 0
        ? Math.max(
            0,
            Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2),
          )
        : 0;
    const d = Math.hypot(p[0] - (a[0] + u * dx), p[1] - (a[1] + u * dy));
    if (d < best) {
      best = d;
      at = acc + u * Math.sqrt(l2);
    }
    acc += Math.sqrt(l2);
  }
  return at;
}

/**
 * What a Join scrub over `paths` asks for (see the module header), or
 * null when it is over no gap and no crossing. `tolerance` (pt) is how
 * close the scrub must pass to an endpoint or an overhang.
 */
export function planJoinScrub(
  paths: readonly JoinCandidate[],
  scrub: readonly Vec2[],
  tolerance: number,
): JoinPlan | null {
  if (scrub.length === 0) return null;
  // 1. Endpoints the scrub passed over, in scrub order.
  const ends: { path: number; end: "start" | "end"; at: number }[] = [];
  paths.forEach((p, i) => {
    const n = p.anchors.length;
    if (n < 2) return;
    for (const end of ["start", "end"] as const) {
      const pt = p.anchors[end === "start" ? 0 : n - 1]!.anchor;
      if (polylineDistance(pt, scrub) <= tolerance)
        ends.push({ path: i, end, at: alongScrub(pt, scrub) });
    }
  });
  ends.sort((x, y) => x.at - y.at);
  if (ends.length >= 2) {
    const first = ends[0]!;
    const other = ends.find((e) => e.path !== first.path);
    if (!other) return { kind: "close", path: first.path };
    const a = paths[first.path]!.anchors.map(copy);
    const b = paths[other.path]!.anchors;
    const target = b[other.end === "start" ? 0 : b.length - 1]!.anchor;
    const joint: AnchorTriple = {
      anchor: [target[0], target[1]],
      left: [target[0], target[1]],
      right: [target[0], target[1]],
    };
    if (first.end === "end") {
      a[a.length - 1]!.right = [...a[a.length - 1]!.anchor];
      a.push(joint);
    } else {
      a[0]!.left = [...a[0]!.anchor];
      a.unshift(joint);
    }
    return { kind: "gap", a: first.path, b: other.path, aAnchors: a };
  }
  // 2. The crossing of two paths nearest the scrub.
  const flat = paths.map((p) => locatedSamples(p.anchors, false, SAMPLES));
  let best: {
    a: number;
    b: number;
    point: Vec2Mut;
    fa: number;
    fb: number;
    d: number;
  } | null = null;
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const xs = polylineIntersections(
        flat[i]!.map((s) => s.point),
        flat[j]!.map((s) => s.point),
      );
      for (const x of xs) {
        const d = polylineDistance(x.point, scrub);
        if (!best || d < best.d)
          best = { a: i, b: j, point: x.point, fa: x.a, fb: x.b, d };
      }
    }
  }
  if (!best) return null;
  // The scrub must go over one of the two paths: a crossing elsewhere on
  // the page is not what it asked for.
  const near = (i: number) =>
    flat[i]!.some((s) => polylineDistance(s.point, scrub) <= tolerance);
  if (!near(best.a) && !near(best.b)) return null;
  const trim = (index: number, f: number): AnchorTriple[] | null => {
    const anchors = paths[index]!.anchors;
    const segs = anchors.length - 1;
    const at = locationAlongSamples(flat[index]!, f);
    const head = subRun(anchors, false, { segment: 0, t: 0 }, at);
    const tail = subRun(anchors, false, at, { segment: segs - 1, t: 1 });
    if (!head) return tail;
    if (!tail) return head;
    const touched = (run: AnchorTriple[]) =>
      locatedSamples(run, false, 16).some(
        (s) => polylineDistance(s.point, scrub) <= tolerance,
      );
    const lengthOf = (run: AnchorTriple[]) =>
      polylineLength(locatedSamples(run, false, 16).map((s) => s.point));
    const th = touched(head);
    const tt = touched(tail);
    // Drop what the scrub went over; when it says nothing (both or
    // neither), drop the shorter side — the overhang.
    if (th !== tt) return th ? tail : head;
    return lengthOf(head) >= lengthOf(tail) ? head : tail;
  };
  const aRun = trim(best.a, best.fa);
  const bRun = trim(best.b, best.fb);
  if (!aRun || !bRun) return null;
  // Both trimmed ends land EXACTLY on the crossing (see the header).
  const pin = (run: AnchorTriple[]) => {
    const head = Math.hypot(
      run[0]!.anchor[0] - best!.point[0],
      run[0]!.anchor[1] - best!.point[1],
    );
    const tailA = run[run.length - 1]!;
    const tail = Math.hypot(
      tailA.anchor[0] - best!.point[0],
      tailA.anchor[1] - best!.point[1],
    );
    const a = head <= tail ? run[0]! : tailA;
    const dx = best!.point[0] - a.anchor[0];
    const dy = best!.point[1] - a.anchor[1];
    a.anchor = [best!.point[0], best!.point[1]];
    a.left = [a.left[0] + dx, a.left[1] + dy];
    a.right = [a.right[0] + dx, a.right[1] + dy];
  };
  pin(aRun);
  pin(bRun);
  return {
    kind: "crossing",
    a: best.a,
    b: best.b,
    point: best.point,
    aAnchors: aRun,
    bAnchors: bRun,
  };
}
