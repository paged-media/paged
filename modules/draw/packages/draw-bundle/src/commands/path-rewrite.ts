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

// PATH REWRITES — the ops the WP6.1 path tools (Simplify's corner lane,
// Reshape, the Path Eraser, the Join tool) write with. One place, so
// each tool's batch is the same shape:
//
//   · REWRITE an existing path: `framePath` (its anchors and contour
//     starts, INNER space — the open flags are not on that door and are
//     kept) and `frameBounds` following it, the two writes core's own
//     Divide gives a carrier (`commands/knife.ts`). The bounds matter:
//     the engine does not recompute them from a `framePath` write.
//   · INSERT an open piece: `insertPath { open: true }` in PAGE space,
//     named by `bindCreated`, painted like the path it came from.
//   · OPEN a closed contour: `pathOpenAt`, before a rewrite, because the
//     rewrite cannot change the open flag.

import type {
  BundleHost,
  ElementId,
  MutationInput,
  PathAnchorsResult,
} from "@paged-media/plugin-api";
import {
  applyAffine,
  tableBounds,
  type Affine,
  type AnchorTable,
  type AnchorTriple,
} from "@paged-media/draw-geometry";

import { bindCreatedMutationFor, handleElementId } from "./batch-handles";
import { framePathMutationFor, type CompoundPaint } from "./compound-path";

/** `framePath` + `frameBounds` for `table` (inner space). */
export function rewritePathOps(
  id: ElementId,
  table: AnchorTable,
): MutationInput[] {
  const ops: MutationInput[] = [framePathMutationFor(id, table)];
  const box = tableBounds(table);
  if (box) {
    ops.push({
      op: "setElementProperty",
      args: {
        elementId: id,
        path: "frameBounds",
        value: { type: "bounds", value: box },
      },
    });
  }
  return ops;
}

/** One open contour as a table. */
export const openTable = (anchors: readonly AnchorTriple[]): AnchorTable => ({
  anchors,
  subpathStarts: [0],
  subpathOpen: [true],
});

/** `anchors` (inner space of a path with transform `m`) in page space. */
export function anchorsToPage(
  anchors: readonly AnchorTriple[],
  m: Affine | null,
): AnchorTriple[] {
  const map = (p: readonly [number, number]): [number, number] => {
    const q = applyAffine(m, p[0], p[1]);
    return [q[0], q[1]];
  };
  return anchors.map((a) => ({
    anchor: map(a.anchor),
    left: map(a.left),
    right: map(a.right),
  }));
}

/** The paint ops a new piece inherits. */
export function paintOps(
  id: ElementId,
  paint: CompoundPaint,
): MutationInput[] {
  const ops: MutationInput[] = [
    {
      op: "setElementProperty",
      args: {
        elementId: id,
        path: "frameFillColor",
        value: { type: "colorRef", value: paint.fill },
      },
    },
    {
      op: "setElementProperty",
      args: {
        elementId: id,
        path: "frameStrokeColor",
        value: { type: "colorRef", value: paint.stroke },
      },
    },
  ];
  if (typeof paint.weight === "number") {
    ops.push({
      op: "setElementProperty",
      args: {
        elementId: id,
        path: "frameStrokeWeight",
        value: { type: "length", value: paint.weight },
      },
    });
  }
  return ops;
}

/** Insert an OPEN piece (page space) named `handle`, painted `paint`. */
export function insertOpenPieceOps(
  pageId: string,
  pageAnchors: readonly AnchorTriple[],
  handle: string,
  paint: CompoundPaint,
): MutationInput[] {
  return [
    {
      op: "insertPath",
      args: {
        pageId,
        anchors: pageAnchors.map((a) => ({
          anchor: [a.anchor[0], a.anchor[1]] as [number, number],
          left: [a.left[0], a.left[1]] as [number, number],
          right: [a.right[0], a.right[1]] as [number, number],
        })),
        open: true,
      },
    },
    bindCreatedMutationFor(handle),
    ...paintOps(handleElementId(handle), paint),
  ];
}

/** A `pathAnchors` read as a table, and its transform. */
export function tableOfRead(read: PathAnchorsResult): {
  table: AnchorTable;
  matrix: Affine | null;
} {
  return {
    table: {
      anchors: read.anchors,
      subpathStarts: read.subpathStarts,
      subpathOpen: read.subpathOpen,
    },
    matrix: (read.itemTransform ?? null) as Affine | null,
  };
}

/** The path kinds these tools edit (`pathAnchors` answers them; a text
 *  frame is left out — its story is not a stroke). */
export const EDITABLE_PATH_KINDS: ReadonlySet<string> = new Set([
  "polygon",
  "rectangle",
  "graphicLine",
]);

/** Read `id`'s path when it is one these tools edit. */
export async function readEditablePath(
  host: BundleHost,
  id: ElementId,
): Promise<(PathAnchorsResult & { id: ElementId }) | null> {
  if (!EDITABLE_PATH_KINDS.has(id.kind)) return null;
  const read = await host.document.pathAnchors(id).catch(() => null);
  if (!read || read.anchors.length < 2) return null;
  return { ...read, id };
}
