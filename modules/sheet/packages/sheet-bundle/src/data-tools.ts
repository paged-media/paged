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

// The data tools of the in-frame grid (sheet ADR 517): data validation on
// entry (the alerts, the input message, the list dropdown, circle invalid
// data, the Data validation card), AutoFilter (the header buttons and the
// filter menu), the Sort card, hide / unhide and group / ungroup, cell
// protection, and Goal Seek. Thin glue (sheet CLAUDE.md §3): every rule,
// criterion, sort order and outline level is the engine's; this keeps the
// UI state (which alert or card is open) and routes the answers back,
// journaling what changes cells so one Cmd-Z undoes it.

import type { BundleHost } from "@paged-media/plugin-api";

import type { CellEditRecord, SheetEngine } from "./engine";
import type {
  CellProtection,
  EnterResult,
  FilterColumnValues,
  FilterCriterion,
  FilterState,
  GoalSeekResult,
  InvalidCell,
  SortKey,
  SortSpec,
  ValidationAlert,
  ValidationRuleArg,
  ValidationRuleInfo,
} from "./engine-w2";
import { a1Of } from "./surface/formula-refs";

/** Excel's alert when a locked cell of a protected sheet is changed. */
export const PROTECTED_ALERT: ValidationAlert = {
  style: "information",
  title: "Protected cell",
  message:
    "The cell you are trying to change is on a protected sheet. To make a change, unprotect the sheet.",
};

/** An alert that holds an entry back until it is answered. */
export interface EntryAlert extends ValidationAlert {
  /** The cell is locked on a protected sheet (OK only). */
  protected: boolean;
}

/** The buttons an entry alert offers, per style (Excel's). */
export type EntryAnswer = "ok" | "yes" | "no" | "retry" | "cancel";

/** The input message and the list of the active cell's validation. */
export interface CellPrompt {
  title: string;
  message: string;
  /** A list rule's items when it shows the in-cell dropdown, else null. */
  items: string[] | null;
}

/** The options card open under the bar. */
export type DataCard =
  | { kind: "validation" }
  | { kind: "sort" }
  | { kind: "filter"; col: number }
  | { kind: "goalSeek" };

/** Where the AutoFilter's dropdown buttons sit: its header row, its
 *  columns (sheet indices), and the columns that filter. */
export interface FilterButtons {
  row: number;
  left: number;
  right: number;
  filtered: number[];
}

/** What the Sort card offers for the range it sorts. */
export interface SortDialogInfo {
  range: string;
  /** Whether the range's first row looks like headers (the card's default). */
  hasHeader: boolean;
  /** The range's columns, labelled by their header text or letter. */
  columns: { index: number; label: string; header: string }[];
}

/** One Goal Seek's answer. */
export interface GoalSeekOutcome {
  found: boolean;
  value: number;
  result: number;
  iterations: number;
}

/** A journal step the session undoes and redoes with the engine. */
export interface DataStep {
  undo(engine: SheetEngine): void;
  redo(engine: SheetEngine): void;
}

type Result = { ok: true } | { ok: false; message: string };

export interface DataToolsApi {
  /** The alert an entry is waiting on, or null. */
  entryAlert(): EntryAlert | null;
  /** Answer the open alert: Retry / No reopen the entry, Yes / OK apply a
   *  warning's or information's entry, Cancel drops it. */
  answerEntryAlert(answer: EntryAnswer): void;
  /** The active cell's input message and list items, or null. */
  cellPrompt(): CellPrompt | null;
  /** Whether the active cell's list dropdown is open. */
  validationListOpen(): boolean;
  /** Open (Alt+Down) or close the active cell's dropdown: its validation
   *  list, or the filter menu on an AutoFilter header. Whether one opened. */
  openCellDropdown(open?: boolean): boolean;
  /** Enter a list item into the active cell (through validation). */
  chooseListItem(text: string): void;
  /** The cells that break their validation while "Circle invalid data" is
   *  on, else null. */
  invalidCircles(): InvalidCell[] | null;
  /** Turn "Circle invalid data" on or off (default: toggle). */
  toggleInvalidCircles(on?: boolean): boolean;
  /** A cell's protection flags (null: unknown). */
  cellProtectionAt(row: number, col: number): CellProtection | null;
  /** The card open under the bar, or null. */
  dataCard(): DataCard | null;
  openDataCard(card: DataCard): boolean;
  closeDataCard(): void;
  /** The selection the Data validation card edits, and the rule of its
   *  active cell. */
  validationDraft(): { range: string; rule: ValidationRuleInfo | null } | null;
  /** Put `rule` on the selection (`type: "any"` clears it). */
  applyValidation(rule: ValidationRuleArg): Result;
  /** Remove every rule from the selection. */
  clearValidationOnSelection(): Result;
  /** The AutoFilter's buttons on the active sheet, or null. */
  filterButtons(): FilterButtons | null;
  /** The filter menu's data for sheet column `col`, or null. */
  filterValues(col: number): FilterColumnValues | null;
  /** Set (or with null clear) sheet column `col`'s criterion. */
  applyFilter(col: number, criterion: FilterCriterion | null): Result;
  /** Turn AutoFilter on over the selection's region, or off (Ctrl+Shift+L). */
  toggleAutofilter(): Result;
  /** Sort the AutoFilter's rows by sheet column `col` (the filter menu). */
  sortFilterColumn(col: number, key: Omit<SortKey, "index">): Result;
  /** What the Sort card offers, or null without a range. */
  sortDialogInfo(): SortDialogInfo | null;
  /** Sort the card's range by `spec` (its keys index the range's columns
   *  — rows when left to right); one undo step. */
  sortWith(spec: SortSpec, range?: string): Result;
  /** Hide (or unhide) the selected rows or columns. */
  hideSelection(hidden: boolean): Result;
  /** Group (or ungroup) the selected rows or columns. */
  groupSelection(group: boolean): Result;
  /** Whether the engine can Goal Seek. */
  canGoalSeek(): boolean;
  /** Goal Seek: make `setCell` reach `target` by changing `changingCell`
   *  (A1 references, an optional `Sheet!` prefix). One undo step. */
  goalSeek(
    setCell: string,
    target: number,
    changingCell: string,
  ): ({ ok: true } & GoalSeekOutcome) | { ok: false; message: string };
}

export interface DataToolsContext {
  host: BundleHost;
  engine(): SheetEngine | null;
  sheet(): number | null;
  selection(): {
    anchorRow: number;
    anchorCol: number;
    rows: number;
    cols: number;
  } | null;
  active(): { row: number; col: number } | null;
  /** The content version (bumps on every engine change). */
  revision(): number;
  /** The sheet's used extent. */
  extent(): { rows: number; cols: number } | null;
  /** Typed entry through validation and journal it; null when no engine
   *  or the write failed. */
  enter(
    sheet: number,
    row: number,
    col: number,
    input: string,
    confirmed: boolean,
  ): EnterResult | null;
  /** Select `(row, col)` and open an edit on it holding `text`. */
  reopenEdit(row: number, col: number, text: string): void;
  /** Journal cell rewrites and an engine step as one undo step. */
  journal(edits: readonly CellEditRecord[], step: DataStep | null): void;
  /** Engine state changed without a journal entry: bump the version,
   *  schedule the page refresh and persist, re-render. */
  edited(): void;
  /** Cells changed through `enter` / `journal`: re-render. */
  repaint(): void;
  /** UI state changed (an alert or a card): re-render. */
  changedUi(): void;
}

const MAX_ROW = 1_048_575;
const MAX_COL = 16_383;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `A1:F20` → its corners (0-based); null when it does not read. */
export function parseA1Range(
  text: string,
): { top: number; left: number; bottom: number; right: number } | null {
  const m = /^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i.exec(
    text.trim().replace(/^.*!/, ""),
  );
  if (!m) return null;
  const col = (s: string) =>
    [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) -
    1;
  const r0 = Number(m[2]) - 1;
  const c0 = col(m[1]!);
  const r1 = m[4] ? Number(m[4]) - 1 : r0;
  const c1 = m[3] ? col(m[3]) : c0;
  return {
    top: Math.min(r0, r1),
    left: Math.min(c0, c1),
    bottom: Math.max(r0, r1),
    right: Math.max(c0, c1),
  };
}

export function createDataTools(ctx: DataToolsContext): {
  api: DataToolsApi;
  /** A typed entry from the cell editor: through protection and
   *  validation. False when it is held back (an alert now shows). */
  enterTyped(sheet: number, row: number, col: number, text: string): boolean;
  /** Before an edit opens on `(row, col)`: false (and the protected-cell
   *  alert shows) when the cell is locked on a protected sheet. */
  mayEdit(row: number, col: number): boolean;
  /** Drop every open alert, list and card (a workbook or frame change). */
  reset(): void;
} {
  const { host } = ctx;
  let alert: (EntryAlert & { row: number; col: number; text: string }) | null =
    null;
  let card: DataCard | null = null;
  let listOpen = false;
  let circlesOn = false;
  // Reads keyed by the content version, so a render does not re-ask the
  // engine for what has not changed.
  const memo = new Map<string, unknown>();
  let memoRev = -1;
  function cached<T>(key: string, read: () => T): T {
    const rev = ctx.revision();
    if (rev !== memoRev) {
      memo.clear();
      memoRev = rev;
    }
    if (memo.has(key)) return memo.get(key) as T;
    let v: T;
    try {
      v = read();
    } catch (err) {
      host.log.debug(`data tools: ${key} refused`, err);
      v = null as T;
    }
    memo.set(key, v);
    return v;
  }
  const dropMemo = () => {
    memo.clear();
    memoRev = -1;
  };

  function protectionAt(row: number, col: number): CellProtection | null {
    const e = ctx.engine();
    const sheet = ctx.sheet();
    if (!e?.cellProtection || sheet === null) return null;
    return cached(`prot:${sheet}:${row}:${col}`, () =>
      e.cellProtection!(sheet, row, col),
    );
  }

  function mayEdit(row: number, col: number): boolean {
    const p = protectionAt(row, col);
    if (!p || !p.sheetProtected || !p.locked) return true;
    alert = { ...PROTECTED_ALERT, protected: true, row, col, text: "" };
    listOpen = false;
    ctx.changedUi();
    return false;
  }

  function enterTyped(
    sheet: number,
    row: number,
    col: number,
    text: string,
    confirmed = false,
  ): boolean {
    if (!mayEdit(row, col)) return false;
    const r = ctx.enter(sheet, row, col, text, confirmed);
    if (!r) return true; // the write failed and was logged; nothing to ask
    if (r.applied) {
      dropMemo();
      return true;
    }
    if (r.alert) {
      alert = { ...r.alert, protected: false, row, col, text };
      ctx.changedUi();
      return false;
    }
    return true;
  }

  function target(): {
    sheet: number;
    top: number;
    left: number;
    bottom: number;
    right: number;
  } | null {
    const sheet = ctx.sheet();
    const sel = ctx.selection();
    if (sheet === null || !sel) return null;
    return {
      sheet,
      top: sel.anchorRow,
      left: sel.anchorCol,
      bottom: sel.anchorRow + sel.rows - 1,
      right: sel.anchorCol + sel.cols - 1,
    };
  }

  function filterState(): FilterState | null {
    const e = ctx.engine();
    const sheet = ctx.sheet();
    if (!e?.filterState || sheet === null) return null;
    return cached(`filter:${sheet}`, () => e.filterState!(sheet) ?? null);
  }

  /** The range a one-cell selection stands for (the AutoFilter's or a
   *  table's around it, else the sheet's used range); a larger selection
   *  is itself. Clipped to the used extent for whole rows / columns. */
  function regionOfSelection(): string | null {
    const t = target();
    if (!t) return null;
    const ext = ctx.extent();
    if (t.top !== t.bottom || t.left !== t.right) {
      const bottom = ext
        ? Math.min(t.bottom, Math.max(ext.rows - 1, t.top))
        : t.bottom;
      const right = ext
        ? Math.min(t.right, Math.max(ext.cols - 1, t.left))
        : t.right;
      return a1Of(t.top, t.left, bottom, right);
    }
    const inside = (r: {
      top: number;
      left: number;
      bottom: number;
      right: number;
    }) =>
      t.top >= r.top &&
      t.top <= r.bottom &&
      t.left >= r.left &&
      t.left <= r.right;
    const fs = filterState();
    const fr = fs ? parseA1Range(fs.range) : null;
    if (fr && inside(fr)) return fs!.range;
    const e = ctx.engine();
    const tables = e?.listTableDetails
      ? (cached("tables", () => e.listTableDetails!()) ?? [])
      : [];
    for (const tb of tables) {
      const r = tb.sheet === t.sheet ? parseA1Range(tb.range) : null;
      if (r && inside(r)) return tb.range;
    }
    if (!ext || ext.rows === 0 || ext.cols === 0) return null;
    return a1Of(0, 0, ext.rows - 1, ext.cols - 1);
  }

  function filtered(run: (e: SheetEngine, sheet: number) => unknown): Result {
    const e = ctx.engine();
    const sheet = ctx.sheet();
    if (!e || sheet === null) return { ok: false, message: "no workbook open" };
    try {
      run(e, sheet);
    } catch (err) {
      return { ok: false, message: message(err) };
    }
    dropMemo();
    ctx.edited();
    return { ok: true };
  }

  function sortRange(range: string, spec: SortSpec): Result {
    const e = ctx.engine();
    const sheet = ctx.sheet();
    if (!e?.sortRangeBy || sheet === null)
      return { ok: false, message: "this engine cannot sort by keys" };
    let res: ReturnType<NonNullable<SheetEngine["sortRangeBy"]>>;
    try {
      res = e.sortRangeBy(sheet, range, spec);
    } catch (err) {
      return { ok: false, message: message(err) };
    }
    const styles = res.styles;
    const step: DataStep | null =
      styles && e.setStyleIds
        ? {
            undo: (x) => x.setStyleIds!(sheet, styles.range, styles.before),
            redo: (x) => x.setStyleIds!(sheet, styles.range, styles.after),
          }
        : null;
    if (res.edits.length > 0 || step) ctx.journal(res.edits, step);
    dropMemo();
    ctx.repaint();
    return { ok: true };
  }

  /** The axis and span a hide or group acts on: whole columns selected →
   *  columns, else rows. */
  function axisSpan(): {
    sheet: number;
    axis: "rows" | "cols";
    first: number;
    last: number;
  } | null {
    const t = target();
    if (!t) return null;
    const wholeCols = t.top === 0 && t.bottom >= MAX_ROW;
    const wholeRows = t.left === 0 && t.right >= MAX_COL;
    if (wholeCols && !wholeRows)
      return { sheet: t.sheet, axis: "cols", first: t.left, last: t.right };
    return { sheet: t.sheet, axis: "rows", first: t.top, last: t.bottom };
  }

  const api: DataToolsApi = {
    entryAlert() {
      if (!alert) return null;
      const { style, title, message: msg } = alert;
      return { style, title, message: msg, protected: alert.protected };
    },

    answerEntryAlert(answer) {
      const a = alert;
      if (!a) return;
      alert = null;
      const sheet = ctx.sheet();
      if (a.protected || answer === "cancel" || sheet === null) {
        ctx.changedUi();
        return;
      }
      if (answer === "retry" || answer === "no") {
        ctx.reopenEdit(a.row, a.col, a.text);
        return;
      }
      if (
        (answer === "yes" && a.style === "warning") ||
        (answer === "ok" && a.style === "information")
      ) {
        enterTyped(sheet, a.row, a.col, a.text, true);
        ctx.repaint();
        return;
      }
      ctx.changedUi();
    },

    cellPrompt() {
      const e = ctx.engine();
      const sheet = ctx.sheet();
      const at = ctx.active();
      if (!e?.validationAt || sheet === null || !at) return null;
      return cached(`prompt:${sheet}:${at.row}:${at.col}`, () => {
        const v = e.validationAt!(sheet, at.row, at.col);
        if (!v) return null;
        const r = v.rule;
        const title = r.showInput ? (r.promptTitle ?? "") : "";
        const msg = r.showInput ? (r.prompt ?? "") : "";
        const items =
          r.type === "list" && r.inCellDropdown ? (v.listItems ?? []) : null;
        if (!title && !msg && !items) return null;
        return { title, message: msg, items };
      });
    },

    validationListOpen() {
      return listOpen;
    },

    openCellDropdown(open = true) {
      if (!open) {
        if (!listOpen) return false;
        listOpen = false;
        ctx.changedUi();
        return true;
      }
      const at = ctx.active();
      if (!at) return false;
      const fb = api.filterButtons();
      if (fb && at.row === fb.row && at.col >= fb.left && at.col <= fb.right)
        return api.openDataCard({ kind: "filter", col: at.col });
      if (!api.cellPrompt()?.items) return false;
      listOpen = true;
      ctx.changedUi();
      return true;
    },

    chooseListItem(text) {
      listOpen = false;
      const sheet = ctx.sheet();
      const at = ctx.active();
      if (sheet === null || !at) return ctx.changedUi();
      enterTyped(sheet, at.row, at.col, text);
      ctx.repaint();
    },

    invalidCircles() {
      if (!circlesOn) return null;
      const e = ctx.engine();
      const sheet = ctx.sheet();
      if (!e?.invalidCells || sheet === null) return [];
      return cached(`invalid:${sheet}`, () => e.invalidCells!(sheet)) ?? [];
    },

    toggleInvalidCircles(on) {
      const next = on ?? !circlesOn;
      if (next && !ctx.engine()?.invalidCells) return false;
      circlesOn = next;
      ctx.changedUi();
      ctx.repaint();
      return true;
    },

    cellProtectionAt(row, col) {
      return protectionAt(row, col);
    },

    dataCard() {
      return card;
    },

    openDataCard(next) {
      const e = ctx.engine();
      if (!e || ctx.sheet() === null) return false;
      if (next.kind === "goalSeek" && !api.canGoalSeek()) return false;
      card = next;
      listOpen = false;
      ctx.changedUi();
      return true;
    },

    closeDataCard() {
      if (!card) return;
      card = null;
      ctx.changedUi();
    },

    validationDraft() {
      const t = target();
      const e = ctx.engine();
      if (!t || !e) return null;
      const at = ctx.active() ?? { row: t.top, col: t.left };
      const rule = e.validationAt
        ? (cached(`rule:${t.sheet}:${at.row}:${at.col}`, () =>
            e.validationAt!(t.sheet, at.row, at.col),
          )?.rule ?? null)
        : null;
      return { range: a1Of(t.top, t.left, t.bottom, t.right), rule };
    },

    applyValidation(rule) {
      const t = target();
      const e = ctx.engine();
      if (!t || !e?.setValidation || !e.clearValidation)
        return { ok: false, message: "this engine cannot author validation" };
      const range = a1Of(t.top, t.left, t.bottom, t.right);
      const clearsOnly =
        (rule.type === "any" || rule.type === "none") &&
        !rule.promptTitle &&
        !rule.prompt;
      try {
        if (clearsOnly) e.clearValidation(t.sheet, range);
        else e.setValidation(t.sheet, range, rule);
      } catch (err) {
        return { ok: false, message: message(err) };
      }
      card = null;
      dropMemo();
      ctx.edited();
      return { ok: true };
    },

    clearValidationOnSelection() {
      const t = target();
      const e = ctx.engine();
      if (!t || !e?.clearValidation)
        return { ok: false, message: "this engine cannot author validation" };
      try {
        e.clearValidation(t.sheet, a1Of(t.top, t.left, t.bottom, t.right));
      } catch (err) {
        return { ok: false, message: message(err) };
      }
      dropMemo();
      ctx.edited();
      return { ok: true };
    },

    filterButtons() {
      const fs = filterState();
      const r = fs ? parseA1Range(fs.range) : null;
      if (!fs || !r) return null;
      return {
        row: r.top,
        left: r.left,
        right: r.right,
        filtered: fs.columns
          .filter((c) => c.criterion)
          .map((c) => r.left + c.col),
      };
    },

    filterValues(col) {
      const e = ctx.engine();
      const sheet = ctx.sheet();
      const fb = api.filterButtons();
      if (!e?.filterColumnValues || sheet === null || !fb) return null;
      if (col < fb.left || col > fb.right) return null;
      return cached(`fvalues:${sheet}:${col}`, () =>
        e.filterColumnValues!(sheet, col - fb.left),
      );
    },

    applyFilter(col, criterion) {
      const fs = filterState();
      const fb = api.filterButtons();
      if (!fs || !fb || col < fb.left || col > fb.right)
        return { ok: false, message: "no filter on this column" };
      const r = filtered((e, sheet) => {
        if (!e.setFilterColumn) throw new Error("this engine cannot filter");
        e.setFilterColumn(sheet, fs.range, col - fb.left, criterion);
      });
      if (r.ok) card = null;
      return r;
    },

    toggleAutofilter() {
      if (filterState()) {
        const r = filtered((e, sheet) => {
          if (!e.removeAutofilter) throw new Error("this engine cannot filter");
          e.removeAutofilter(sheet);
        });
        if (r.ok && card?.kind === "filter") card = null;
        return r;
      }
      const range = regionOfSelection();
      if (!range) return { ok: false, message: "select the data to filter" };
      return filtered((e, sheet) => {
        if (!e.setAutofilter) throw new Error("this engine cannot filter");
        e.setAutofilter(sheet, range);
      });
    },

    sortFilterColumn(col, key) {
      const fs = filterState();
      const fb = api.filterButtons();
      if (!fs || !fb) return { ok: false, message: "no filter" };
      const r = sortRange(fs.range, {
        keys: [{ ...key, index: col - fb.left }],
        hasHeader: true,
      });
      if (r.ok) {
        card = null;
        ctx.changedUi();
      }
      return r;
    },

    sortDialogInfo() {
      const range = regionOfSelection();
      const e = ctx.engine();
      const sheet = ctx.sheet();
      const r = range ? parseA1Range(range) : null;
      if (!range || !r || !e || sheet === null) return null;
      return cached(`sortinfo:${sheet}:${range}`, () => {
        const header: string[] = [];
        for (let c = r.left; c <= r.right && c - r.left < 256; c++)
          header.push(e.getCellDisplay(sheet, r.top, c));
        const below: string[] = [];
        if (r.bottom > r.top)
          for (let c = r.left; c <= r.right && c - r.left < 256; c++)
            below.push(e.getCellDisplay(sheet, r.top + 1, c));
        // A first row of labels over a row that is not all labels reads as
        // headers (what the card ticks first; the user decides).
        const numeric = (s: string) => s !== "" && !Number.isNaN(Number(s));
        const hasHeader =
          header.length > 0 &&
          header.every((h) => h !== "" && !numeric(h)) &&
          below.some((b) => numeric(b) || b === "");
        const letters = (n: number) => a1Of(0, n).replace(/\d+$/, "");
        return {
          range,
          hasHeader,
          columns: header.map((h, i) => ({
            index: i,
            label: `Column ${letters(r.left + i)}`,
            header: h,
          })),
        };
      });
    },

    sortWith(spec, range) {
      const at = range ?? api.sortDialogInfo()?.range;
      if (!at) return { ok: false, message: "select the data to sort" };
      const r = sortRange(at, spec);
      if (r.ok && card?.kind === "sort") {
        card = null;
        ctx.changedUi();
      }
      return r;
    },

    hideSelection(hidden) {
      const span = axisSpan();
      const e = ctx.engine();
      if (!span || !e?.setHidden || !e.outline)
        return { ok: false, message: "this engine cannot hide tracks" };
      const { sheet, axis, first, last } = span;
      let before: number[];
      try {
        const o = e.outline(sheet);
        before = (axis === "rows" ? o.hiddenRows : o.hiddenCols).filter(
          (i) => i >= first && i <= last,
        );
        e.setHidden(sheet, axis, first, last, hidden);
      } catch (err) {
        return { ok: false, message: message(err) };
      }
      ctx.journal([], {
        undo: (x) => {
          x.setHidden!(sheet, axis, first, last, false);
          for (const i of before) x.setHidden!(sheet, axis, i, i, true);
        },
        redo: (x) => void x.setHidden!(sheet, axis, first, last, hidden),
      });
      dropMemo();
      ctx.repaint();
      return { ok: true };
    },

    groupSelection(group) {
      const span = axisSpan();
      const e = ctx.engine();
      if (!span || !e?.group || !e.ungroup)
        return { ok: false, message: "this engine cannot group" };
      const { sheet, axis, first, last } = span;
      const run = (x: SheetEngine, on: boolean) =>
        on
          ? x.group!(sheet, axis, first, last)
          : x.ungroup!(sheet, axis, first, last);
      try {
        run(e, group);
      } catch (err) {
        return { ok: false, message: message(err) };
      }
      ctx.journal([], {
        undo: (x) => void run(x, !group),
        redo: (x) => void run(x, group),
      });
      dropMemo();
      ctx.repaint();
      return { ok: true };
    },

    canGoalSeek() {
      return typeof ctx.engine()?.goalSeek === "function";
    },

    goalSeek(setCell, targetValue, changingCell) {
      const e = ctx.engine();
      const sheet = ctx.sheet();
      if (!e?.goalSeek || sheet === null)
        return { ok: false, message: "this engine cannot Goal Seek" };
      const resolve = (text: string) => {
        if (e.resolveRange) {
          const r = e.resolveRange(sheet, text);
          return { sheet: r.sheet, row: r.top, col: r.left };
        }
        const r = parseA1Range(text);
        if (!r) throw new Error(`not a cell reference: ${text}`);
        return { sheet, row: r.top, col: r.left };
      };
      let set: { sheet: number; row: number; col: number };
      let ch: { sheet: number; row: number; col: number };
      let prev: string;
      let out: GoalSeekResult;
      try {
        set = resolve(setCell);
        ch = resolve(changingCell);
        if (!Number.isFinite(targetValue))
          throw new Error("the target must be a number");
        prev = e.getCellInput(ch.sheet, ch.row, ch.col);
        out = e.goalSeek(
          set.sheet,
          set.row,
          set.col,
          targetValue,
          ch.sheet,
          ch.row,
          ch.col,
        );
      } catch (err) {
        return { ok: false, message: message(err) };
      }
      const next = e.getCellInput(ch.sheet, ch.row, ch.col);
      if (next !== (out.prevInput ?? prev))
        ctx.journal(
          [
            {
              sheet: ch.sheet,
              row: ch.row,
              col: ch.col,
              prevInput: out.prevInput ?? prev,
              nextInput: next,
            },
          ],
          null,
        );
      dropMemo();
      ctx.repaint();
      return {
        ok: true,
        found: out.found,
        value: out.value,
        result: out.result,
        iterations: out.iterations,
      };
    },
  };

  return {
    api,
    enterTyped: (sheet, row, col, text) => enterTyped(sheet, row, col, text),
    mayEdit,
    reset() {
      alert = null;
      card = null;
      listOpen = false;
      circlesOn = false;
      dropMemo();
    },
  };
}
