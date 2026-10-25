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
// paragraphs joined by `\n`, and its `paragraphs` with their runs and
// formatting — and handed to docx-js next to the story (`cells`), which
// patches the edits into the cell's runs (splitting a run where part of it
// took another look) and adds or drops the cell's paragraphs. Which native table a lowered table became is found
// again by signature (`locateTables`), so a table survives the story around
// it being edited, moved or partly deleted.

import type { LoweredDoc } from "@paged-media/doc-host-model";
import type { BundleHost } from "@paged-media/plugin-api";

import { locateTables } from "./tables.js";

/** One cell read back: the table's lowered block, the lowered cell index,
 *  the cell's live text and, where the engine reads it, its paragraphs with
 *  their runs and formatting (the story read's shape), so runs split by a
 *  new look and direct formatting are saved too. */
export interface CellContent {
  block: number;
  cell: number;
  text: string;
  paragraphs?: unknown[];
}

/** A table whose rows were added or removed on the canvas, read whole: each
 *  live row's cell texts. The save-back aligns its rows with Word's by
 *  text, adds and removes `w:tr`s, and patches the kept rows' cells. */
export interface TableContent {
  block: number;
  rows: string[][];
}

/** A cell's styled paragraphs (the engine's cell `paragraphs` read, JSON
 *  text), or `undefined` where the engine has no such read: the cell's
 *  text alone is saved then. */
async function readStyledCell(
  host: BundleHost,
  tableId: string,
  row: number,
  col: number,
): Promise<unknown[] | undefined> {
  try {
    const read = await host.objects.get(
      `cell:${tableId}/${row},${col}`,
      "paragraphs",
    );
    if (read.kind !== "value" || typeof read.value !== "string")
      return undefined;
    const parsed: unknown = JSON.parse(read.value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read every native table cell of `ir` from the stories it was poured into
 * (`storyIds`, in section order). Answers the cells read and what could not
 * be read (a host without the object door, a table that cannot be found on
 * the canvas any more): those cells keep their Word text, and the reasons
 * are reported.
 */
export async function readTableCells(
  host: BundleHost,
  ir: LoweredDoc,
  storyIds: readonly string[],
): Promise<{ cells: CellContent[]; tables: TableContent[]; skips: string[] }> {
  const cells: CellContent[] = [];
  const tables: TableContent[] = [];
  const skips: string[] = [];
  const blocks = ir.story.blocks;
  const hasTables = blocks.some(
    (b) => b.kind === "table" && (b.flow ?? []).length === 0,
  );
  if (!hasTables) return { cells, tables, skips };
  if (!host.supports("objects@1")) {
    skips.push(
      "this host cannot read table cells: canvas edits in tables are not saved",
    );
    return { cells, tables, skips };
  }
  const { places, missing } = await locateTables(host, ir, storyIds, {
    rowsMayChange: true,
  });
  for (const b of missing)
    skips.push(
      `block ${b}: the table is no longer on the canvas (deleted, or columns added or removed on it); it keeps its Word text`,
    );
  for (const [b, place] of places) {
    const block = blocks[b]!;
    if (block.kind !== "table") continue;
    if (place.rows !== block.rows) {
      // Rows added or removed: the whole table, row by row.
      const rows: string[][] = [];
      for (let r = 0; r < place.rows; r += 1) {
        const row: string[] = [];
        for (let c = 0; c < place.cols; c += 1)
          row.push(place.cells[`${r},${c}`] ?? "");
        rows.push(row);
      }
      tables.push({ block: b, rows });
      continue;
    }
    for (let k = 0; k < block.cells.length; k += 1) {
      const c = block.cells[k]!;
      const text = place.cells[`${c.row},${c.col}`];
      if (text !== undefined) {
        const paragraphs = await readStyledCell(
          host,
          place.tableId,
          c.row,
          c.col,
        );
        cells.push(
          paragraphs
            ? { block: b, cell: k, text, paragraphs }
            : { block: b, cell: k, text },
        );
      } else
        skips.push(
          `block ${b} cell ${k}: the cell cannot be read; it keeps its Word text`,
        );
    }
  }
  return { cells, tables, skips };
}

/** The swatch ids the runs of `paragraphs` are filled with (`fillColor`). */
function fillColors(paragraphs: readonly unknown[], into: Set<string>): void {
  for (const p of paragraphs) {
    const runs = (p as { runs?: unknown } | null)?.runs;
    if (!Array.isArray(runs)) continue;
    for (const r of runs) {
      const c = (r as { fillColor?: unknown } | null)?.fillColor;
      if (typeof c === "string" && c.length > 0) into.add(c);
    }
  }
}

/**
 * The RGB of every swatch the read-back runs are filled with, and of the
 * `extra` ids (the Word theme's swatches, the styles' colours), by swatch id
 * (`RRGGBB`), as the host displays it: the save-back writes a run's colour
 * from it when the swatch is one the canvas made (the import's own are
 * known to the engine already), and a theme swatch the user edited is
 * written as its new colour instead of the theme reference (doc ADR 609). Empty on a host without the swatch display
 * read; a run in such a colour then keeps its Word colour.
 */
export async function canvasColors(
  host: BundleHost,
  paragraphs: readonly unknown[],
  cells: readonly CellContent[],
  extra: readonly string[] = [],
): Promise<Record<string, string>> {
  if (!host.supports("document.swatchDisplay@1")) return {};
  const ids = new Set<string>(extra);
  fillColors(paragraphs, ids);
  for (const c of cells) fillColors(c.paragraphs ?? [], ids);
  if (ids.size === 0) return {};
  const out: Record<string, string> = {};
  try {
    for (const d of await host.document.swatchDisplay([...ids]))
      out[d.id] = d.rgbHex.replace(/^#/, "").toUpperCase();
  } catch {
    return {};
  }
  return out;
}

/** The ids of the lowering's theme-colour swatches (doc ADR 609). */
export function themeSwatches(ir: LoweredDoc): string[] {
  return ir.swatches.filter((s) => s.theme).map((s) => s.id);
}
