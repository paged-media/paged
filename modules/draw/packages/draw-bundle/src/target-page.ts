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

// The page a command inserts onto, and the `insertPath` lowering of
// contours that are separate paths — shared by the insert-shape grids and
// every command that lands new artwork. (They lived beside the SVG
// importer, which no longer lowers anything itself: draw ADR 364.)

import type { BundleHost, Mutation } from "@paged-media/plugin-api";
import type { AnchorTable } from "@paged-media/draw-geometry";

/** One `insertPath` per contour of `table` (the EXACT shape the
 *  pen/pencil commit emits): the engine's `insertPath` takes a single
 *  contour and a single open/closed flag. */
export function insertPathMutationsForShape(
  pageId: string,
  table: AnchorTable,
): Mutation[] {
  const starts = table.subpathStarts.length ? table.subpathStarts : [0];
  const open = table.subpathOpen ?? [];
  const out: Mutation[] = [];
  for (let s = 0; s < starts.length; s++) {
    const begin = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : table.anchors.length;
    if (end <= begin) continue;
    const anchors = table.anchors.slice(begin, end).map((a) => ({
      anchor: [a.anchor[0], a.anchor[1]] as [number, number],
      left: [a.left[0], a.left[1]] as [number, number],
      right: [a.right[0], a.right[1]] as [number, number],
    }));
    out.push({
      op: "insertPath",
      args: { pageId, anchors, open: open[s] ?? false },
    });
  }
  return out;
}

/** Resolve the page to insert onto: the document's active page when the
 *  host reports one, else the first page in the `pages` collection (the
 *  headless / no-focus fallback). Returns null when the document has no
 *  pages. */
export async function resolveTargetPage(
  host: BundleHost,
): Promise<string | null> {
  const meta = await host.document.meta();
  if (meta.activePage) return meta.activePage;
  try {
    const pages = await host.document.collection<{ selfId?: string }>("pages");
    for (const p of pages) {
      if (p && typeof p.selfId === "string") return p.selfId;
    }
  } catch {
    /* fall through */
  }
  return null;
}
