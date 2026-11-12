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

// The lowering kit's table scaffold (extensions ADR 347): the ONE spelling
// of the ops a module writes when it lowers a foreign table (a sheet range,
// a Word table, a data-bound table) onto a native one. The module decides
// what its table is — the grid, the widths, the cell text, its look — and
// states it through these; how that becomes `insertTable`, a cell-addressed
// `insertText`, a `tableCell` property write or a span lives here once.
//
// A native table lands in three steps the module threads: the frame (its
// outcome names the story), `insertTable` (its outcome is the table id),
// then the cells. And where a host has no native tables, the tab-text
// fallback: a text frame, its grid drawn as lines, the module's metadata on
// the batch-created frame.
//
// PURE: data in, mutations out.

import type {
  ElementId,
  Mutation,
  PageId,
  PropertyPath,
  Value,
} from "@paged-media/plugin-api";

type InsertTableArgs = Extract<Mutation, { op: "insertTable" }>["args"];

/** What {@link nativeTableInsertOp} creates. An omitted field stays off
 *  the op (the engine's default). */
export interface NativeTableSpec {
  rows: number;
  cols: number;
  headerRows?: number;
  footerRows?: number;
  /** pt, one per column. */
  columnWidths?: number[];
  /** pt, one per row: a row is never shorter. */
  rowHeights?: number[];
  /** The table's layout properties (engine ADR 1025: indent, autofit,
   *  preferred widths, rows that never split), passed through. */
  word?: InsertTableArgs["word"];
  /** A table nested in a cell: the cell, and the paragraph of it the
   *  table stands on (engine ADR 1050). */
  cell?: InsertTableArgs["cell"];
  paragraph?: number;
}

/** The `insertTable` op in `storyId`; its outcome's `createdId` is the
 *  table id the cell ops address. */
export function nativeTableInsertOp(
  storyId: string,
  spec: NativeTableSpec,
): Mutation {
  const args: InsertTableArgs = { storyId, rows: spec.rows, cols: spec.cols };
  if (spec.headerRows !== undefined) args.headerRows = spec.headerRows;
  if (spec.footerRows !== undefined) args.footerRows = spec.footerRows;
  if (spec.columnWidths !== undefined) args.columnWidths = spec.columnWidths;
  if (spec.rowHeights !== undefined) args.rowHeights = spec.rowHeights;
  if (spec.word !== undefined) args.word = spec.word;
  if (spec.cell !== undefined) args.cell = spec.cell;
  if (spec.paragraph !== undefined) args.paragraph = spec.paragraph;
  return { op: "insertTable", args };
}

/** The `tableCell` element a cell's own properties are written on (fill,
 *  insets, edges, vertical justification, applied cell style). */
export function nativeTableCellId(
  storyId: string,
  tableId: string,
  row: number,
  col: number,
): ElementId {
  return {
    kind: "tableCell",
    id: { story_id: storyId, table_id: tableId, row, col },
  };
}

/** `text` poured into a cell (`insertText` at the cell's offset 0). An
 *  empty `text` gives a cell with no paragraph its one empty paragraph. */
export function nativeCellTextOp(
  storyId: string,
  tableId: string,
  row: number,
  col: number,
  text: string,
): Mutation {
  return {
    op: "insertText",
    args: { storyId, offset: 0, text, cell: { tableId, row, col } },
  };
}

/** One property of a cell (`setElementProperty` on its `tableCell`). */
export function nativeCellPropertyOp(
  storyId: string,
  tableId: string,
  row: number,
  col: number,
  path: PropertyPath,
  value: Value,
): Mutation {
  return {
    op: "setElementProperty",
    args: {
      elementId: nativeTableCellId(storyId, tableId, row, col),
      path,
      value,
    },
  };
}

/** A merged cell: the span anchored at `(row, col)`. */
export function nativeCellSpanOp(
  storyId: string,
  tableId: string,
  row: number,
  col: number,
  rowSpan: number,
  columnSpan: number,
): Mutation {
  return {
    op: "setCellSpan",
    args: { storyId, tableId, row, col, rowSpan, columnSpan },
  };
}

/** A row's height: `height` pt (null: the engine's), `autoGrow: false`
 *  holds it exactly. */
export function nativeRowHeightOp(
  storyId: string,
  tableId: string,
  row: number,
  height: number | null,
  autoGrow: boolean,
): Mutation {
  return {
    op: "setRowHeight",
    args: { storyId, tableId, row, height, autoGrow },
  };
}

/** One drawn grid line of the tab-text fallback, page coordinates. */
export interface NativeGridLine {
  start: [number, number];
  end: [number, number];
}

/** What {@link nativeTabTextFrameOps} writes. */
export interface NativeTabTextFrame {
  pageId: PageId;
  /** The frame's bounds, `[top, left, bottom, right]`. */
  bounds: [number, number, number, number];
  /** The grid, drawn as lines. */
  lines: readonly NativeGridLine[];
  /** Ops between the lines and the metadata (a sheet's data bars). They
   *  must create no text frame, or the metadata lands on that one. */
  decor?: readonly Mutation[];
  /** The module's metadata on the frame (its binding). */
  metadata: { key: string; value: string };
}

/** The tab-text fallback's one batch body: `insertTextFrame`, an
 *  `insertLine` per grid line, the decor, then `setPluginMetadata` on the
 *  batch-created frame (`$created`) — one undo removes it all. The text
 *  itself is poured once the frame's story is known. */
export function nativeTabTextFrameOps(frame: NativeTabTextFrame): Mutation[] {
  const { pageId, bounds } = frame;
  const ops: Mutation[] = [{ op: "insertTextFrame", args: { pageId, bounds } }];
  for (const l of frame.lines) {
    ops.push({
      op: "insertLine",
      args: { pageId, start: l.start, end: l.end },
    });
  }
  ops.push(...(frame.decor ?? []));
  ops.push({
    op: "setPluginMetadata",
    args: {
      elementId: { kind: "textFrame", id: "$created" },
      key: frame.metadata.key,
      value: frame.metadata.value,
    },
  });
  return ops;
}
