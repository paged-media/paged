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

// THE OP APPLIER — how the engine applies the path-point ops, in plain
// TS, on ONE anchor table. It started life as the test suite's reference
// model (`test/support/apply-ops.ts`, which now re-exports this) and was
// promoted when a machine needed it: `DirectSelectMachine.apply(ops)`
// previews an insert or a convert on its own table, so the host need not
// freeze input until its `pathAnchors` re-read lands.
//
// Each rule mirrors core's apply layer (`paged-mutate/src/apply/
// path_topology.rs` + the `FramePathPoint` arm of `set_property.rs`):
//
//   pathPointSet       anchor → the anchor AND both handles move by the
//                      same delta; left / right → that handle only.
//   pathPointInsert    the anchor lands at `index` (≤ length). The contour
//                      starts are REPLACED by `prevSubpathStarts` when it
//                      is given; otherwise every start strictly greater
//                      than `index` is bumped.
//   pathPointRemove    every start strictly greater than `index` drops by
//                      one; starts off the end are trimmed, equal
//                      neighbours de-duplicated.
//   pathPointCurveType corner → both handles collapse onto the anchor.
//                      smooth → `smooth_handles_from_neighbours`: the
//                      tangent is the unit vector from the PREVIOUS to the
//                      NEXT anchor of the same contour, each handle a
//                      third of the distance to its neighbour along it.
//                      On a CLOSED contour of ≥ 3 anchors the neighbours
//                      wrap (first and last are each other's neighbours,
//                      as core does since protocol 71); an OPEN contour's
//                      first or last anchor — or a degenerate tangent —
//                      falls back to a corner.
//   closePath          the named contour stops being open; endpoints that
//                      coincide (a contour of ≥ 3) merge into one anchor.
//
// `joinPaths` welds TWO elements and is not a one-table edit: it throws.
//
// A model can be wrong in the same way as the code it checks. That is
// why it is not the last word: `draw-bundle`'s conformance specs replay
// the same plans through the REAL engine, and compare its table with
// this one's.

import type { AnchorTable, AnchorTriple } from "@paged-media/draw-geometry";

import type { PathPointOp } from "./path-edit-ops";

/** A table as the applier holds it: everything owned, every contour's
 *  open flag present. */
export interface ModelTable {
  anchors: AnchorTriple[];
  subpathStarts: number[];
  subpathOpen: boolean[];
}

/** Coincidence for the `closePath` weld (the engine's tolerance). */
const WELD_EPS = 1e-3;

/** core's `smooth_handles_from_neighbours` degenerate-tangent floor. */
const TANGENT_EPS = 1e-6;

function copy(a: AnchorTriple): AnchorTriple {
  return {
    anchor: [a.anchor[0], a.anchor[1]],
    left: [a.left[0], a.left[1]],
    right: [a.right[0], a.right[1]],
  };
}

/** An owned copy of `table`. */
export function modelOf(table: AnchorTable): ModelTable {
  return {
    anchors: table.anchors.map(copy),
    subpathStarts: [...table.subpathStarts],
    subpathOpen: [...(table.subpathOpen ?? [])],
  };
}

/** The flat `[from, to)` range of the contour holding `index`. */
function contourRangeOf(t: ModelTable, index: number): [number, number] {
  const n = t.anchors.length;
  const starts = t.subpathStarts.length > 0 ? t.subpathStarts : [0];
  let from = 0;
  let to = n;
  for (let si = 0; si < starts.length; si++) {
    const s = starts[si];
    const e = si + 1 < starts.length ? starts[si + 1] : n;
    if (index >= s && index < e) {
      from = s;
      to = e;
      break;
    }
  }
  return [from, to];
}

/** Apply `ops` in order, onto a copy of `table`. Throws on an op the
 *  engine would reject (an index out of range) or that is not a one-table
 *  edit (`joinPaths`) — a plan that names one is a bug. */
export function applyPathOps(
  table: AnchorTable,
  ops: readonly PathPointOp[],
): ModelTable {
  const t = modelOf(table);
  for (const op of ops) {
    switch (op.op) {
      case "pathPointSet": {
        const a = t.anchors[op.index];
        if (!a) throw new RangeError(`pathPointSet index ${op.index}`);
        if (op.role === "anchor") {
          const dx = op.position[0] - a.anchor[0];
          const dy = op.position[1] - a.anchor[1];
          a.anchor = [op.position[0], op.position[1]];
          a.left = [a.left[0] + dx, a.left[1] + dy];
          a.right = [a.right[0] + dx, a.right[1] + dy];
        } else {
          a[op.role] = [op.position[0], op.position[1]];
        }
        break;
      }
      case "pathPointInsert": {
        if (op.index < 0 || op.index > t.anchors.length) {
          throw new RangeError(`pathPointInsert index ${op.index}`);
        }
        t.anchors.splice(op.index, 0, copy(op.anchor));
        t.subpathStarts = op.prevSubpathStarts
          ? [...op.prevSubpathStarts]
          : t.subpathStarts.map((s) => (s > op.index ? s + 1 : s));
        break;
      }
      case "pathPointRemove": {
        if (op.index < 0 || op.index >= t.anchors.length) {
          throw new RangeError(`pathPointRemove index ${op.index}`);
        }
        t.anchors.splice(op.index, 1);
        const shifted = t.subpathStarts
          .map((s) => (s > op.index ? s - 1 : s))
          .filter((s) => s < t.anchors.length);
        t.subpathStarts = shifted.filter((s, i) => i === 0 || s !== shifted[i - 1]);
        break;
      }
      case "pathPointCurveType": {
        const a = t.anchors[op.index];
        if (!a) throw new RangeError(`pathPointCurveType index ${op.index}`);
        const corner = () => {
          a.left = [a.anchor[0], a.anchor[1]];
          a.right = [a.anchor[0], a.anchor[1]];
        };
        if (!op.smooth) {
          corner();
          break;
        }
        const [from, to] = contourRangeOf(t, op.index);
        // A CLOSED contour of >= 3 anchors wraps: its first and last
        // anchors are each other's neighbours (core, since protocol 71).
        // A contour with no open flag reads as closed, as in core.
        const contour = Math.max(0, t.subpathStarts.indexOf(from));
        const closed = !(t.subpathOpen[contour] ?? false) && to - from >= 3;
        const prev =
          op.index > from
            ? t.anchors[op.index - 1].anchor
            : closed
              ? t.anchors[to - 1].anchor
              : null;
        const next =
          op.index + 1 < to
            ? t.anchors[op.index + 1].anchor
            : closed
              ? t.anchors[from].anchor
              : null;
        if (!prev || !next) {
          corner();
          break;
        }
        const tx = next[0] - prev[0];
        const ty = next[1] - prev[1];
        const len = Math.hypot(tx, ty);
        if (len < TANGENT_EPS) {
          corner();
          break;
        }
        const ux = tx / len;
        const uy = ty / len;
        const toPrev = Math.hypot(a.anchor[0] - prev[0], a.anchor[1] - prev[1]) / 3;
        const toNext = Math.hypot(next[0] - a.anchor[0], next[1] - a.anchor[1]) / 3;
        a.left = [a.anchor[0] - ux * toPrev, a.anchor[1] - uy * toPrev];
        a.right = [a.anchor[0] + ux * toNext, a.anchor[1] + uy * toNext];
        break;
      }
      case "closePath": {
        if (t.subpathStarts.length === 0) t.subpathStarts = [0];
        while (t.subpathOpen.length < t.subpathStarts.length) {
          t.subpathOpen.push(false);
        }
        const s = op.subpath;
        if (s < 0 || s >= t.subpathStarts.length) {
          throw new RangeError(`closePath subpath ${s}`);
        }
        if (!t.subpathOpen[s]) throw new Error(`subpath ${s} already closed`);
        const start = t.subpathStarts[s];
        const end = t.subpathStarts[s + 1] ?? t.anchors.length;
        if (end - start < 2) throw new Error("degenerate contour");
        const head = t.anchors[start];
        const tail = t.anchors[end - 1];
        const coincide =
          Math.abs(head.anchor[0] - tail.anchor[0]) <= WELD_EPS &&
          Math.abs(head.anchor[1] - tail.anchor[1]) <= WELD_EPS;
        if (coincide && end - start >= 3) {
          head.left = [tail.left[0], tail.left[1]];
          t.anchors.splice(end - 1, 1);
          for (let i = s + 1; i < t.subpathStarts.length; i++) {
            t.subpathStarts[i] -= 1;
          }
        }
        t.subpathOpen[s] = false;
        break;
      }
      case "joinPaths":
        throw new Error(
          "joinPaths welds two elements — it is not an edit of one table",
        );
    }
  }
  return t;
}

/**
 * Where an anchor index lands after `ops`: its new flat index, or null
 * when an op removed it. A contour END that a `closePath` weld merges
 * into its start lands on that start (the survivor). The machine
 * carries its SELECTION through an applied plan with this.
 */
export function remapIndexThrough(
  table: AnchorTable,
  ops: readonly PathPointOp[],
  index: number,
): number | null {
  let at: number | null = index;
  let t = modelOf(table);
  for (const op of ops) {
    if (at === null) return null;
    if (op.op === "pathPointInsert") {
      if (op.index <= at) at += 1;
    } else if (op.op === "pathPointRemove") {
      if (op.index === at) at = null;
      else if (op.index < at) at -= 1;
    } else if (op.op === "closePath") {
      const before = t.anchors.length;
      const starts = t.subpathStarts.length > 0 ? t.subpathStarts : [0];
      const start = starts[op.subpath] ?? 0;
      const end = starts[op.subpath + 1] ?? before;
      const after = applyPathOps(t, [op]);
      if (after.anchors.length < before) {
        // The weld removed the contour's LAST anchor (`end − 1`) into
        // its first.
        if (at === end - 1) at = start;
        else if (at > end - 1) at -= 1;
      }
      t = after;
      continue;
    }
    t = applyPathOps(t, [op]);
  }
  return at;
}
