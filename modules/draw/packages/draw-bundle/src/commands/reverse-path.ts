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

// REVERSE PATH DIRECTION — the traversal order of every contour of every
// selected path, flipped.
//
// WHY A VERB THAT CHANGES NOTHING YOU CAN SEE. On a plain filled or
// stroked path it is a visual no-op, and that is the point: direction is
// INVISIBLE state that two other things read. Under the engine's NON-ZERO
// fill a contour's winding decides whether it is a hole (the compound
// path's whole mechanism, `orientForNonZeroHoles`), and Type on a Path
// runs its text in the path's direction — so a story set upside down on
// the bottom of a circle is fixed by reversing the circle, not by
// redrawing it. (An arrowhead is direction too: a GraphicLine's start
// and end arrowheads swap ends, as they do in Illustrator.)
//
// THE MATH IS NOT HERE. `reverseContour` (draw-geometry `compound.ts`) is
// the one reversal in this repo — the compound path re-winds holes with
// it — and it is exact: each anchor's handles swap (`left` ⇄ `right`,
// because the outgoing handle becomes the incoming one), an OPEN contour
// reverses outright (its endpoints swap), and a CLOSED contour keeps its
// FIRST anchor first and reverses the rest, so the start point stays put.
// This module only decides, per contour, which of the two it is.
//
// THE WRITE DOOR is `framePath` (`setElementProperty { framePath }`), the
// whole-table replace the compound path uses (`framePathMutationFor`).
// Two facts about it decide the shape of this command, and both are
// asserted against the engine:
//   · the table it takes is in the element's OWN (inner) space — the
//     space `pathAnchors` answers in — so the reversal needs no
//     transform at all: direction is affine-invariant;
//   · its value carries `anchors` + `subpathStarts` and NO `subpathOpen`.
//     The element's own open flags survive the write when the contour
//     COUNT is unchanged — which a reversal guarantees — so an open path
//     stays open and a closed one closed. (That is why this is safe on
//     open paths where Make Compound Path is not.)
//
// ONE UNDO STEP: every selected path's write rides one batch.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  PathAnchorsResult,
} from "@paged-media/plugin-api";
import { reverseContour, type AnchorTable } from "@paged-media/draw-geometry";

import { framePathMutationFor } from "./compound-path";
import { supportsPathOps } from "./path-ops";

export const REVERSE_PATH_COMMAND_ID =
  "media.paged.draw.command.reversePathDirection";

export const REVERSE_PATH_COMMAND_CATEGORY = "Path";

/** The contributed command ids, in registration order. */
export const REVERSE_PATH_COMMAND_IDS = [REVERSE_PATH_COMMAND_ID];

/**
 * Every contour of `table` reversed in place: contour `i` keeps its slot
 * and its length (so `subpathStarts` and `subpathOpen` are unchanged),
 * and is reversed as OPEN or CLOSED by its own flag — read by its
 * ORIGINAL index, an absent flag being closed (the renderer's
 * `subpath_open.get(i).unwrap_or(false)`). Pure; exported for the spec.
 */
export function reverseTable(table: AnchorTable): AnchorTable {
  const n = table.anchors.length;
  const starts = table.subpathStarts.length > 0 ? table.subpathStarts : [0];
  const anchors = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : n;
    const open = table.subpathOpen?.[i] === true;
    anchors.push(
      ...reverseContour(table.anchors.slice(from, to), { closed: !open }),
    );
  }
  return {
    anchors,
    subpathStarts: [...table.subpathStarts],
    ...(table.subpathOpen ? { subpathOpen: [...table.subpathOpen] } : {}),
  };
}

/** The table `pathAnchors` answered, as draw-geometry's `AnchorTable`. */
export function tableOf(read: PathAnchorsResult): AnchorTable {
  return {
    anchors: read.anchors.map((a) => ({
      anchor: [a.anchor[0], a.anchor[1]],
      left: [a.left[0], a.left[1]],
      right: [a.right[0], a.right[1]],
    })),
    subpathStarts: [...read.subpathStarts],
    ...(read.subpathOpen ? { subpathOpen: [...read.subpathOpen] } : {}),
  };
}

/** The ONE batch that reverses every `[id, table]` given. Null when
 *  there is nothing to write. */
export function reversePathBatchFor(
  targets: readonly (readonly [ElementId, AnchorTable])[],
): Mutation | null {
  const ops = targets.map(([id, table]) =>
    framePathMutationFor(id, reverseTable(table)),
  );
  if (ops.length === 0) return null;
  return { op: "batch", args: { ops } };
}

/** Reverse every selected path. Answers the ids it reversed (empty =
 *  a no-op, logged). A path with fewer than two anchors has no
 *  direction and is skipped; so is an element with no anchor table (a
 *  bounds-only IDML `<Rectangle>` has no `<PathGeometry>` to reverse). */
export async function applyReversePath(host: BundleHost): Promise<ElementId[]> {
  const selected = host.selection.get().filter(supportsPathOps);
  if (selected.length === 0) {
    host.log.debug(`${REVERSE_PATH_COMMAND_ID}: no path-bearing selection — no-op`);
    return [];
  }
  const targets: [ElementId, AnchorTable][] = [];
  for (const id of selected) {
    const read = await host.document.pathAnchors(id).catch(() => null);
    if (!read || read.anchors.length < 2) {
      host.log.debug(
        `${REVERSE_PATH_COMMAND_ID}: ${id.kind} ${String(id.id)} has no ` +
          "direction to reverse (no anchor table, or a single anchor) — skipped",
      );
      continue;
    }
    targets.push([id, tableOf(read)]);
  }
  const batch = reversePathBatchFor(targets);
  if (!batch) return [];
  const outcome = await host.document.mutate(batch);
  if (!outcome.applied) {
    host.log.warn(
      `${REVERSE_PATH_COMMAND_ID} rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
    return [];
  }
  return targets.map(([id]) => id);
}

export function contributeReversePathCommands(host: BundleHost): Disposable {
  const sub = host.contribute.command({
    id: REVERSE_PATH_COMMAND_ID,
    title: "Path: Reverse path direction",
    category: REVERSE_PATH_COMMAND_CATEGORY,
    handler: () => applyReversePath(host),
  });
  return { dispose: () => sub.dispose() };
}
