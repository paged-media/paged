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
// A CLIP GROUP is still not representable — but "paste into" IS, and
// this note used to say otherwise. Both halves, kept apart:
//
//  · STILL TRUE: the wire `GroupSpec` carries only `selfId` / `members`
//    + the W1.20 inverse-only fields (`parent`, `itemTransform`), and
//    core's parsed `Group` (paged-parse `spread.rs`) carries members +
//    transparency + item_transform — NO clip flag, NO mask member, NO
//    clip path. Metadata-tagging a plain group as a "mask" would render
//    nothing and lie on save, so no Group-based clipping is offered.
//  · NO LONGER TRUE (corrected 2026-08-05): "a 'paste into' cannot be
//    expressed end-to-end". B-18 landed — `pasteInto { containerId,
//    childId }` nests a top-level item inside a container Rectangle /
//    Oval / Polygon, where it renders CLIPPED by that container's
//    outline, and `releaseFrom { childId }` pops it back. Both are in
//    the booted engine's op vocabulary (measured), and
//    `commands/repeat.ts` ships on them for §12.4's clipping. The wire
//    seam is `commands/v59-wire.ts`; the four measured consequences of
//    nesting (no group, invisible to `document.tree()`, `deleteFrame`
//    refused, a deleted container ORPHANS its children) are documented
//    there and in `commands/repeat.ts`.
//
// So what remains for the cross-repo RFI
// (`thoughts/docs/paged/plugin-platform/rfi-core-sdk-gaps.md`) is a
// GroupSpec/scene clip extension — an ARBITRARY clip path over a set of
// items — not the container-nesting case, which is built.
//
// Host-agnostic: imports only plugin-api types.

import type { ElementId, Mutation } from "@paged-media/plugin-api";

/** The `createGroup { memberIds }` mutation. Exported so the conformance
 *  spec asserts the EXACT wire shape every caller emits — one copy, no
 *  drift between pattern / symbols / image-trace. */
export function groupMutationFor(memberIds: ElementId[]): Mutation {
  return { op: "createGroup", args: { memberIds } };
}

/** The `dissolveGroup { groupId }` mutation — the exact inverse. */
export function ungroupMutationFor(groupId: string): Mutation {
  return { op: "dissolveGroup", args: { groupId } };
}
