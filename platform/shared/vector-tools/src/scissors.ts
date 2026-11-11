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
// insert. `applyScissorsAt` is the whole cut over a document door: the
// host Scissors tool (`paged.tool.scissors`, in every context) and
// paged.draw's `scissorsAt` command both cut through it, any point,
// through the path's transform.

import type { ElementId } from "@paged-media/plugin-api";
import {
  affineScale,
  inverseApplyAffine,
  type Affine,
  type AnchorTable,
  type Vec2,
} from "@paged-media/vector-geometry";

import {
  nearestAnchorIndex,
  planAnchorAdd,
  type AnchorEditPlan,
} from "./anchor-machine";
import {
  anchorEditOps,
  lowerPathOp,
  type PathEditWireOp,
  type WireOp,
} from "./path-edit-ops";

/** Where a scissors click cuts. `index` is the flat index `pathOpenAt`
 *  receives — of the existing anchor, or of the anchor the insert lands. */
export type ScissorsPlan =
  | { kind: "anchor"; index: number }
  | {
      kind: "segment";
      insert: Extract<AnchorEditPlan, { kind: "insert" }>;
      index: number;
    };

/** `pathOpenAt` on the wire (the contract's variant). */
export type PathOpenAtWire = WireOp<"pathOpenAt">;

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
    return (
      (table.subpathOpen?.[s] ?? false) && (index === from || index === to - 1)
    );
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
    return isOpenEndpoint(table, onAnchor)
      ? null
      : { kind: "anchor", index: onAnchor };
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

/** The path kinds `pathOpenAt` accepts. */
export const SCISSORS_CUTTABLE: ReadonlySet<string> = new Set([
  "polygon",
  "rectangle",
  "textFrame",
  "graphicLine",
]);

/** What a cut reads and writes: a path's anchors (its own space, with the
 *  transform into the page) and one mutation. The editor's client and a
 *  bundle's `host.document` both serve it. */
export interface ScissorsDoor {
  pathAnchors(target: ElementId): Promise<{
    pageId?: string | null;
    anchors: AnchorTable["anchors"];
    subpathStarts: readonly number[];
    subpathOpen?: readonly boolean[];
    itemTransform?: readonly number[] | null;
  } | null>;
  /** Apply one mutation; true when the engine applied it. */
  mutate(m: ScissorsBatchWire | PathOpenAtWire): Promise<boolean>;
}

/**
 * Cut `target` at `pagePoint` (page-local pt on `pageId`): on an anchor
 * within `tolerancePt` (page pt, scaled into the path's space), else
 * anywhere on a segment. Null when nothing is cut there (no anchor or
 * segment in reach, an open contour's endpoint, a path kind that cannot
 * be cut, a refusal). An anchor cut is one `pathOpenAt`; a segment cut
 * one batch (insert, then open): one undo step either way.
 */
export async function applyScissorsAt(
  door: ScissorsDoor,
  target: ElementId,
  pageId: string,
  pagePoint: Vec2,
  tolerancePt: number,
): Promise<ScissorsPlan | null> {
  if (!SCISSORS_CUTTABLE.has(target.kind)) return null;
  const read = await door.pathAnchors(target).catch(() => null);
  if (!read || read.anchors.length < 2 || read.pageId !== pageId) return null;
  const m = (read.itemTransform ?? null) as Affine | null;
  const local = inverseApplyAffine(m, pagePoint[0], pagePoint[1]);
  if (!local) return null;
  const plan = planScissorsAt(
    {
      anchors: read.anchors,
      subpathStarts: read.subpathStarts,
      subpathOpen: read.subpathOpen,
    },
    local,
    tolerancePt / affineScale(m),
  );
  if (!plan) return null;
  const batch = scissorsMutation(plan, target);
  const op = plan.kind === "anchor" ? batch.args.ops[0]! : batch;
  return (await door.mutate(op as ScissorsBatchWire | PathOpenAtWire))
    ? plan
    : null;
}
