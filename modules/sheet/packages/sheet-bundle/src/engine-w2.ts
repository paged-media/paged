// The engine doors of the W2.6–W2.8 work and the scope amendment (sheet ADR
// 517): outline and visibility, protection, tables, sort and filter, data
// validation, what-if. Every method forwards to a sheet-js wasm call (the
// Rust engine decides everything); the camelCase facade below is spread into
// `wrapEngine`'s. All methods are optional on the facade so a test fake or an
// older artifact without them stays a valid engine.

import type { CellChange } from "./engine";

/** A changed-cells answer (the displays after the recalc). */
export interface ChangedCells {
  changed: CellChange[];
}

export type Axis = "rows" | "cols";

/** One outline group (0-based first/last of the detail). */
export interface OutlineGroup {
  first: number;
  last: number;
  level: number;
  collapsed: boolean;
  summary?: number | null;
}

/** A sheet's outline and hidden rows/columns, for the grid's outline bar. */
export interface OutlineInfo {
  rows: OutlineGroup[];
  cols: OutlineGroup[];
  maxRowLevel: number;
  maxColLevel: number;
  summaryBelow: boolean;
  summaryRight: boolean;
  hiddenRows: number[];
  hiddenCols: number[];
}

/** A sheet's protection (what a protected sheet still allows). */
export interface SheetProtectionInfo {
  protected: boolean;
  hasPassword: boolean;
  objects: boolean;
  scenarios: boolean;
  formatCells: boolean;
  formatColumns: boolean;
  formatRows: boolean;
  insertColumns: boolean;
  insertRows: boolean;
  insertHyperlinks: boolean;
  deleteColumns: boolean;
  deleteRows: boolean;
  selectLockedCells: boolean;
  selectUnlockedCells: boolean;
  sort: boolean;
  autoFilter: boolean;
  pivotTables: boolean;
}

/** Protect Sheet's options (Excel's defaults when absent). */
export type ProtectOptions = Partial<
  Omit<SheetProtectionInfo, "protected" | "hasPassword">
> & { password?: string };

export interface WorkbookProtectionInfo {
  structure: boolean;
  windows: boolean;
  hasPassword: boolean;
}

export interface CellProtection {
  locked: boolean;
  formulaHidden: boolean;
  sheetProtected: boolean;
}

/** The camelCase W2 facade (spread into `SheetEngine`). */
export interface SheetEngineW2 {
  outline?(sheet: number): OutlineInfo;
  group?(sheet: number, axis: Axis, first: number, last: number): ChangedCells;
  ungroup?(
    sheet: number,
    axis: Axis,
    first: number,
    last: number,
  ): ChangedCells;
  setGroupCollapsed?(
    sheet: number,
    axis: Axis,
    at: number,
    collapsed: boolean,
  ): ChangedCells;
  showOutlineLevel?(sheet: number, axis: Axis, level: number): ChangedCells;
  setHidden?(
    sheet: number,
    axis: Axis,
    first: number,
    last: number,
    hidden: boolean,
  ): ChangedCells;
  setSheetState?(
    sheet: number,
    state: "visible" | "hidden" | "veryHidden",
  ): void;
  sheetProtection?(sheet: number): SheetProtectionInfo;
  protectSheet?(sheet: number, opts?: ProtectOptions): SheetProtectionInfo;
  unprotectSheet?(sheet: number, password: string): void;
  workbookProtection?(): WorkbookProtectionInfo;
  protectWorkbook?(
    password: string,
    structure: boolean,
    windows: boolean,
  ): void;
  unprotectWorkbook?(password: string): void;
  cellProtection?(sheet: number, row: number, col: number): CellProtection;
}

/** The snake_case wasm methods behind it. */
export interface SheetWasmEngineW2 {
  outline?(sheet: number): OutlineInfo;
  group?(
    sheet: number,
    axis: string,
    first: number,
    last: number,
  ): ChangedCells;
  ungroup?(
    sheet: number,
    axis: string,
    first: number,
    last: number,
  ): ChangedCells;
  set_group_collapsed?(
    sheet: number,
    axis: string,
    at: number,
    collapsed: boolean,
  ): ChangedCells;
  show_outline_level?(sheet: number, axis: string, level: number): ChangedCells;
  set_hidden?(
    sheet: number,
    axis: string,
    first: number,
    last: number,
    hidden: boolean,
  ): ChangedCells;
  set_sheet_state?(sheet: number, state: string): void;
  sheet_protection?(sheet: number): SheetProtectionInfo;
  protect_sheet?(sheet: number, opts?: ProtectOptions): SheetProtectionInfo;
  unprotect_sheet?(sheet: number, password: string): void;
  workbook_protection?(): WorkbookProtectionInfo;
  protect_workbook?(
    password: string,
    structure: boolean,
    windows: boolean,
  ): void;
  unprotect_workbook?(password: string): void;
  cell_protection?(sheet: number, row: number, col: number): CellProtection;
}

type Need = <K extends keyof SheetWasmEngineW2>(
  k: K,
) => (...a: unknown[]) => unknown;

/** The W2 facade over a booted wasm engine. `need` throws a "rebuild the
 *  wasm" error for a method the artifact predates; `tick` hands the engine
 *  the host clock before a write that recalcs. */
export function wrapW2(need: Need, tick: () => void): Required<SheetEngineW2> {
  const write =
    <R>(k: keyof SheetWasmEngineW2) =>
    (...a: unknown[]) => {
      tick();
      return need(k)(...a) as R;
    };
  const read =
    <R>(k: keyof SheetWasmEngineW2) =>
    (...a: unknown[]) =>
      need(k)(...a) as R;
  return {
    outline: read<OutlineInfo>("outline"),
    group: write<ChangedCells>("group"),
    ungroup: write<ChangedCells>("ungroup"),
    setGroupCollapsed: write<ChangedCells>("set_group_collapsed"),
    showOutlineLevel: write<ChangedCells>("show_outline_level"),
    setHidden: write<ChangedCells>("set_hidden"),
    setSheetState: write<void>("set_sheet_state"),
    sheetProtection: read<SheetProtectionInfo>("sheet_protection"),
    protectSheet: (sheet, opts) =>
      need("protect_sheet")(sheet, opts ?? undefined) as SheetProtectionInfo,
    unprotectSheet: read<void>("unprotect_sheet"),
    workbookProtection: read<WorkbookProtectionInfo>("workbook_protection"),
    protectWorkbook: read<void>("protect_workbook"),
    unprotectWorkbook: read<void>("unprotect_workbook"),
    cellProtection: read<CellProtection>("cell_protection"),
  };
}
