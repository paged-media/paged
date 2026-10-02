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

// A REFERENCE MODEL of how the engine applies the path-point ops, in
// plain TS, so a machine's plan can be checked for what it DOES and not
// just for how it reads. Each rule mirrors core's apply layer
// (`paged-mutate/src/apply/path_topology.rs` + the `FramePathPoint`
// arm of `set_property.rs`):
//
//   pathPointSet    anchor → the anchor AND both handles move by the
//                   same delta; left / right → that handle only.
//   pathPointInsert the anchor lands at `index` (≤ length). The contour
//                   starts are REPLACED by `prevSubpathStarts` when it
//                   is given; otherwise every start strictly greater
//                   than `index` is bumped.
//   pathPointRemove every start strictly greater than `index` drops by
//                   one; starts off the end are trimmed, equal
//                   neighbours de-duplicated.
//   closePath       the named contour stops being open; endpoints that
//                   coincide (a contour of ≥ 3) merge into one anchor.
//
// A model can be wrong in the same way as the code it checks, which is
// why it is not the last word: `draw-bundle`'s conformance specs replay
// the same plans through the REAL engine.

import type { AnchorTable, AnchorTriple } from "@paged-media/draw-geometry";

import type { PathPointOp } from "../../src/path-edit-ops";

export interface ModelTable {
  anchors: AnchorTriple[];
  subpathStarts: number[];
  subpathOpen: boolean[];
}

const WELD_EPS = 1e-3;

function copy(a: AnchorTriple): AnchorTriple {
  return {
    anchor: [a.anchor[0], a.anchor[1]],
    left: [a.left[0], a.left[1]],
    right: [a.right[0], a.right[1]],
  };
}

export function modelOf(table: AnchorTable): ModelTable {
  return {
    anchors: table.anchors.map(copy),
    subpathStarts: [...table.subpathStarts],
    subpathOpen: [...(table.subpathOpen ?? [])],
  };
}

/** Apply `ops` in order. Throws on an op the engine would reject (an
 *  index out of range) — a plan that names one is a bug. */
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
      default:
        throw new Error(`op ${op.op} is not modelled`);
    }
  }
  return t;
}

/** The anchors of contour `index`, as the model holds them. */
export function contourOf(table: ModelTable, index: number): AnchorTriple[] {
  const starts = table.subpathStarts.length > 0 ? table.subpathStarts : [0];
  return table.anchors.slice(
    starts[index],
    starts[index + 1] ?? table.anchors.length,
  );
}
