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

// Finding the native tables a pour built again, on a canvas that may have
// changed since: the story's live tables are read (shape and cell text) and
// paired with the lowered ones by signature (`matchTables`), so a table is
// found after the story around it was edited, it was moved, or tables
// before it were deleted. Save-back of cells (save-cells.ts) and the object
// model's cell writes both locate tables through here.

import {
  matchTables,
  tableLocation,
  type LiveTable,
  type LoweredDoc,
} from "@paged-media/doc-host-model";
import type { BundleHost } from "@paged-media/plugin-api";

/** A located table: its story, the native table's id and its cells' live
 *  text keyed `"row,col"` (as read while locating it). */
export interface TablePlace {
  storyId: string;
  tableId: string;
  /** The live table's rows and columns (another row count than the pour's
   *  only when located with `rowsMayChange`). */
  rows: number;
  cols: number;
  cells: Readonly<Record<string, string>>;
}

/** A number a host read answers, or `null`. */
async function count(
  host: BundleHost,
  address: string,
  path: string,
): Promise<number | null> {
  const read = await host.objects.get(address, path);
  return read.kind === "value" && typeof read.value === "number"
    ? read.value
    : null;
}

/** The native tables of the stories `storyIds` (in section order), with
 *  their shape and cell text. A table whose shape cannot be read is left
 *  out (nothing pairs with it). */
export async function readLiveTables(
  host: BundleHost,
  storyIds: readonly string[],
): Promise<LiveTable[]> {
  const out: LiveTable[] = [];
  for (let story = 0; story < storyIds.length; story += 1) {
    const storyId = storyIds[story];
    if (!storyId) continue;
    const ids = (await host.objects.query(`story:${storyId} > table`)).map(
      (a) => decodeURIComponent(a.replace(/^table:/, "")),
    );
    for (let ordinal = 0; ordinal < ids.length; ordinal += 1) {
      const id = ids[ordinal]!;
      const address = `table:${id}`;
      const rows = await count(host, address, "tableRowCount");
      const cols = await count(host, address, "tableColumnCount");
      if (rows === null || cols === null) continue;
      const cells: Record<string, string> = {};
      for (let r = 0; r < rows; r += 1)
        for (let c = 0; c < cols; c += 1) {
          const read = await host.objects.get(`cell:${id}/${r},${c}`, "text");
          if (read.kind === "value" && typeof read.value === "string")
            cells[`${r},${c}`] = read.value;
        }
      out.push({ id, story, ordinal, rows, cols, cells });
    }
  }
  return out;
}

/**
 * Where each natively poured table of `ir` is on the canvas now, found by
 * signature among the live tables of `storyIds` ({@link matchTables}).
 * Answers the places by lowered block, and one message per table that
 * cannot be found (deleted, or reshaped and every cell edited).
 * `rowsMayChange` also finds a table whose rows were added or removed.
 */
export async function locateTables(
  host: BundleHost,
  ir: LoweredDoc,
  storyIds: readonly string[],
  options: { rowsMayChange?: boolean } = {},
): Promise<{ places: Map<number, TablePlace>; missing: number[] }> {
  const places = new Map<number, TablePlace>();
  const missing: number[] = [];
  const blocks = ir.story.blocks
    .map((b, block) => ({ b, block }))
    .filter(({ b, block }) => b.kind === "table" && tableLocation(ir, block));
  if (blocks.length === 0) return { places, missing };
  const live = await readLiveTables(host, storyIds);
  const byId = new Map(live.map((t) => [t.id, t]));
  const matched = matchTables(ir, live, options);
  for (const { block } of blocks) {
    const id = matched.get(block);
    const t = id === undefined ? undefined : byId.get(id);
    const storyId = t ? storyIds[t.story] : undefined;
    if (id === undefined || !storyId) missing.push(block);
    else
      places.set(block, {
        storyId,
        tableId: id,
        rows: t!.rows,
        cols: t!.cols,
        cells: t!.cells,
      });
  }
  return { places, missing };
}
