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

// Group-selection CYCLING (wave 2) — `selectParentGroup`: when the
// selection sits inside a group, select the CONTAINING group; invoke
// again to climb another level (nested groups cycle upward). Pure
// selection — no mutation.
//
// PARENTAGE DOOR (the honest answer to "is parentage readable?"):
// YES, through `host.document.tree()` — the scene tree nests
// Spread → Page → Group → leaf and group nodes carry their `ElementId`
// (`kind: "group"`), so the nearest group ancestor of any selected
// element is derivable by one walk. `hitTest`'s `groupChain` also
// carries ancestry but needs a pointer event, and `elementProperties`
// exposes NO parent member — the tree is the only click-free door.
// NAMED DOOR GAP (recorded, not blocking): there is no per-element
// `document.parentOf(id)` read — this command re-reads the WHOLE tree
// per invocation, which is O(document) on every press. Fine at v0
// scale; if it bites on huge documents, a targeted parent read door is
// the RFI candidate.

import type {
  BundleHost,
  Disposable,
  ElementId,
  SceneTreeNode,
} from "@paged-media/plugin-api";

export const SELECT_PARENT_GROUP_COMMAND_CATEGORY = "Select";
export const SELECT_PARENT_GROUP_COMMAND_ID =
  "media.paged.draw.command.selectParentGroup";

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

export async function applySelectParentGroup(host: BundleHost): Promise<void> {
  const selection = host.selection.get();
  if (selection.length === 0) {
    host.log.debug(`${SELECT_PARENT_GROUP_COMMAND_ID}: nothing selected — no-op`);
    return;
  }
  const roots = await host.document.tree();
  // The FIRST selected element anchors the climb (the select-same
  // reference convention).
  const parent = parentGroupOf(roots, selection[0]);
  if (!parent) {
    host.log.debug(
      `${SELECT_PARENT_GROUP_COMMAND_ID}: selection has no parent group ` +
        `in the scene tree — selection unchanged`,
    );
    return;
  }
  await host.selection.set([parent]);
}

/** Register the group-selection cycling command. Pure selection. */
export function contributeSelectParentGroupCommand(
  host: BundleHost,
): Disposable {
  return host.contribute.command({
    id: SELECT_PARENT_GROUP_COMMAND_ID,
    title: "Select: Parent group",
    category: SELECT_PARENT_GROUP_COMMAND_CATEGORY,
    handler: () => applySelectParentGroup(host),
  });
}
