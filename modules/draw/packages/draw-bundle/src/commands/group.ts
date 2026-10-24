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

// The GROUP wire shapes (B-04) — `createGroup { memberIds }` and
// `dissolveGroup { groupId }`, protocol >= 35, nesting since W1.20.
//
// THIS MODULE NO LONGER CONTRIBUTES COMMANDS. "Group selection",
// "Ungroup" and "Select: Parent group" were paged.draw's, which meant a
// user without the vector plugin loaded could not group — although both
// ops have been on the wire the whole time. They are now HOST commands
// in the editor (`paged.object.group` / `paged.object.ungroup` /
// `paged.object.selectParentGroup`, `apps/canvas/src/object-commands.ts`,
// which also brings the four Arrange verbs the editor never had). Basic
// object operations are what plugins BUILD ON, so exactly one
// implementation ships, and it is the host's.
//
// What stays here is what draw's OWN features compose: Pattern Editing
// re-plans a tile field by grouping the copies and dissolving the old
// group, Symbols groups an instance's re-emitted leaves, and Image Trace
// groups the traced contours. Those are wire calls inside a larger
// batch, not a user-facing verb, so they keep their one shared shape
// rather than open-coding the op three times.
//
// A CLIP GROUP IS REPRESENTABLE since engine ADR 1010: `createGroup
// { memberIds, clip: true }` makes the top-most member the clipping path
// (a Rectangle, Oval or Polygon; it paints nothing of its own) and clips
// the rest by its outline — Illustrator's clipping mask, on the wire.
// `commands/repeat.ts` clips a repeat that way where the host says it
// can (`document.clipGroups@1`). B-18's paste-into (`pasteInto` /
// `releaseFrom`) stays the other lane: InDesign's construct, which the
// IDML writer lowers a clip group to anyway. Since ADR 1010 a group can
// be pasted in too, and `document.tree()` lists what a frame holds.

// Host-agnostic: imports only plugin-api types.

import type { ElementId, Mutation } from "@paged-media/plugin-api";

/** The `createGroup { memberIds }` mutation. Exported so the conformance
 *  spec asserts the EXACT wire shape every caller emits — one copy, no
 *  drift between pattern / symbols / image-trace. */
export function groupMutationFor(memberIds: ElementId[]): Mutation {
  return { op: "createGroup", args: { memberIds } };
}

/** Engine ADR 1010 — the `createGroup { memberIds, clip: true }`
 *  mutation: a CLIP GROUP whose LAST member (the top-most, once the
 *  engine orders them by stacking) clips the rest. */
export function clipGroupMutationFor(memberIds: ElementId[]): Mutation {
  return { op: "createGroup", args: { memberIds, clip: true } } as Mutation;
}

/** The `dissolveGroup { groupId }` mutation — the exact inverse. */
export function ungroupMutationFor(groupId: string): Mutation {
  return { op: "dissolveGroup", args: { groupId } };
}
