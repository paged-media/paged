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

// Sheet ADR 532 — the publication preview of the selected cells (the UX
// strategy's §7.3; the UX audit's F-42). While the cells of a placed frame
// are being edited, the grid shows the workbook, not the page: a standalone
// spreadsheet has no idea that only part of it lands in a frame. The
// preview answers the publishing question for the selection — which of the
// selected rows and columns the frame prints, and which overflow its box or
// sit outside its window — from what the page will print when the frame is
// left: a window frame's page windows (the rule leaving applies, sheet ADR
// 510, decided in Rust) or a fitted range's laid-out tracks against its
// box. Pure: indices in, counts out; no spreadsheet semantics here.

import {
  HEADING_INDEX,
  type GridSelection,
  type LoweredContent,
} from "../../sheet-host-model/src";

/** A block of sheet cells, 0-based and inclusive. */
export interface CellBlock {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** How the selection lands in its frame. */
export interface PublicationPreview {
  /** What the page prints: one block per frame of a chain, in order. */
  windows: CellBlock[];
  /** The selection (its current area). */
  selection: CellBlock;
  /** Selected rows and columns the page prints. */
  printedRows: number;
  printedCols: number;
  /** Selected rows below, and columns right of, what the frame prints:
   *  they overflow the frame's box and do not print. */
  overflowRows: number;
  overflowCols: number;
  /** Selected rows above, and columns left of, the frame's window: the
   *  frame shows a later part of the sheet. */
  beforeRows: number;
  beforeCols: number;
  /** Every selected cell prints. */
  fits: boolean;
}

/** The selection's current area as a block. */
export function blockOf(sel: GridSelection): CellBlock {
  return {
    top: sel.anchorRow,
    left: sel.anchorCol,
    bottom: sel.anchorRow + Math.max(1, sel.rows) - 1,
    right: sel.anchorCol + Math.max(1, sel.cols) - 1,
  };
}

/** Count the integers of `[from, to]` that fall in one of `spans`, below
 *  the lowest, and above the highest. */
function axis(
  from: number,
  to: number,
  spans: readonly (readonly [number, number])[],
): { inside: number; before: number; after: number } {
  if (spans.length === 0) return { inside: 0, before: 0, after: to - from + 1 };
  const low = Math.min(...spans.map((s) => s[0]));
  const high = Math.max(...spans.map((s) => s[1]));
  let inside = 0;
  let before = 0;
  let after = 0;
  for (let i = from; i <= to; i++) {
    if (spans.some(([a, b]) => i >= a && i <= b)) inside += 1;
    else if (i < low) before += 1;
    else if (i > high) after += 1;
    // A gap between two chain frames prints nowhere: count it as overflow
    // of the frame above it.
    else after += 1;
  }
  return { inside, before, after };
}

/**
 * How `selection` lands in a frame that prints `windows`. A frame that
 * prints nothing (an empty window list) has every selected track
 * overflowing.
 */
export function previewOf(
  windows: readonly CellBlock[],
  selection: CellBlock,
): PublicationPreview {
  const rows = axis(
    selection.top,
    selection.bottom,
    windows.map((w) => [w.top, w.bottom] as const),
  );
  const cols = axis(
    selection.left,
    selection.right,
    windows.map((w) => [w.left, w.right] as const),
  );
  return {
    windows: [...windows],
    selection,
    printedRows: rows.inside,
    printedCols: cols.inside,
    overflowRows: rows.after,
    overflowCols: cols.after,
    beforeRows: rows.before,
    beforeCols: cols.before,
    fits:
      rows.after === 0 &&
      cols.after === 0 &&
      rows.before === 0 &&
      cols.before === 0,
  };
}

/**
 * What a fitted range frame prints: the laid-out tracks of its table that
 * fit its content box, whole rows and columns from the top-left (a track
 * that does not fit, and every one after it, overflows). The heading row
 * and column a page may print are not sheet tracks. No box: all of it.
 */
export function fittedWindow(
  content: LoweredContent,
  box: { widthPt: number; heightPt: number } | undefined,
): CellBlock | null {
  const rows = content.rows.filter((r) => r.index !== HEADING_INDEX);
  const cols = content.cols.filter((c) => c.index !== HEADING_INDEX);
  if (rows.length === 0 || cols.length === 0) return null;
  const take = <T extends { index: number }>(
    tracks: readonly T[],
    size: (t: T) => number,
    room: number | undefined,
  ): T[] => {
    if (room === undefined) return [...tracks];
    const kept: T[] = [];
    let used = 0;
    for (const t of tracks) {
      used += size(t);
      // Half a point of slack: the engine's layout rounds.
      if (used > room + 0.5 && kept.length > 0) break;
      kept.push(t);
      if (used > room + 0.5) break;
    }
    return kept;
  };
  // Rows the page prints above the body (a heading row) take room first.
  const headingPt = content.rows
    .filter((r) => r.index === HEADING_INDEX)
    .reduce((a, r) => a + r.heightPt, 0);
  const headingColPt = content.cols
    .filter((c) => c.index === HEADING_INDEX)
    .reduce((a, c) => a + c.widthPt, 0);
  const keptRows = take(
    rows,
    (r) => r.heightPt,
    box ? box.heightPt - headingPt : undefined,
  );
  const keptCols = take(
    cols,
    (c) => c.widthPt,
    box ? box.widthPt - headingColPt : undefined,
  );
  return {
    top: Math.min(...keptRows.map((r) => r.index)),
    left: Math.min(...keptCols.map((c) => c.index)),
    bottom: Math.max(...keptRows.map((r) => r.index)),
    right: Math.max(...keptCols.map((c) => c.index)),
  };
}
