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

// Anchor-edit planning — the pure core of the Add / Delete / Convert
// Anchor Point tools. Extracted from the editor's path-edit overlay
// (packages/shell/src/overlays/path-edit.tsx), which proved the
// click→t→split pipeline and the closing-edge subpath bookkeeping.
// Input: the engine's anchor table (path-local coords) + a click
// already mapped into path-local space; output: a neutral plan the
// host turns into Mutations:
//
//   insert  → batch [ pathPointSet(right @ segStart),
//                     pathPointSet(left  @ segEnd),
//                     pathPointInsert(insertIndex, anchor,
//                                     prevSubpathStarts?) ]
//   remove  → pathPointRemove(index)
//   convert → pathPointCurveType(index, smooth)
//
// Dispatch order for insert matters: both endpoint handles update at
// their OLD flat indices first, then the new anchor lands.

import {
  closestTOnCubic,
  dist,
  evalCubic,
  isCornerAnchor,
  splitSegmentDeCasteljau,
  type AnchorTable,
  type AnchorTriple,
  type Vec2,
} from "@paged-media/draw-geometry";

export type AnchorEditPlan =
  | {
      kind: "insert";
      segStart: number;
      segEnd: number;
      /** Adjusted outgoing handle for the anchor at `segStart`. */
      startRight: [number, number];
      /** Adjusted incoming handle for the anchor at `segEnd`. */
      endLeft: [number, number];
      insertIndex: number;
      anchor: AnchorTriple;
      /** Closing-edge override: post-insert subpath starts, supplied
       *  when the apply layer's strictly-greater rule would misfile
       *  the new anchor into the next subpath. */
      prevSubpathStarts?: number[];
    }
  | { kind: "remove"; index: number }
  | { kind: "convert"; index: number; smooth: boolean };

/** One renderable/selectable segment: [startIdx, endIdx,
 *  closingSubEnd]. `closingSubEnd != null` marks the wraparound
 *  (last → first) edge of a closed subpath and carries that
 *  subpath's end offset. */
export type SegmentPair = readonly [number, number, number | null];

/** Enumerate adjacent in-subpath pairs + wraparound edges of closed
 *  subpaths — path-edit.tsx's hit-zone enumeration, extracted. */
export function segmentPairsOf(table: AnchorTable): SegmentPair[] {
  const out: SegmentPair[] = [];
  const n = table.anchors.length;
  const starts = table.subpathStarts.length > 0 ? table.subpathStarts : [0];
  for (let si = 0; si < starts.length; si++) {
    const subStart = starts[si];
    const subEnd = si + 1 < starts.length ? starts[si + 1] : n;
    for (let i = subStart; i + 1 < subEnd; i++) {
      out.push([i, i + 1, null]);
    }
    const isOpen = table.subpathOpen?.[si] ?? false;
    if (!isOpen && subEnd - subStart >= 2) {
      out.push([subEnd - 1, subStart, subEnd]);
    }
  }
  return out;
}

/** Nearest anchor index within `tolerance` of `click`, or -1. */
export function nearestAnchorIndex(
  table: AnchorTable,
  click: Vec2,
  tolerance: number,
): number {
  let best = -1;
  let bestDist = tolerance;
  table.anchors.forEach((a, i) => {
    const d = dist(a.anchor, click);
    if (d <= bestDist) {
      best = i;
      bestDist = d;
    }
  });
  return best;
}

/** Delete Anchor Point: nearest anchor within tolerance. Refuses to
 *  reduce a contour below two anchors (the engine would reject it —
 *  fail here, where the host can show a sensible cursor instead). */
export function planAnchorDelete(
  table: AnchorTable,
  click: Vec2,
  tolerance: number,
): AnchorEditPlan | null {
  const index = nearestAnchorIndex(table, click, tolerance);
  if (index < 0) return null;
  const n = table.anchors.length;
  const starts = table.subpathStarts.length > 0 ? table.subpathStarts : [0];
  for (let si = 0; si < starts.length; si++) {
    const subStart = starts[si];
    const subEnd = si + 1 < starts.length ? starts[si + 1] : n;
    if (index >= subStart && index < subEnd && subEnd - subStart <= 2) {
      return null;
    }
  }
  return { kind: "remove", index };
}

/** Convert Direction Point: corner ↔ smooth toggle on the nearest
 *  anchor (path-edit.tsx's double-click semantics). */
export function planAnchorConvert(
  table: AnchorTable,
  click: Vec2,
  tolerance: number,
): AnchorEditPlan | null {
  const index = nearestAnchorIndex(table, click, tolerance);
  if (index < 0) return null;
  return {
    kind: "convert",
    index,
    smooth: isCornerAnchor(table.anchors[index]),
  };
}

/** Add Anchor Point: project the click onto the nearest segment
 *  (within `tolerance` of the curve), split it curve-preservingly,
 *  and plan the 3-op insert with the closing-edge subpath override. */
export function planAnchorAdd(
  table: AnchorTable,
  click: Vec2,
  tolerance: number,
): AnchorEditPlan | null {
  let best: {
    pair: SegmentPair;
    t: number;
    distance: number;
  } | null = null;
  for (const pair of segmentPairsOf(table)) {
    const sA = table.anchors[pair[0]];
    const eA = table.anchors[pair[1]];
    if (!sA || !eA) continue;
    const t = closestTOnCubic(sA.anchor, sA.right, eA.left, eA.anchor, click);
    const p = evalCubic(sA.anchor, sA.right, eA.left, eA.anchor, t);
    const d = dist(p, click);
    if (d <= tolerance && (best === null || d < best.distance)) {
      best = { pair, t, distance: d };
    }
  }
  if (!best) return null;
  const [segStart, segEnd, closingSubEnd] = best.pair;
  const sA = table.anchors[segStart];
  const eA = table.anchors[segEnd];
  const split = splitSegmentDeCasteljau(
    sA.anchor,
    sA.right,
    eA.left,
    eA.anchor,
    best.t,
  );
  const insertIndex = closingSubEnd !== null ? closingSubEnd : segStart + 1;
  // Closing-edge inserts at a subpath boundary: bump every start at
  // or beyond the boundary so the new anchor stays in the PRIOR
  // subpath (the apply layer's strictly-greater default would
  // misfile it). The last subpath's closing edge needs no override.
  let prevSubpathStarts: number[] | undefined;
  if (closingSubEnd !== null && closingSubEnd < table.anchors.length) {
    prevSubpathStarts = Array.from(table.subpathStarts, (s) =>
      s >= closingSubEnd ? s + 1 : s,
    );
  }
  return {
    kind: "insert",
    segStart,
    segEnd,
    startRight: split.startRight,
    endLeft: split.endLeft,
    insertIndex,
    anchor: {
      anchor: split.midAnchor,
      left: split.midLeft,
      right: split.midRight,
    },
    ...(prevSubpathStarts !== undefined ? { prevSubpathStarts } : {}),
  };
}
