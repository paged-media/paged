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

// The path-edit OP vocabulary the Direct Selection and Pen machines plan
// in, and the one lowering that turns a plan into engine wire shapes.
//
// TWO LAYERS, deliberately:
//
//   · `PathPointOp` — what a machine emits. Element-less (a machine
//     never knows which document element its anchor table came from),
//     flat-indexed across contours, positions in the path's OWN (inner)
//     coordinate space. `TargetedPathOp` is the same thing carrying its
//     element, for the Pen, whose plans can span two paths.
//   · the `*Wire` shapes — hand-declared mirrors of the engine's
//     `Mutation` variants. `wire-compat.ts` asserts every one of them
//     against the vendored union, so a protocol change that moves a
//     field fails `pnpm typecheck` HERE rather than at the first drag.
//
// ORDER IS PART OF THE PLAN. Ops apply sequentially and indices are
// resolved against the table as the PREVIOUS op left it: a
// `pathPointSet` on an anchor drags both of that anchor's handles by the
// same delta (the engine's rule), so a handle write for the same anchor
// must follow it; removes run in DESCENDING index order; inserts carry
// the index the anchor lands at.
//
// ONE BATCH = ONE UNDO STEP. Every lowering here returns a `batch`, even
// for a single op, so a gesture is always exactly one Cmd-Z.

import type { ElementId } from "@paged-media/plugin-api";
import type { AnchorTriple } from "@paged-media/draw-geometry";

import type { AnchorEditPlan } from "./anchor-machine";

/** Which control point of an anchor: the on-curve point or one of its
 *  two Bézier handles (`left` = incoming, `right` = outgoing). */
export type PathPointRole = "anchor" | "left" | "right";

/** One planned edit on ONE path. Positions are path-inner coordinates. */
export type PathPointOp =
  | {
      op: "pathPointSet";
      index: number;
      role: PathPointRole;
      position: [number, number];
    }
  | {
      op: "pathPointInsert";
      /** The flat index the new anchor lands at (`anchors.length` =
       *  append). */
      index: number;
      anchor: AnchorTriple;
      /** The contour starts as they must read AFTER this insert. Needed
       *  exactly when the anchor is appended to a contour that is not
       *  the last one: the engine's default rule bumps only the starts
       *  strictly greater than `index`, which would file the new anchor
       *  as the FIRST point of the following contour. */
      prevSubpathStarts?: number[];
    }
  | { op: "pathPointRemove"; index: number }
  | { op: "pathPointCurveType"; index: number; smooth: boolean }
  | { op: "closePath"; subpath: number }
  | { op: "joinPaths"; otherId: ElementId };

/** A `PathPointOp` addressed at its element — the Pen's plans, which
 *  may touch the continued path AND the path it joins. */
export type TargetedPathOp = PathPointOp & { elementId: ElementId };

// ---- wire shapes (asserted against `Mutation` in wire-compat.ts) ------

export interface PathPointSetWire {
  op: "pathPointSet";
  args: {
    elementId: ElementId;
    index: number;
    role: PathPointRole;
    position: [number, number];
  };
}

export interface PathPointInsertWire {
  op: "pathPointInsert";
  args: {
    elementId: ElementId;
    index: number;
    anchor: AnchorTriple;
    prevSubpathStarts?: number[];
  };
}

export interface PathPointRemoveWire {
  op: "pathPointRemove";
  args: { elementId: ElementId; index: number };
}

export interface PathPointCurveTypeWire {
  op: "pathPointCurveType";
  args: { elementId: ElementId; index: number; smooth: boolean };
}

export interface ClosePathWire {
  op: "closePath";
  args: { elementId: ElementId; subpath: number };
}

export interface JoinPathsWire {
  op: "joinPaths";
  args: { elementId: ElementId; otherId: ElementId };
}

export interface InsertPathWire {
  op: "insertPath";
  args: {
    pageId: string;
    anchors: AnchorTriple[];
    open: boolean;
    smooth: boolean;
  };
}

export type PathEditWireOp =
  | PathPointSetWire
  | PathPointInsertWire
  | PathPointRemoveWire
  | PathPointCurveTypeWire
  | ClosePathWire
  | JoinPathsWire;

/** One undo step's worth of path edits. */
export interface PathEditBatchWire {
  op: "batch";
  args: { ops: PathEditWireOp[] };
}

// ---- lowering ---------------------------------------------------------

/** Lower ONE planned op to its wire shape on `elementId`. */
export function lowerPathOp(
  elementId: ElementId,
  op: PathPointOp,
): PathEditWireOp {
  switch (op.op) {
    case "pathPointSet":
      return {
        op: "pathPointSet",
        args: {
          elementId,
          index: op.index,
          role: op.role,
          position: [op.position[0], op.position[1]],
        },
      };
    case "pathPointInsert":
      return {
        op: "pathPointInsert",
        args: {
          elementId,
          index: op.index,
          anchor: op.anchor,
          ...(op.prevSubpathStarts !== undefined
            ? { prevSubpathStarts: op.prevSubpathStarts }
            : {}),
        },
      };
    case "pathPointRemove":
      return { op: "pathPointRemove", args: { elementId, index: op.index } };
    case "pathPointCurveType":
      return {
        op: "pathPointCurveType",
        args: { elementId, index: op.index, smooth: op.smooth },
      };
    case "closePath":
      return { op: "closePath", args: { elementId, subpath: op.subpath } };
    case "joinPaths":
      return { op: "joinPaths", args: { elementId, otherId: op.otherId } };
  }
}

/** Lower a single-path op list to ONE batch (one undo step). */
export function pathEditBatch(
  elementId: ElementId,
  ops: readonly PathPointOp[],
): PathEditBatchWire {
  return {
    op: "batch",
    args: { ops: ops.map((op) => lowerPathOp(elementId, op)) },
  };
}

/** Lower an element-addressed op list to ONE batch (one undo step). */
export function targetedPathEditBatch(
  ops: readonly TargetedPathOp[],
): PathEditBatchWire {
  return {
    op: "batch",
    args: {
      ops: ops.map(({ elementId, ...op }) =>
        lowerPathOp(elementId, op as PathPointOp),
      ),
    },
  };
}

/**
 * An `AnchorEditPlan` (the Add / Delete / Convert planners' output) in
 * this vocabulary, so a click the Pen resolves to "add an anchor here"
 * rides the same lowering as everything else. The insert keeps the
 * planners' dispatch order: both endpoint handles are rewritten at their
 * OLD flat indices first, then the new anchor lands.
 */
export function anchorEditOps(plan: AnchorEditPlan): PathPointOp[] {
  switch (plan.kind) {
    case "remove":
      return [{ op: "pathPointRemove", index: plan.index }];
    case "convert":
      return [
        { op: "pathPointCurveType", index: plan.index, smooth: plan.smooth },
      ];
    case "insert":
      return [
        {
          op: "pathPointSet",
          index: plan.segStart,
          role: "right",
          position: [plan.startRight[0], plan.startRight[1]],
        },
        {
          op: "pathPointSet",
          index: plan.segEnd,
          role: "left",
          position: [plan.endLeft[0], plan.endLeft[1]],
        },
        {
          op: "pathPointInsert",
          index: plan.insertIndex,
          anchor: plan.anchor,
          ...(plan.prevSubpathStarts !== undefined
            ? { prevSubpathStarts: plan.prevSubpathStarts }
            : {}),
        },
      ];
  }
}
