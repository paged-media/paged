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

// Refresh a PLACED native table in place (Wave 4). A placed table projects a
// (sheet, range); when the workbook changes — an edit, a recalc, a
// re-pagination that moves the row split — the table must show the new
// content WITHOUT a second table appearing beside the first. The wire has
// no table-delete op (`deleteTable` is not on the wire; core's RemoveNode
// for a Table backs only undo), so "replace" is done by RESHAPING the
// existing table to the new content and re-pouring only what changed:
//
//   structure — rows and columns aligned (columns by their index, rows by
//               content; the header band by position), the rest inserted
//               or deleted; row heights and column widths that moved;
//               spans that no longer exist reset to 1×1;
//   text      — per cell whose text changed: delete the old text, insert
//               the new (cell-addressed text ops);
//   decor     — the new spans/fills/edges, plus a RESET for every fill or
//               edge the old content had and the new one lacks.
//
// PURE: (previous content, next content, ids, widths) in, mutations out.
// The bundle drives them (lower.ts).

import type { Mutation } from "@paged-media/plugin-api";

import type { LoweredContent } from "./lowered";
import { columnOrder, tableDecorOps } from "./lower-to-table";

/** The ops a refresh needs, by apply lane (text cannot share a frame-op
 *  batch on older engines, so the lanes stay separable). */
export interface TableRefreshOps {
  structure: Mutation[];
  text: Mutation[];
  decor: Mutation[];
  /** How many cells of the next table get their text re-poured. */
  rewrittenCells: number;
  /** More than {@link REPLACE_FRACTION} of the next table's cells would be
   *  re-poured: writing a fresh table is cheaper than reshaping this one,
   *  and the caller should replace it instead of applying these ops. */
  replace: boolean;
}

/** The share of re-poured cells above which a refresh asks to replace the
 *  table instead (`TableRefreshOps.replace`). */
export const REPLACE_FRACTION = 0.6;

/** The IDML "no colour" swatch — what an un-filled cell's fill resets to. */
export const NO_FILL_SWATCH = "Swatch/None";

/** UTF-8 byte length — the unit core's story offsets count in. */
export function textOffsetLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** `(tablePosRow, tablePosCol) → text` for the populated cells. */
function cellTexts(content: LoweredContent): Map<string, string> {
  const colPos = new Map<number, number>();
  columnOrder(content).forEach((m, i) => colPos.set(m, i));
  const out = new Map<string, string>();
  content.rows.forEach((row, r) => {
    for (const cell of row.cells) {
      const c = colPos.get(cell.col);
      if (c !== undefined && cell.text.length > 0)
        out.set(`${r}:${c}`, cell.text);
    }
  });
  return out;
}

/** A stable key for a decor op (the property it sets on which cell). */
function decorKey(op: Mutation): string | null {
  if (
    op.op === "setElementProperty" &&
    op.args.elementId.kind === "tableCell"
  ) {
    const id = op.args.elementId.id;
    return `${id.row}:${id.col}:${op.args.path}`;
  }
  if (op.op === "setCellSpan") return `${op.args.row}:${op.args.col}:span`;
  return null;
}

/** A row's identity for alignment: its height plus the text and style keys
 *  of its cells in the columns both tables keep (`shared`, by column
 *  index), so a horizontal scroll does not make every row look new. */
function rowSignature(
  content: LoweredContent,
  r: number,
  shared: ReadonlySet<number>,
): string {
  const row = content.rows[r];
  const cells = row.cells
    .filter(
      (c) =>
        shared.has(c.col) && (c.text.length > 0 || (c.styleKey ?? 0) !== 0),
    )
    .map((c) => `${c.col}=${c.styleKey ?? 0}:${c.text}`)
    .join("\u0001");
  return `${row.heightPt}|${cells}`;
}

/** Rows beyond which the O(n·m) alignment falls back to tail reshaping. */
const ALIGN_LIMIT = 2000;

/** Longest common subsequence of `a` and `b`: `match[j]` is the index in
 *  `a` that `b[j]` keeps, or -1. Falls back to positions when too big. */
function lcsMatch(a: readonly string[], b: readonly string[]): number[] {
  const n = a.length;
  const m = b.length;
  const match = new Array<number>(m).fill(-1);
  if (n === 0 || m === 0) return match;
  if (n * m > (ALIGN_LIMIT * ALIGN_LIMIT) / 4) {
    for (let j = 0; j < Math.min(n, m); j++) match[j] = j;
    return match;
  }
  // lcs[i][j] = LCS length of a[i..], b[j..].
  const lcs: Uint32Array[] = Array.from(
    { length: n + 1 },
    () => new Uint32Array(m + 1),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      match[j] = i;
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return match;
}

/** Match next columns to prev columns by their `index` (a frame page's
 *  columns carry SHEET indices, so a scroll by k columns keeps every column
 *  both windows show): `match[j]` is the prev column next column `j` keeps,
 *  or -1 when it is new. */
function alignColumns(prev: LoweredContent, next: LoweredContent): number[] {
  return lcsMatch(
    prev.cols.map((c) => String(c.index)),
    next.cols.map((c) => String(c.index)),
  );
}

/** Match next rows `[n0, n1)` to prev rows `[p0, p1)` (LCS of row
 *  signatures over the shared columns): `match[j - n0]` is the prev row
 *  next row `j` keeps, or -1 when it is new. A page split or a vertical
 *  scroll that moved rows is then a few row inserts/deletes, not a re-pour
 *  of every shifted cell. */
function alignRows(
  prev: LoweredContent,
  next: LoweredContent,
  [p0, p1]: [number, number],
  [n0, n1]: [number, number],
  shared: ReadonlySet<number>,
): number[] {
  const a: string[] = [];
  for (let i = p0; i < p1; i++) a.push(rowSignature(prev, i, shared));
  const b: string[] = [];
  for (let j = n0; j < n1; j++) b.push(rowSignature(next, j, shared));
  const match = lcsMatch(a, b).map((x) => (x >= 0 ? x + p0 : -1));
  // Rows that did not match but sit at the same place pair up positionally
  // (a changed cell in a kept row re-pours that cell, not the row).
  const used = new Set(match.filter((x) => x >= 0));
  const free: number[] = [];
  for (let k = p0; k < p1; k++) if (!used.has(k)) free.push(k);
  let lastPrev = -1;
  for (let jj = 0; jj < match.length; jj++) {
    if (match[jj] >= 0) {
      lastPrev = match[jj];
      continue;
    }
    const nextMatched = match.slice(jj + 1).find((x) => x >= 0) ?? p1;
    const cand = free.find((k) => k > lastPrev && k < nextMatched);
    if (cand !== undefined) {
      match[jj] = cand;
      free.splice(free.indexOf(cand), 1);
      lastPrev = cand;
    }
  }
  return match;
}

/** The header band of a content (`headerRows`, clamped to its rows). */
function headerBand(content: LoweredContent): number {
  return Math.max(0, Math.min(content.headerRows ?? 0, content.rows.length));
}

/**
 * Compute the in-place refresh of a placed table from `prev` to `next`.
 *
 * Tracks are aligned before anything is re-poured:
 * - columns by their `index` (longest common subsequence), so a horizontal
 *   scroll by k columns is k column deletes where the window left and k
 *   inserts where it arrived — the cells both windows show keep their text;
 * - the header band (`headerRows`: frozen rows, printed headings) by
 *   position: a band that grows gains `insertHeaderRow`s at its top, one
 *   that shrinks loses `removeHeaderRow`s from its top;
 * - body rows by signature over the shared columns (as before).
 * Then only cells whose text differs get text ops. When more than
 * {@link REPLACE_FRACTION} of the next table's cells would be re-poured,
 * `replace` says to write a new table instead.
 */
export function tableRefreshOps(
  prev: LoweredContent,
  next: LoweredContent,
  storyId: string,
  tableId: string,
  prevWidths: readonly number[],
  nextWidths: readonly number[],
): TableRefreshOps {
  const structure: Mutation[] = [];
  const text: Mutation[] = [];

  const prevRows = prev.rows.length;
  const nextRows = next.rows.length;
  const prevCols = prev.cols.length;
  const nextCols = next.cols.length;
  const h0 = headerBand(prev);
  const h1 = headerBand(next);

  // ---- Columns: kept by index. ----
  const colMatch = alignColumns(prev, next);
  const keptCols = new Set(colMatch.filter((x) => x >= 0));
  // prev column index → the next column index it becomes.
  const colIndexMap = new Map<number, number>();
  colMatch.forEach((p, j) => {
    if (p >= 0) colIndexMap.set(prev.cols[p].index, next.cols[j].index);
  });
  const shared = new Set(colIndexMap.values());
  // Signatures compare next-index cells; give prev cells their next index.
  const prevRemapped: LoweredContent = {
    ...prev,
    rows: prev.rows.map((row) => ({
      ...row,
      cells: row.cells.flatMap((c) => {
        const col = colIndexMap.get(c.col);
        return col === undefined ? [] : [{ ...c, col }];
      }),
    })),
  };

  // ---- Rows: the header band by position, the body by signature. ----
  const match = new Array<number>(nextRows).fill(-1);
  for (let j = 0; j < h1; j++) {
    const p = j - (h1 - h0);
    if (p >= 0 && p < h0) match[j] = p;
  }
  alignRows(prevRemapped, next, [h0, prevRows], [h1, nextRows], shared).forEach(
    (p, k) => {
      match[h1 + k] = p;
    },
  );
  const kept = new Set(match.filter((x) => x >= 0));
  // prev row position → next row position (for remapping old decor).
  const rowPosMap = new Map<number, number>();
  match.forEach((p, j) => {
    if (p >= 0) rowPosMap.set(p, j);
  });
  const colPosMap = new Map<number, number>();
  colMatch.forEach((p, j) => {
    if (p >= 0) colPosMap.set(p, j);
  });

  // The table as it will stand after the track edits, seen as PREV content:
  // kept rows carry their old cells in the kept columns, new rows and
  // columns are empty. Text and decor diff against this, so only what
  // really changed is re-poured.
  const virtualPrev: LoweredContent = {
    ...prev,
    cols: next.cols,
    rows: next.rows.map((row, j) =>
      match[j] >= 0
        ? { ...prevRemapped.rows[match[j]], index: row.index }
        : { index: row.index, heightPt: row.heightPt, cells: [] },
    ),
    merges: [],
    rules: { h: [], v: [] },
  };

  // Spans that go away are reset first, while their anchors still exist.
  const prevDecor = tableDecorOps(prev, storyId, tableId).ops;
  const nextDecor = tableDecorOps(next, storyId, tableId).ops;
  const nextKeys = new Set(nextDecor.map(decorKey));
  for (const op of prevDecor) {
    if (op.op !== "setCellSpan") continue;
    const r = rowPosMap.get(op.args.row);
    const c = colPosMap.get(op.args.col);
    const stays =
      r !== undefined &&
      c !== undefined &&
      nextKeys.has(decorKey({ ...op, args: { ...op.args, row: r, col: c } }));
    if (stays) continue;
    if (op.args.row < prevRows && op.args.col < prevCols) {
      structure.push({
        op: "setCellSpan",
        args: { ...op.args, rowSpan: 1, columnSpan: 1 },
      });
    }
  }

  // Header band: grow or shrink at its top. After this the table is the
  // next header band followed by the prev body rows.
  for (let k = h1; k < h0; k++) {
    structure.push({ op: "removeHeaderRow", args: { storyId, tableId } });
  }
  for (let k = h0; k < h1; k++) {
    structure.push({ op: "insertHeaderRow", args: { storyId, tableId } });
  }
  // Body rows: delete the prev rows nothing keeps (bottom-up, so indices
  // stay valid), then insert each new row at its final index (top-down:
  // when row j is inserted, rows 0..j-1 already stand).
  for (let i = prevRows - 1; i >= h0; i--) {
    if (!kept.has(i)) {
      structure.push({
        op: "deleteTableRow",
        args: { storyId, tableId, at: i - h0 + h1 },
      });
    }
  }
  for (let j = h1; j < nextRows; j++) {
    if (match[j] < 0) {
      structure.push({
        op: "insertTableRow",
        args: { storyId, tableId, at: j },
      });
    }
  }
  // Columns: delete what no column keeps (right to left), then insert the
  // new ones at their final positions (left to right).
  for (let p = prevCols - 1; p >= 0; p--) {
    if (!keptCols.has(p)) {
      structure.push({
        op: "deleteTableColumn",
        args: { storyId, tableId, at: p },
      });
    }
  }
  for (let j = 0; j < nextCols; j++) {
    if (colMatch[j] < 0) {
      structure.push({
        op: "insertTableColumn",
        args: { storyId, tableId, at: j },
      });
    }
  }
  next.rows.forEach((row, j) => {
    const was = match[j] >= 0 ? prev.rows[match[j]].heightPt : null;
    if (was !== row.heightPt) {
      structure.push({
        op: "setRowHeight",
        args: { storyId, tableId, row: j, height: row.heightPt },
      });
    }
  });
  for (let c = 0; c < nextCols; c++) {
    const w = nextWidths[c];
    const p = colMatch[c];
    if (w !== undefined && (p < 0 || prevWidths[p] !== w)) {
      structure.push({
        op: "setColumnWidth",
        args: { storyId, tableId, col: c, width: w },
      });
    }
  }

  // Text: only the cells that changed against the realigned table.
  const before = cellTexts(virtualPrev);
  const after = cellTexts(next);
  let rewrittenCells = 0;
  for (let r = 0; r < nextRows; r++) {
    for (let c = 0; c < nextCols; c++) {
      const key = `${r}:${c}`;
      const old = before.get(key) ?? "";
      const now = after.get(key) ?? "";
      if (old === now) continue;
      rewrittenCells += 1;
      const cell = { tableId, row: r, col: c };
      if (old.length > 0) {
        text.push({
          op: "deleteRange",
          args: { storyId, start: 0, end: textOffsetLength(old), cell },
        });
      }
      if (now.length > 0) {
        text.push({
          op: "insertText",
          args: { storyId, offset: 0, text: now, cell },
        });
      }
    }
  }

  // Decor: resets for fills/edges the realigned table had (its styles) and
  // the new content lacks, then the new decor in full. The old content's
  // rule edges move with their rows and columns (or go with them).
  const decor: Mutation[] = [];
  const virtualDecor = tableDecorOps(virtualPrev, storyId, tableId).ops;
  const prevRuleDecor = prevDecor.flatMap((op): Mutation[] => {
    if (op.op !== "setElementProperty" || op.args.path === "cellFillColor")
      return [];
    const el = op.args.elementId;
    if (el.kind !== "tableCell") return [];
    const row = rowPosMap.get(el.id.row);
    const col = colPosMap.get(el.id.col);
    if (row === undefined || col === undefined) return [];
    return [
      {
        ...op,
        args: {
          ...op.args,
          elementId: { ...el, id: { ...el.id, row, col } },
        },
      },
    ];
  });
  for (const op of [...virtualDecor, ...prevRuleDecor]) {
    if (op.op !== "setElementProperty" || nextKeys.has(decorKey(op))) continue;
    if (op.args.elementId.kind !== "tableCell") continue;
    const { row, col } = op.args.elementId.id;
    if (row >= nextRows || col >= nextCols) continue;
    decor.push({
      op: "setElementProperty",
      args: {
        elementId: op.args.elementId,
        path: op.args.path,
        value:
          op.args.path === "cellFillColor"
            ? { type: "colorRef", value: NO_FILL_SWATCH }
            : op.args.path.endsWith("StrokeColor")
              ? { type: "colorRef", value: null }
              : op.args.path === "cellVerticalJustification"
                ? { type: "text", value: "" }
                : { type: "length", value: 0 },
      },
    });
  }
  const resets = decor.filter(
    (op, i) => decor.findIndex((o) => decorKey(o) === decorKey(op)) === i,
  );
  const cells = nextRows * nextCols;
  return {
    structure,
    text,
    decor: [...resets, ...nextDecor],
    rewrittenCells,
    replace: cells > 0 && rewrittenCells > REPLACE_FRACTION * cells,
  };
}

/**
 * Move the row-addressed ops of table `tableId` down by `by` rows: what a
 * refresh writes when the host added a header band above the workbook's
 * rows (`insertHeaderRow`), so the workbook's row 0 is the table's row
 * `by`. Every op a placed table's pour or refresh emits that names a row is
 * covered: row inserts and deletes, row heights, spans, cell-addressed text
 * and style ops, and cell properties. Ops on other tables and ops that name
 * no row (columns, mints, styles, metadata) are returned unchanged. A footer
 * band needs no offset: it sits below the body, and a row inserted at the
 * body's end lands above it.
 */
export function offsetTableRows(
  ops: readonly Mutation[],
  tableId: string,
  by: number,
): Mutation[] {
  if (by === 0) return [...ops];
  return ops.map((op): Mutation => {
    switch (op.op) {
      case "insertTableRow":
      case "deleteTableRow":
        return op.args.tableId === tableId
          ? { ...op, args: { ...op.args, at: op.args.at + by } }
          : op;
      case "setRowHeight":
      case "setCellSpan":
        return op.args.tableId === tableId
          ? ({ ...op, args: { ...op.args, row: op.args.row + by } } as Mutation)
          : op;
      case "insertText":
      case "deleteRange":
      case "applyStyle": {
        const cell = op.args.cell;
        return cell && cell.tableId === tableId
          ? ({
              ...op,
              args: { ...op.args, cell: { ...cell, row: cell.row + by } },
            } as Mutation)
          : op;
      }
      case "setElementProperty": {
        const el = op.args.elementId;
        if (el.kind !== "tableCell" || el.id.table_id !== tableId) return op;
        return {
          ...op,
          args: {
            ...op.args,
            elementId: { ...el, id: { ...el.id, row: el.id.row + by } },
          },
        };
      }
      case "batch":
        return {
          ...op,
          args: { ops: offsetTableRows(op.args.ops, tableId, by) },
        };
      default:
        return op;
    }
  });
}
