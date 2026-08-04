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
// CLIPPING MASKS — VERIFIED NOT REPRESENTABLE, honestly omitted: the
// wire `GroupSpec` carries only `selfId` / `members` + the W1.20
// inverse-only fields (`parent`, `itemTransform`), and core's parsed
// `Group` (paged-parse `spread.rs`) carries members + transparency +
// item_transform — NO clip flag, NO mask member, NO clip path. Core's
// only clipping today is `ClippingPathSettings` on PLACED IMAGES (and
// paragraph-shading `clip_to_frame`), neither of which a group can
// claim. So a clip-group / "paste into" cannot be expressed end-to-end;
// faking one (e.g. metadata-tagging a plain group as a "mask") would
// render nothing and lie on save. The gap belongs to the cross-repo RFI
// (`thoughts/docs/paged/plugin-platform/rfi-core-sdk-gaps.md`) as a
// core GroupSpec/scene extension.
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
