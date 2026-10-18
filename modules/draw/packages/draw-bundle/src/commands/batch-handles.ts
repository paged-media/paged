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

// BATCH HANDLES (C-15) — `bindCreated`, the `"$h:"` reference it arms,
// the batch that carries them, and the B-18 nesting pair that is always
// addressed through them.
//
// `bindCreated` is what collapses a two-batch flow into ONE undo step: a
// bundle that inserts geometry and then paints, links or groups it names
// each creation and addresses it by that name later in the same batch.
// THREE RULES, each measured against the booted engine rather than
// assumed, because getting any of them wrong fails in a confusing way:
//   1. the bind must come AFTER its creating child. Placed before, the
//      batch is refused BY NAME ("has nothing to name — no creating
//      child ran before it in this batch");
//   2. it is its OWN op, not a field. A handle inside a creating op's
//      own `args` is SILENTLY IGNORED, and the later `$h:` then fails
//      with "node not found";
//   3. scope is the declaring batch. A `$h:` in TEXT content is content
//      and is never rewritten.
//
// MEASURED HERE, and every one of these is a position this bundle
// actually uses: `"$h:<handle>"` resolves in an `ElementId.id`, in a
// bare-string `deleteFrame.frameId`, in `setElementProperty.elementId`
// (including the `framePath` door), in a `createGroup.memberIds` entry
// and at BOTH ends of `pasteInto`. 200 inserts + binds + property writes
// apply in one batch in ~12 ms and ONE undo removes all of them.

import type { ElementId, Mutation } from "@paged-media/plugin-api";

/** The prefix a batch-local handle is referenced by. */
export const HANDLE_PREFIX = "$h:";

/** C-15 — name the id the PRECEDING creating child minted, so a LATER
 *  child of the same batch can address it as `"$h:<handle>"`. */
export function bindCreatedMutationFor(handle: string): Mutation {
  return { op: "bindCreated", args: { handle } };
}

/** A `"$h:<handle>"` reference as an `ElementId` of `kind`. `insertPath`
 *  mints Polygons, so that is the default.
 *
 *  `kind` is narrowed to the kinds whose `id` is a STRING: `storyRange`,
 *  `table` and `tableCell` key on a STRUCTURED id (story + offsets,
 *  story + table, story + table + row/col), and there is no way to
 *  express "the thing the previous op minted" in those shapes. A handle
 *  addresses a page ITEM; the three structured kinds are addresses
 *  INSIDE a story, which no creating op mints. */
type HandleableElementId = Extract<ElementId, { id: string }>;

export function handleElementId(
  handle: string,
  kind: HandleableElementId["kind"] = "polygon",
): HandleableElementId {
  return { kind, id: `${HANDLE_PREFIX}${handle}` } as HandleableElementId;
}

/** B-18 — nest an existing TOP-LEVEL page item inside a container
 *  Rectangle / Oval / Polygon. The child keeps its document-space
 *  geometry (nothing moves on canvas) and renders CLIPPED by the
 *  container's outline. */
export function pasteIntoMutationFor(containerId: ElementId, childId: ElementId): Mutation {
  return { op: "pasteInto", args: { containerId, childId } };
}

/** B-18 — the inverse: pop a pasted-in child back to top level (it
 *  stacks on top), world transform preserved. */
export function releaseFromMutationFor(childId: ElementId): Mutation {
  return { op: "releaseFrom", args: { childId } };
}

/** One batch = one undo step. */
export function batchMutationFor(ops: readonly Mutation[]): Mutation {
  return { op: "batch", args: { ops: [...ops] } };
}
