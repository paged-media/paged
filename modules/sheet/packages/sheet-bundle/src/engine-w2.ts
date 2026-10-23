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

/** One data-validation rule (ADR 517). Formulas carry `=`. */
export interface ValidationRuleInfo {
  index: number;
  sqref: string;
  type:
    | "none"
    | "whole"
    | "decimal"
    | "list"
    | "date"
    | "time"
    | "textLength"
    | "custom";
  operator: string;
  formula1?: string | null;
  formula2?: string | null;
  allowBlank: boolean;
  inCellDropdown: boolean;
  showInput: boolean;
  promptTitle?: string | null;
  prompt?: string | null;
  showError: boolean;
  errorStyle: "stop" | "warning" | "information";
  errorTitle?: string | null;
  error?: string | null;
}

/** A rule to author (absent fields: Excel's defaults, or kept on update). */
export interface ValidationRuleArg {
  type?: ValidationRuleInfo["type"] | "any";
  operator?: string;
  formula1?: string;
  formula2?: string;
  listItems?: string[];
  allowBlank?: boolean;
  inCellDropdown?: boolean;
  showInput?: boolean;
  promptTitle?: string;
  prompt?: string;
  showError?: boolean;
  errorStyle?: "stop" | "warning" | "information";
  errorTitle?: string;
  error?: string;
}

/** Excel's validation alert. */
export interface ValidationAlert {
  style: "stop" | "warning" | "information";
  title: string;
  message: string;
}

export interface EntryCheck {
  valid: boolean;
  alert?: ValidationAlert | null;
}

/** A validated entry: applied, or the alert to show (a warning or
 *  information alert applies when re-entered with `confirmed`). */
export interface EnterResult {
  applied: boolean;
  alert?: ValidationAlert | null;
  result?: ChangedCells | null;
}

export interface CellValidation {
  rule: ValidationRuleInfo;
  listItems?: string[] | null;
}

export interface InvalidCell {
  row: number;
  col: number;
  rule: number;
}

/** One sort level (Excel's Sort dialog). */
export interface SortKey {
  index: number;
  descending?: boolean;
  sortBy?: "value" | "cellColor" | "fontColor";
  color?: string;
  customList?: string[];
}

export interface SortSpec {
  keys: SortKey[];
  hasHeader?: boolean;
  leftToRight?: boolean;
  caseSensitive?: boolean;
}

/** A sort's result (the undo journal's inputs and style swap). */
export interface SortOutcome extends ChangedCells {
  edits: {
    sheet: number;
    row: number;
    col: number;
    prevInput: string;
    nextInput: string;
  }[];
  styles?: { range: string; before: number[]; after: number[] };
}

export interface DateGroup {
  year: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;
}

/** One AutoFilter column criterion. */
export type FilterCriterion =
  | { kind: "values"; values?: string[]; blanks?: boolean; dates?: DateGroup[] }
  | {
      kind: "custom";
      and?: boolean;
      conditions: { op: string; val: string }[];
    }
  | { kind: "contains"; text: string }
  | { kind: "top"; n: number; percent?: boolean; top?: boolean }
  | { kind: "dynamic"; type: string }
  | { kind: "color"; color: string; cellColor?: boolean }
  | { kind: "icon"; set: string; id?: number };

export interface FilterOutcome {
  hiddenRows: number[];
  changed?: CellChange[];
}

export interface FilterState {
  range: string;
  columns: {
    col: number;
    criterion?: FilterCriterion | null;
    applied: boolean;
  }[];
  hiddenRows: number[];
}

/** What a column's filter dropdown shows. */
export interface FilterColumnValues {
  kind: "text" | "number" | "date";
  items: { text: string; count: number; selected: boolean }[];
  dates: { year: number; month: number; day: number; count: number }[];
  blanks: number;
  blanksSelected: boolean;
  fillColors: string[];
  fontColors: string[];
  criterion?: FilterCriterion | null;
}

export interface FilterViewInfo {
  sheet: number;
  name: string;
  range: string;
  columns: { col: number; criterion: FilterCriterion }[];
}

/** One table, read whole (ADR 517). */
export interface TableDetail {
  name: string;
  sheet: number;
  range: string;
  headerRow: boolean;
  totalsRow: boolean;
  columns: {
    name: string;
    calculatedFormula?: string | null;
    totalsFunction?: string | null;
    totalsFormula?: string | null;
    totalsLabel?: string | null;
  }[];
  style?: string | null;
  firstColumn: boolean;
  lastColumn: boolean;
  bandedRows: boolean;
  bandedColumns: boolean;
}

export interface TableStyleArg {
  style?: string;
  firstColumn?: boolean;
  lastColumn?: boolean;
  bandedRows?: boolean;
  bandedColumns?: boolean;
}

/** What Goal Seek found (ADR 517). */
export interface GoalSeekResult {
  found: boolean;
  value: number;
  result: number;
  iterations: number;
  prevInput: string;
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
  listValidationRules?(sheet: number): ValidationRuleInfo[];
  validationAt?(
    sheet: number,
    row: number,
    col: number,
  ): CellValidation | undefined;
  checkEntry?(
    sheet: number,
    row: number,
    col: number,
    input: string,
  ): EntryCheck;
  enterCell?(
    sheet: number,
    row: number,
    col: number,
    input: string,
    confirmed?: boolean,
  ): EnterResult;
  invalidCells?(sheet: number): InvalidCell[];
  setValidation?(
    sheet: number,
    range: string,
    rule: ValidationRuleArg,
  ): ValidationRuleInfo[];
  updateValidation?(
    sheet: number,
    index: number,
    rule: ValidationRuleArg,
  ): ValidationRuleInfo[];
  clearValidation?(sheet: number, range: string): ValidationRuleInfo[];
  sortRangeBy?(sheet: number, range: string, spec: SortSpec): SortOutcome;
  setAutofilter?(sheet: number, range: string): FilterOutcome;
  removeAutofilter?(sheet: number): FilterOutcome;
  setFilterColumn?(
    sheet: number,
    range: string,
    col: number,
    criterion?: FilterCriterion | null,
  ): FilterOutcome;
  clearFilterCriteria?(sheet: number): FilterOutcome;
  reapplyFilter?(sheet: number): FilterOutcome;
  filterState?(sheet: number): FilterState | undefined;
  filterColumnValues?(sheet: number, col: number): FilterColumnValues;
  saveFilterView?(sheet: number, name: string): void;
  applyFilterView?(sheet: number, name: string): FilterOutcome;
  deleteFilterView?(sheet: number, name: string): void;
  listFilterViews?(): FilterViewInfo[];
  setFilterViews?(views: FilterViewInfo[]): void;
  listTableDetails?(): TableDetail[];
  tableDetail?(name: string): TableDetail;
  tableStyleNames?(): string[];
  createTable?(
    sheet: number,
    range: string,
    hasHeaders: boolean,
    style?: string,
    name?: string,
  ): TableDetail;
  resizeTable?(name: string, range: string): TableDetail;
  renameTable?(name: string, newName: string): TableDetail;
  setTableTotals?(name: string, show: boolean): TableDetail;
  setTotalsFunction?(
    name: string,
    column: string,
    fn: string,
    text?: string,
  ): TableDetail;
  setCalculatedColumn?(
    name: string,
    column: string,
    formula: string | null,
  ): TableDetail;
  setTableStyle?(name: string, arg: TableStyleArg): TableDetail;
  goalSeek?(
    sheet: number,
    setRow: number,
    setCol: number,
    target: number,
    changingSheet: number,
    changingRow: number,
    changingCol: number,
  ): GoalSeekResult;
  calculateDataTables?(): [number, number, number][];
  listDataTables?(): [number, string][];
  tableFilterColumnValues?(name: string, col: number): FilterColumnValues;
  clearTableFilter?(name: string): FilterOutcome;
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
  list_validation_rules?(sheet: number): ValidationRuleInfo[];
  validation_at?(
    sheet: number,
    row: number,
    col: number,
  ): CellValidation | undefined;
  check_entry?(
    sheet: number,
    row: number,
    col: number,
    input: string,
  ): EntryCheck;
  enter_cell?(
    sheet: number,
    row: number,
    col: number,
    input: string,
    confirmed: boolean,
  ): EnterResult;
  invalid_cells?(sheet: number): InvalidCell[];
  set_validation?(
    sheet: number,
    range: string,
    rule: ValidationRuleArg,
  ): ValidationRuleInfo[];
  update_validation?(
    sheet: number,
    index: number,
    rule: ValidationRuleArg,
  ): ValidationRuleInfo[];
  clear_validation?(sheet: number, range: string): ValidationRuleInfo[];
  sort_range_by?(sheet: number, range: string, spec: SortSpec): SortOutcome;
  set_autofilter?(sheet: number, range: string): FilterOutcome;
  remove_autofilter?(sheet: number): FilterOutcome;
  set_filter_column?(
    sheet: number,
    range: string,
    col: number,
    criterion?: FilterCriterion,
  ): FilterOutcome;
  clear_filter_criteria?(sheet: number): FilterOutcome;
  reapply_filter?(sheet: number): FilterOutcome;
  filter_state?(sheet: number): FilterState | undefined;
  filter_column_values?(sheet: number, col: number): FilterColumnValues;
  save_filter_view?(sheet: number, name: string): void;
  apply_filter_view?(sheet: number, name: string): FilterOutcome;
  delete_filter_view?(sheet: number, name: string): void;
  list_filter_views?(): FilterViewInfo[];
  set_filter_views?(views: FilterViewInfo[]): void;
  list_table_details?(): TableDetail[];
  table_detail?(name: string): TableDetail;
  table_style_names?(): string[];
  create_table?(
    sheet: number,
    range: string,
    has_headers: boolean,
    style: string,
    name: string,
  ): TableDetail;
  resize_table?(name: string, range: string): TableDetail;
  rename_table?(name: string, new_name: string): TableDetail;
  set_table_totals?(name: string, show: boolean): TableDetail;
  set_totals_function?(
    name: string,
    column: string,
    fn: string,
    text: string,
  ): TableDetail;
  set_calculated_column?(
    name: string,
    column: string,
    formula: string,
  ): TableDetail;
  set_table_style?(name: string, arg: TableStyleArg): TableDetail;
  goal_seek?(
    sheet: number,
    set_row: number,
    set_col: number,
    target: number,
    changing_sheet: number,
    changing_row: number,
    changing_col: number,
  ): GoalSeekResult;
  calculate_data_tables?(): [number, number, number][];
  list_data_tables?(): [number, string][];
  table_filter_column_values?(name: string, col: number): FilterColumnValues;
  clear_table_filter?(name: string): FilterOutcome;
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
    listValidationRules: read<ValidationRuleInfo[]>("list_validation_rules"),
    validationAt: read<CellValidation | undefined>("validation_at"),
    checkEntry: read<EntryCheck>("check_entry"),
    enterCell: (sheet, row, col, input, confirmed) => {
      tick();
      return need("enter_cell")(
        sheet,
        row,
        col,
        input,
        confirmed ?? false,
      ) as EnterResult;
    },
    invalidCells: read<InvalidCell[]>("invalid_cells"),
    setValidation: read<ValidationRuleInfo[]>("set_validation"),
    updateValidation: read<ValidationRuleInfo[]>("update_validation"),
    clearValidation: read<ValidationRuleInfo[]>("clear_validation"),
    sortRangeBy: write<SortOutcome>("sort_range_by"),
    setAutofilter: write<FilterOutcome>("set_autofilter"),
    removeAutofilter: write<FilterOutcome>("remove_autofilter"),
    setFilterColumn: (sheet, range, col, criterion) => {
      tick();
      return need("set_filter_column")(
        sheet,
        range,
        col,
        criterion ?? undefined,
      ) as FilterOutcome;
    },
    clearFilterCriteria: write<FilterOutcome>("clear_filter_criteria"),
    reapplyFilter: write<FilterOutcome>("reapply_filter"),
    filterState: read<FilterState | undefined>("filter_state"),
    filterColumnValues: read<FilterColumnValues>("filter_column_values"),
    saveFilterView: read<void>("save_filter_view"),
    applyFilterView: write<FilterOutcome>("apply_filter_view"),
    deleteFilterView: read<void>("delete_filter_view"),
    listFilterViews: read<FilterViewInfo[]>("list_filter_views"),
    setFilterViews: read<void>("set_filter_views"),
    listTableDetails: read<TableDetail[]>("list_table_details"),
    tableDetail: read<TableDetail>("table_detail"),
    tableStyleNames: read<string[]>("table_style_names"),
    createTable: (sheet, range, hasHeaders, style, name) => {
      tick();
      return need("create_table")(
        sheet,
        range,
        hasHeaders,
        style ?? "",
        name ?? "",
      ) as TableDetail;
    },
    resizeTable: write<TableDetail>("resize_table"),
    renameTable: write<TableDetail>("rename_table"),
    setTableTotals: write<TableDetail>("set_table_totals"),
    setTotalsFunction: (name, column, fn, text) => {
      tick();
      return need("set_totals_function")(
        name,
        column,
        fn,
        text ?? "",
      ) as TableDetail;
    },
    setCalculatedColumn: (name, column, formula) => {
      tick();
      return need("set_calculated_column")(
        name,
        column,
        formula ?? "",
      ) as TableDetail;
    },
    setTableStyle: read<TableDetail>("set_table_style"),
    goalSeek: write<GoalSeekResult>("goal_seek"),
    calculateDataTables: write<[number, number, number][]>(
      "calculate_data_tables",
    ),
    listDataTables: read<[number, string][]>("list_data_tables"),
    tableFilterColumnValues: read<FilterColumnValues>(
      "table_filter_column_values",
    ),
    clearTableFilter: write<FilterOutcome>("clear_table_filter"),
  };
}
