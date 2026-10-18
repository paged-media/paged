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

// SCISSORS AT ANY POINT — the pure planner. The host's own Scissors
// (`paged.tool.scissors`) cuts at ANCHORS only, because `pathOpenAt`
// takes an anchor index. A cut anywhere on a segment is two ops the
// engine already has, in one batch:
//
//   1. split the segment at the click — the de Casteljau split
//      `planAnchorAdd` already plans (both neighbours' inner handles
//      rewritten at their OLD indices, then `pathPointInsert`), so the
//      curve is unchanged and a new anchor sits exactly where the cut is;
//   2. `pathOpenAt` at the new anchor's index.
//
// What `pathOpenAt` does there is the engine's (core `path_topology.rs`),
// pinned in the bundle's conformance spec: a CLOSED contour opens at the
// cut (the anchor is doubled into two coincident endpoints, every edge
// kept); an OPEN contour splits into TWO open contours of the same
// element sharing the cut point. An open contour's ENDPOINT cannot be
// cut (the engine refuses it as a no-op), so a click on one plans
// nothing.
//
// A click ON an existing anchor (within `tolerance`) cuts there with no
// insert — the host Scissors' own behaviour, kept so this tool is a
// superset of it rather than a different rule near anchors.

import type { ElementId } from "@paged-media/plugin-api";
import type { AnchorTable, Vec2 } from "@paged-media/draw-geometry";

import {
  nearestAnchorIndex,
  planAnchorAdd,
  type AnchorEditPlan,
} from "./anchor-machine";
import { anchorEditOps, lowerPathOp, type PathEditWireOp } from "./path-edit-ops";

/** Where a scissors click cuts. `index` is the flat index `pathOpenAt`
 *  receives — of the existing anchor, or of the anchor the insert lands. */
export type ScissorsPlan =
  | { kind: "anchor"; index: number }
  | {
      kind: "segment";
      insert: Extract<AnchorEditPlan, { kind: "insert" }>;
      index: number;
    };

/** `pathOpenAt` on the wire (asserted in `wire-compat.ts`). */
export interface PathOpenAtWire {
  op: "pathOpenAt";
  args: { elementId: ElementId; index: number };
}

/** The ONE batch a scissors cut is. */
export interface ScissorsBatchWire {
  op: "batch";
  args: { ops: (PathEditWireOp | PathOpenAtWire)[] };
}

/** Is `index` an endpoint of an OPEN contour of `table`? */
function isOpenEndpoint(table: AnchorTable, index: number): boolean {
  const n = table.anchors.length;
  const starts = table.subpathStarts.length > 0 ? table.subpathStarts : [0];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s]!;
    const to = s + 1 < starts.length ? starts[s + 1]! : n;
    if (index < from || index >= to) continue;
    return (table.subpathOpen?.[s] ?? false) && (index === from || index === to - 1);
  }
  return false;
}

/**
 * Plan a cut at `click` (path-INNER space, like the table). Null when
 * the click is on nothing within `tolerance`, or on an open contour's
 * endpoint (nothing to cut there).
 */
export function planScissorsAt(
  table: AnchorTable,
  click: Vec2,
  tolerance: number,
): ScissorsPlan | null {
  const onAnchor = nearestAnchorIndex(table, click, tolerance);
  if (onAnchor >= 0) {
    return isOpenEndpoint(table, onAnchor) ? null : { kind: "anchor", index: onAnchor };
  }
  const insert = planAnchorAdd(table, click, tolerance);
  if (!insert || insert.kind !== "insert") return null;
  return { kind: "segment", insert, index: insert.insertIndex };
}

/** Lower a plan to the ONE batch it is (one undo step). */
export function scissorsMutation(
  plan: ScissorsPlan,
  elementId: ElementId,
): ScissorsBatchWire {
  const ops: (PathEditWireOp | PathOpenAtWire)[] =
    plan.kind === "segment"
      ? anchorEditOps(plan.insert).map((op) => lowerPathOp(elementId, op))
      : [];
  ops.push({ op: "pathOpenAt", args: { elementId, index: plan.index } });
  return { op: "batch", args: { ops } };
}
