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

// W3.A2 — table cell selection state (the editor's first table surface).
//
// State store shared between the canvas hit handler (which sets a cell
// selection from `HitResult.tableContext`), the Table panel (which
// reads the selected cell to drive its SetProperty / table-line ops),
// and the cell overlay (which outlines the selected cell). Follows the
// threading / guide-drag context precedent: a small, host-agnostic
// context with an optional accessor so the slim viewer degrades when no
// provider is mounted.
//
// The selection is engine-addressable: `HitResult.tableContext` now
// carries `{ tableId, row, col }`, and the hit's `storyId` is the
// owning story. Together they form the `TableCell` ElementId
// (`{ kind: "tableCell", id: { story_id, table_id, row, col } }`) that
// `setElementProperty` / `applyTableStyle` target and that
// `elementGeometry` resolves to a page-space outline. `pageId` is the
// page the hit landed on (so the overlay draws on the right page);
// `frameBounds` is the containing table frame's page-local AABB, kept
// as the outline fallback when the engine can't yet resolve a precise
// per-cell rect.
//
// Writers: the canvas hit handler (select / clear). Readers: the Table
// panel + the cell overlay.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

import {
  changesTheDocument,
  type ElementId,
  type PageId,
} from "@paged-media/client";

import { useOptionalCanvasClient } from "./canvas-client-context";

/**
 * The selected table cell. `storyId` + `tableId` + `row` + `col`
 * address the cell on the wire; `pageId` is where the overlay draws.
 * `frameBounds` is the containing table-frame AABB in page-local pt
 * (`[top, left, bottom, right]`), used as the overlay outline until /
 * unless a precise per-cell rect is available.
 */
export interface TableCellSelection {
  storyId: string;
  tableId: string;
  row: number;
  col: number;
  pageId: PageId;
  /** Containing table-frame AABB, page-local pt `[t,l,b,r]`. */
  frameBounds: [number, number, number, number] | null;
  /** Precise per-cell AABB in page-space pt `[t,l,b,r]` when the
   *  engine resolved one via `elementGeometry(cellElementId)`; the
   *  overlay prefers this and falls back to `frameBounds`. */
  cellRect?: [number, number, number, number] | null;
}

interface TableSelectionContextValue {
  /** The selected cell, or null when no cell is selected. */
  cell: TableCellSelection | null;
  /** Select a table cell (the canvas hit handler, on a table hit). */
  selectCell(cell: TableCellSelection): void;
  /** Drop the cell selection (a non-table hit, an empty click, or a
   *  document load). */
  clearCell(): void;
  /** The `TableCell` ElementId for the current cell, or null. The
   *  Table panel passes this straight into `setElementProperty`
   *  (cell insets / fill / vertical justification / applied styles)
   *  and the overlay into `elementGeometry`. */
  cellElementId: ElementId | null;
}

const Context = createContext<TableSelectionContextValue | null>(null);

/** Build the wire `TableCell` ElementId from a cell selection. */
export function tableCellElementId(cell: TableCellSelection): ElementId {
  return {
    kind: "tableCell",
    id: {
      story_id: cell.storyId,
      table_id: cell.tableId,
      row: cell.row,
      col: cell.col,
    },
  };
}

export function TableSelectionProvider({ children }: PropsWithChildren) {
  const [cell, setCell] = useState<TableCellSelection | null>(null);

  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const selectCell = useCallback((next: TableCellSelection) => {
    setCell(next);
  }, []);
  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const clearCell = useCallback(() => {
    setCell(null);
  }, []);

  // eslint-disable-next-line no-restricted-syntax -- its type argument types the value (ADR 229)
  const cellElementId = useMemo<ElementId | null>(
    () => (cell ? tableCellElementId(cell) : null),
    [cell],
  );

  // PN-209: a cell selection does not outlive its cell. After any change
  // to the document the engine is asked for the cell. A cell it no longer
  // has moves to its nearest neighbour that is left (a deleted row or
  // column, as InDesign moves the insertion point), and with no table left
  // (Delete table, an undo of its insertion) the selection is dropped, so
  // the Table panel and the overlay stop offering it.
  const client = useOptionalCanvasClient();
  useEffect(() => {
    if (!client || !cell || !cellElementId) return;
    let live = true;
    const off = client.subscribe((msg) => {
      if (!changesTheDocument(msg)) return;
      void (async () => {
        const here = await client.elementGeometry([cellElementId]);
        if (!live || here.length > 0) return;
        const near = [
          [cell.row - 1, cell.col],
          [cell.row, cell.col - 1],
          [cell.row - 1, cell.col - 1],
          [0, 0],
        ].filter(([r, c]) => r! >= 0 && c! >= 0);
        let next: TableCellSelection | null = null;
        for (const [row, col] of near) {
          const moved = { ...cell, row: row!, col: col!, cellRect: null };
          const g = await client.elementGeometry([tableCellElementId(moved)]);
          if (g.length > 0) {
            next = moved;
            break;
          }
        }
        if (live) setCell((now) => (now === cell ? next : now));
      })().catch(() => {});
    });
    return () => {
      live = false;
      off();
    };
  }, [client, cell, cellElementId]);

  // eslint-disable-next-line no-restricted-syntax -- its type argument types the value (ADR 229)
  const value = useMemo<TableSelectionContextValue>(
    () => ({ cell, selectCell, clearCell, cellElementId }),
    [cell, selectCell, clearCell, cellElementId],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useTableSelection(): TableSelectionContextValue {
  const ctx = useContext(Context);
  if (!ctx) {
    throw new Error("useTableSelection called outside TableSelectionProvider");
  }
  return ctx;
}

/** Optional variant — null when no provider is mounted, so a host that
 *  hasn't wired the table surface (e.g. the slim viewer) degrades. */
export function useOptionalTableSelection(): TableSelectionContextValue | null {
  return useContext(Context);
}
