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

// PARENTAGE — the nearest group ancestor of an element, read off the
// scene tree.
//
// THIS MODULE NO LONGER CONTRIBUTES A COMMAND. "Select: Parent group"
// was paged.draw's; it is now the host's
// (`paged.object.selectParentGroup`, `apps/canvas/src/object-commands.ts`),
// beside Group / Ungroup and the four Arrange verbs, because basic
// object operations are what plugins BUILD ON. What stays is the pure
// resolver two of draw's OWN features need: Appearance bake reads the
// group it must dissolve before rebuilding, and Symbols resolves the
// group an instance's leaves live in.
//
// PARENTAGE DOOR (the honest answer to "is parentage readable?"):
// YES, through `host.document.tree()` — the scene tree nests
// Spread → Page → Group → leaf and group nodes carry their `ElementId`
// (`kind: "group"`), so the nearest group ancestor of any selected
// element is derivable by one walk. `hitTest`'s `groupChain` also
// carries ancestry but needs a pointer event, and `elementProperties`
// exposes NO parent member — the tree is the only click-free door.
// NAMED DOOR GAP (recorded, not blocking): there is no per-element
// `document.parentOf(id)` read, so each caller re-reads the WHOLE tree.
// A targeted parent read door is the RFI candidate if it ever bites.

import type { ElementId, SceneTreeNode } from "@paged-media/plugin-api";

/** The nearest GROUP ancestor of `target` in the scene tree, or null
 *  when the element is not inside a group (or not found). Pure —
 *  exported for the conformance spec. Only string-id elements are
 *  addressable in the tree (story/table addresses never nest in
 *  groups). */
export function parentGroupOf(
  roots: readonly SceneTreeNode[],
  target: ElementId,
): ElementId | null {
  if (typeof target.id !== "string") return null;
  const targetId = target.id;
  let found: ElementId | null = null;
  const walk = (nodes: readonly SceneTreeNode[], groups: ElementId[]): boolean => {
    for (const node of nodes) {
      const id = node.id ?? null;
      if (id && typeof id.id === "string" && id.id === targetId) {
        found = groups.length > 0 ? groups[groups.length - 1] : null;
        return true;
      }
      const children = node.children ?? [];
      if (children.length > 0) {
        const nextGroups =
          id && id.kind === "group" ? [...groups, id] : groups;
        if (walk(children, nextGroups)) return true;
      }
    }
    return false;
  };
  walk(roots, []);
  return found;
}
