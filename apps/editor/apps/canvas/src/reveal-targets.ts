/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// Taking the user to what a report points at (editor ADRs 1222 and 1223):
// a page by its index, or page items by id — selected, and the view fitted
// to them — so the compatibility report and the issue markers answer
// "where is it?" the same way. A producer names items in its own
// reference (engine ADR 1097, `LossEntry.items`): an element's id string;
// it is resolved against the scene tree, and an id the document no longer
// has is left out (the answer says how many were found).

import type { ElementId, SceneTreeNode } from "@paged-media/client";
import { scopeOf, type PagedEditor } from "@paged-media/shell";

import { pageDoorsOf } from "./plugin-pages";

/** What a reveal needs beyond the editor: the command door (Fit
 *  selection), and the history door when the editor keeps one. */
export interface RevealDeps {
  invoke(command: string, payload?: unknown): Promise<unknown>;
}

/** Go to the page at `index` (0-based); false when there is none. */
export async function revealPage(
  paged: PagedEditor,
  index: number,
): Promise<boolean> {
  const pageId = paged.document.handle?.pageIds?.[index];
  if (!pageId) return false;
  return Boolean(
    await pageDoorsOf(scopeOf(paged)).pages.goToPage(pageId, "page"),
  );
}

/** Resolve id strings (or ids) to the document's page items. */
export async function resolveItems(
  paged: PagedEditor,
  ids: ReadonlyArray<string | ElementId>,
): Promise<ElementId[]> {
  const wanted = new Set(
    ids.map((id) => (typeof id === "string" ? id : idString(id))),
  );
  if (wanted.size === 0) return [];
  const tree = await paged.client.sceneTree();
  const found: ElementId[] = [];
  const walk = (nodes: readonly SceneTreeNode[]) => {
    for (const n of nodes) {
      if (n.id && wanted.has(idString(n.id))) found.push(n.id);
      if (n.children) walk(n.children);
    }
  };
  walk(tree);
  return found;
}

/** An element id as the string a producer names it by. */
export function idString(id: ElementId): string {
  return typeof id.id === "string" ? id.id : JSON.stringify(id.id);
}

/** Select `ids` and fit the view to them. Resolves how many were found. */
export async function revealItems(
  paged: PagedEditor,
  deps: RevealDeps,
  ids: ReadonlyArray<string | ElementId>,
): Promise<number> {
  const items = await resolveItems(paged, ids);
  if (items.length === 0) return 0;
  const selected = await paged.client.setElementSelection(items, "replace");
  paged.selection.setElementSelection(selected);
  paged.selection.setElementGeometry(
    await paged.client.elementGeometry(selected),
  );
  // The view follows when the editor has Fit selection (a bare host may
  // not); the selection stands either way.
  await deps.invoke("paged.view.fitSelection").catch(() => undefined);
  return items.length;
}
