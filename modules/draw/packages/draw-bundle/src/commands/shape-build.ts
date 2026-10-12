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

// THE SHAPE BUILDER'S COMMIT — a `ShapeBuildPlan` (draw-tools, pure) turned
// into ONE batch, so a gesture is one undo step.
//
// WHY THE RESULT IS BUILT HERE. The engine's `pathfinderFaces { faces, mode }`
// builds ONE element from the named faces and drops every other face of every
// input (keep), or unites everything left into one element (remove). On a
// cross-shaped overlap a drag over two arms left only those two arms (the
// film bug). So the faces come from the engine's arrangement — the same faces
// the hover highlighted — and the result is assembled the way the Knife
// assembles its pieces (`commands/knife.ts`):
//
//   · a piece an input keeps is written ONTO the input (`framePath` +
//     `frameBounds`, the two writes core's own Divide gives a carrier): the
//     input keeps its id, effects, metadata and slot;
//   · every further piece is INSERTED, named by `bindCreated` and painted
//     like the shape that owned it there (fill, stroke colour, stroke weight —
//     the set core's own Divide gives the polygons it mints);
//   · the crossed faces are UNITED BY THE ENGINE: the carrier is rewritten to
//     one of them, the others are inserted as pieces, and
//     `pathfinderFaces { [carrier, …pieces], faces: [], mode: "remove" }`
//     unites everything it is given onto the carrier (nothing named, nothing
//     removed — so every face is selected). Adjacent faces of one arrangement
//     share their edges exactly, so that union is the arrangement's own.
//
// ORDER, all measured rules (CLAUDE.md "The batch-ORDERING rules"): every
// insert first (an insert after a delete is refused), then the rewrites, then
// the union (it removes the merged pieces), then the deletes.
//
// SPACE. Faces come back in the arrangement's RAW space — the inputs' own,
// assumed shared (the seam's named limit: the frontmost input's transform
// maps it to the page). A piece is inserted at its raw coordinates and given
// that transform, so it lands in the same space as the inputs it is united
// with; a rewrite writes raw coordinates onto an input that already has it.
//
// WHEN THE ENGINE'S ONE OP IS THE ANSWER. A gesture that crosses EVERY face
// of every input it touches, over inputs that are all paths and all touched,
// leaves nothing to keep: the engine's `pathfinderFaces { keep }` is exactly
// the result, and is sent as it always was.

import type {
  BundleHost,
  ElementId,
  MutationInput,
  PlanarFace,
} from "@paged-media/plugin-api";
import {
  contourRanges,
  orientForNonZeroHoles,
  tableBounds,
  type Affine,
  type AnchorTable,
} from "@paged-media/draw-geometry";
import type { ShapeBuildPlan } from "@paged-media/draw-tools";

import {
  compoundPaintOf,
  framePathMutationFor,
  type CompoundPaint,
} from "./compound-path";
import { MAX_PLANAR_INPUTS } from "../handlers/planar-regions";
import { faceTable } from "./knife";
import { pathfinderFacesMutationFor } from "./pathfinder-region";
import {
  batchMutationFor,
  bindCreatedMutationFor,
  handleElementId,
} from "./v59-wire";

/** The handle an inserted piece is named by. */
export const shapeBuildPieceHandle = (k: number): string => `sb-piece-${k}`;
/** The handle a merged face's piece is named by. */
export const shapeBuildMergeHandle = (k: number): string => `sb-merge-${k}`;

const isIdentity = (m: Affine | null): boolean =>
  !m || (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0);

/** A face as the table a piece / rewrite writes: closed, holes wound for the
 *  engine's non-zero fill. */
function pieceTable(face: Pick<PlanarFace, "anchors" | "subpathStarts">): AnchorTable {
  return orientForNonZeroHoles(faceTable(face));
}

/** The paint ops a piece inherits (fill, stroke colour, stroke weight). */
function paintOps(id: ElementId, paint: CompoundPaint): MutationInput[] {
  const ops: MutationInput[] = [
    {
      op: "setElementProperty",
      args: { elementId: id, path: "frameFillColor", value: { type: "colorRef", value: paint.fill } },
    },
    {
      op: "setElementProperty",
      args: { elementId: id, path: "frameStrokeColor", value: { type: "colorRef", value: paint.stroke } },
    },
  ];
  if (typeof paint.weight === "number") {
    ops.push({
      op: "setElementProperty",
      args: { elementId: id, path: "frameStrokeWeight", value: { type: "length", value: paint.weight } },
    });
  }
  return ops;
}

/** Insert `table` (raw space) as a new path named `handle`, in the
 *  arrangement's space: first contour by `insertPath`, the whole table by
 *  `framePath` when there are holes / more contours, the transform last. */
function insertPieceOps(
  pageId: string,
  table: AnchorTable,
  handle: string,
  matrix: Affine | null,
): MutationInput[] {
  const ranges = contourRanges(table.anchors.length, table.subpathStarts);
  const [from, to] = ranges[0] ?? [0, table.anchors.length];
  const ops: MutationInput[] = [
    {
      op: "insertPath",
      args: {
        pageId,
        anchors: table.anchors.slice(from, to).map((a) => ({
          anchor: [a.anchor[0], a.anchor[1]] as [number, number],
          left: [a.left[0], a.left[1]] as [number, number],
          right: [a.right[0], a.right[1]] as [number, number],
        })),
        open: false,
      },
    },
    bindCreatedMutationFor(handle),
  ];
  if (ranges.length > 1) ops.push(framePathMutationFor(handleElementId(handle), table));
  if (!isIdentity(matrix)) {
    ops.push({
      op: "setElementProperty",
      args: {
        elementId: handleElementId(handle),
        path: "frameTransform",
        value: { type: "transform", value: [...matrix!] as [number, number, number, number, number, number] },
      },
    });
  }
  return ops;
}

/** Rewrite an existing input to `table` (raw space): its path, and its frame
 *  box following it. */
function rewriteOps(id: ElementId, table: AnchorTable): MutationInput[] {
  const ops: MutationInput[] = [framePathMutationFor(id, table)];
  const box = tableBounds(table);
  if (box) {
    ops.push({
      op: "setElementProperty",
      args: { elementId: id, path: "frameBounds", value: { type: "bounds", value: box } },
    });
  }
  return ops;
}

/** Everything a plan needs that the document holds: the faces (raw, by id),
 *  the arrangement's transform, the page, and each input's paint. */
export interface ShapeBuildContext {
  /** The request's inputs, TOP-TO-BOTTOM (the arrangement's index order). */
  inputs: readonly ElementId[];
  faces: ReadonlyMap<string, Pick<PlanarFace, "anchors" | "subpathStarts">>;
  matrix: Affine | null;
  pageId: string;
  /** Paint per input index — read for every input a piece is painted from. */
  paints: ReadonlyMap<number, CompoundPaint>;
}

/** The input indices whose paint a plan copies onto inserted pieces. */
export function paintSourcesOf(plan: ShapeBuildPlan): number[] {
  const out = new Set<number>(plan.inserts.map((i) => i.paintFrom));
  if (plan.merge?.carrier === "piece") out.add(plan.merge.owner);
  return [...out].sort((a, b) => a - b);
}

/** Whether a plan leaves nothing but the merge — then the engine's own
 *  `pathfinderFaces { keep }` over the inputs IS the result. */
export function planIsEngineKeep(plan: ShapeBuildPlan): boolean {
  return (
    plan.merge !== null &&
    plan.merge.carrier === "input" &&
    plan.inserts.length === 0 &&
    plan.rewrites.length === 0 &&
    plan.untouched.length === 0
  );
}

/**
 * The ONE batch a plan commits (see the module header). Null when a face the
 * plan names is not in `ctx.faces` — nothing is sent rather than a part of
 * the result.
 */
export function shapeBuildBatchFor(
  plan: ShapeBuildPlan,
  ctx: ShapeBuildContext,
): MutationInput | null {
  const table = (id: string): AnchorTable | null => {
    const f = ctx.faces.get(id);
    return f ? pieceTable(f) : null;
  };
  const inserts: MutationInput[] = [];
  const rewrites: MutationInput[] = [];
  const union: MutationInput[] = [];
  const deletes: MutationInput[] = [];
  const noPaint: CompoundPaint = { fill: null, stroke: null, weight: null };

  // Every piece that stays, painted like its owner.
  for (const [k, ins] of plan.inserts.entries()) {
    const t = table(ins.face);
    if (!t) return null;
    const handle = shapeBuildPieceHandle(k);
    inserts.push(
      ...insertPieceOps(ctx.pageId, t, handle, ctx.matrix),
      ...paintOps(handleElementId(handle), ctx.paints.get(ins.paintFrom) ?? noPaint),
    );
  }

  // Every input that keeps a piece in place.
  for (const r of plan.rewrites) {
    const t = table(r.face);
    if (!t) return null;
    rewrites.push(...rewriteOps(ctx.inputs[r.input]!, t));
  }

  // The merge: the carrier holds the first crossed face, the rest are
  // inserted beside it and united onto it by the engine.
  if (plan.merge) {
    const { faces, owner, carrier } = plan.merge;
    const tables = faces.map(table);
    if (tables.some((t) => t === null)) return null;
    let carrierId: ElementId;
    let first = 0;
    if (carrier === "input") {
      carrierId = ctx.inputs[owner]!;
      rewrites.push(...rewriteOps(carrierId, tables[0]!));
      first = 1;
    } else {
      const handle = shapeBuildMergeHandle(0);
      carrierId = handleElementId(handle);
      inserts.push(
        ...insertPieceOps(ctx.pageId, tables[0]!, handle, ctx.matrix),
        ...paintOps(carrierId, ctx.paints.get(owner) ?? noPaint),
      );
      first = 1;
    }
    const rest: ElementId[] = [];
    for (let k = first; k < tables.length; k++) {
      const handle = shapeBuildMergeHandle(k);
      inserts.push(...insertPieceOps(ctx.pageId, tables[k]!, handle, ctx.matrix));
      rest.push(handleElementId(handle));
    }
    // The engine's arrangement takes at most 12 inputs: unite in runs of
    // eleven onto the carrier, each run growing it.
    for (let k = 0; k < rest.length; k += MAX_PLANAR_INPUTS - 1) {
      const run = rest.slice(k, k + MAX_PLANAR_INPUTS - 1);
      union.push(pathfinderFacesMutationFor([carrierId, ...run], [], "remove") as MutationInput);
    }
  }

  for (const i of plan.deletes) {
    deletes.push({ op: "deleteFrame", args: { frameId: String(ctx.inputs[i]!.id) } });
  }
  return batchMutationFor([...inserts, ...rewrites, ...union, ...deletes]);
}

/** Read the paint of every input a plan copies onto a piece. */
export async function shapeBuildPaints(
  host: BundleHost,
  plan: ShapeBuildPlan,
  inputs: readonly ElementId[],
): Promise<Map<number, CompoundPaint>> {
  const out = new Map<number, CompoundPaint>();
  for (const i of paintSourcesOf(plan)) {
    const id = inputs[i];
    if (id) out.set(i, await compoundPaintOf(host, id));
  }
  return out;
}
