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

// Save-back of the native tables' cells. The read-back story
// (`host.document.storyContent`) holds no table, so each cell of a table the
// pour built natively is read on its own — the engine's cell `text`, its
// paragraphs joined by `\n` — and handed to docx-js next to the story
// (`cells`), which patches the edits into the cell's runs. Which native
// table a lowered table became is the pour's replay (`tableLocation`), as the
// object model's cell writes find it.

import { tableLocation, type LoweredDoc } from "@paged-media/doc-host-model";
import type { BundleHost } from "@paged-media/plugin-api";

/** One cell read back: the table's lowered block, the lowered cell index and
 *  the cell's live text. */
export interface CellContent {
  block: number;
  cell: number;
  text: string;
}

/**
 * Read every native table cell of `ir` from the stories it was poured into
 * (`storyIds`, in section order). Answers the cells read and what could not
 * be read (a host without the object door, a table no longer where the pour
 * put it): those cells keep their Word text, and the reasons are reported.
 */
export async function readTableCells(
  host: BundleHost,
  ir: LoweredDoc,
  storyIds: readonly string[],
): Promise<{ cells: CellContent[]; skips: string[] }> {
  const cells: CellContent[] = [];
  const skips: string[] = [];
  const blocks = ir.story.blocks;
  const hasTables = blocks.some(
    (b) => b.kind === "table" && (b.flow ?? []).length === 0,
  );
  if (!hasTables) return { cells, skips };
  if (!host.supports("objects@1")) {
    skips.push(
      "this host cannot read table cells: canvas edits in tables are not saved",
    );
    return { cells, skips };
  }
  const tables = new Map<string, string[]>();
  for (let b = 0; b < blocks.length; b += 1) {
    const block = blocks[b]!;
    if (block.kind !== "table") continue;
    const at = tableLocation(ir, b);
    if (!at) continue; // poured as text: save-back keeps the Word table
    const storyId = storyIds[at.story];
    if (!storyId) {
      skips.push(`block ${b}: the table's story is not known`);
      continue;
    }
    let ids = tables.get(storyId);
    if (!ids) {
      ids = (await host.objects.query(`story:${storyId} > table`)).map((a) =>
        decodeURIComponent(a.replace(/^table:/, "")),
      );
      tables.set(storyId, ids);
    }
    const tableId = ids[at.table];
    if (ids.length !== at.tables || !tableId) {
      skips.push(
        `block ${b}: the story's tables changed on the canvas; the table keeps its Word text`,
      );
      continue;
    }
    for (let k = 0; k < block.cells.length; k += 1) {
      const c = block.cells[k]!;
      const read = await host.objects.get(
        `cell:${tableId}/${c.row},${c.col}`,
        "text",
      );
      if (read.kind === "value" && typeof read.value === "string")
        cells.push({ block: b, cell: k, text: read.value });
      else
        skips.push(
          `block ${b} cell ${k}: the cell cannot be read; it keeps its Word text`,
        );
    }
  }
  return { cells, skips };
}
