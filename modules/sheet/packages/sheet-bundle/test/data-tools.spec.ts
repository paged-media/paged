// Sheet ADR 517 — the grid's data tools through the SESSION over the REAL
// engine: typed entry checked by validation (the three alert styles, the
// list dropdown, the input message, circle invalid data, the Data
// validation card's authoring), protection refusing locked cells and hiding
// formulas, AutoFilter on and off with its header buttons and criteria,
// the Sort card's multi-key sort as one undo step, hide / unhide and
// group / ungroup, and the key map's new keys.
//
// Real engine: skipped without the wasm artifact, FAILS under
// REQUIRE_REAL_ENGINE=1 (the engine-real.spec.ts dual gate).

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";

import {
  createWorkbookSession,
  gridKeyAction,
  type WorkbookSession,
} from "../src";
import { parseA1Range } from "../src/data-tools";

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM = join(HERE, "..", "bin", "sheet_js_bg.wasm");
const built = existsSync(WASM);

if (process.env.REQUIRE_REAL_ENGINE === "1" && !built) {
  describe("data tools (wasm artifact) — REQUIRED", () => {
    it("FAILS: REQUIRE_REAL_ENGINE=1 but the wasm artifact is missing", () => {
      throw new Error(`REQUIRE_REAL_ENGINE=1 but ${WASM} is missing`);
    });
  });
}

function fakeHost(): BundleHost {
  return {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    supports: () => false,
    contribute: {},
    document: {
      elementGeometry: async () => [{ bounds: [0, 0, 200, 400] }],
      onDidChange: () => ({ dispose() {} }),
    },
    shell: { openPanel() {} },
  } as unknown as BundleHost;
}

async function open(
  cells: [number, number, string][],
): Promise<WorkbookSession> {
  const s = createWorkbookSession(fakeHost());
  await s.newWorkbook();
  for (const [r, c, v] of cells) expect(s.editCell(0, r, c, v)).toBe(true);
  return s;
}

const input = (s: WorkbookSession, r: number, c: number) => s.cellInputAt(r, c);

/** Type `text` into `(row, col)` and press Enter, as the cell editor does. */
function typeInto(s: WorkbookSession, row: number, col: number, text: string) {
  s.selectCell(row, col);
  s.beginCellEdit(text, "enter");
  s.handleGridKey({ key: "Enter" });
}

describe("data tool keys [sheet.grid.keyboard]", () => {
  it("Ctrl+Shift+L toggles the filter (not while editing)", () => {
    expect(
      gridKeyAction({ key: "L", ctrlKey: true, shiftKey: true }, null),
    ).toEqual({ kind: "toggleFilter" });
    expect(gridKeyAction({ key: "l", ctrlKey: true }, null).kind).toBe("none");
    expect(
      gridKeyAction({ key: "L", ctrlKey: true, shiftKey: true }, "enter").kind,
    ).toBe("none");
  });

  it("Alt+Down opens the cell's dropdown", () => {
    expect(gridKeyAction({ key: "ArrowDown", altKey: true }, null)).toEqual({
      kind: "dropdown",
    });
  });

  it("reads A1 ranges", () => {
    expect(parseA1Range("B2:D10")).toEqual({
      top: 1,
      left: 1,
      bottom: 9,
      right: 3,
    });
    expect(parseA1Range("Sheet1!$C$3")).toEqual({
      top: 2,
      left: 2,
      bottom: 2,
      right: 2,
    });
    expect(parseA1Range("nope")).toBeNull();
  });
});

describe.skipIf(!built)(
  "validation on entry [sheet.validation.enforce]",
  () => {
    it("a stop rule holds the entry back; Retry reopens it, Cancel drops it", async () => {
      const s = await open([]);
      s.state().engine!.setValidation!(0, "A1:A5", {
        type: "whole",
        operator: "between",
        formula1: "1",
        formula2: "10",
        errorStyle: "stop",
        errorTitle: "Out of range",
        error: "1 to 10 only",
      });
      typeInto(s, 0, 0, "42");
      expect(input(s, 0, 0)).toBe("");
      expect(s.entryAlert()).toEqual({
        style: "stop",
        title: "Out of range",
        message: "1 to 10 only",
        protected: false,
      });
      // The selection stayed on the cell (no Enter move while held back).
      expect(s.activeCell()).toEqual({ row: 0, col: 0 });
      s.answerEntryAlert("retry");
      expect(s.entryAlert()).toBeNull();
      expect(s.cellEditState()).toMatchObject({ row: 0, col: 0, text: "42" });
      s.setCellEditText("7");
      s.handleGridKey({ key: "Enter" });
      expect(input(s, 0, 0)).toBe("7");
      expect(s.activeCell()).toEqual({ row: 1, col: 0 });
      typeInto(s, 1, 0, "0");
      s.answerEntryAlert("cancel");
      expect(s.cellEditState()).toBeNull();
      expect(input(s, 1, 0)).toBe("");
      // One undo step per accepted entry.
      expect(s.undoCellEdit()).toBe(true);
      expect(input(s, 0, 0)).toBe("");
    });

    it("warning asks Yes / No / Cancel; information OK / Cancel; circles invalid data [sheet.validation.invalid]", async () => {
      const s = await open([]);
      const e = s.state().engine!;
      e.setValidation!(0, "B1", {
        type: "whole",
        operator: "lessThan",
        formula1: "10",
        errorStyle: "warning",
      });
      e.setValidation!(0, "C1", {
        type: "textLength",
        operator: "lessThanOrEqual",
        formula1: "3",
        errorStyle: "information",
      });
      typeInto(s, 0, 1, "12");
      expect(s.entryAlert()?.style).toBe("warning");
      s.answerEntryAlert("no");
      expect(s.cellEditState()?.text).toBe("12");
      s.handleGridKey({ key: "Enter" });
      s.answerEntryAlert("yes");
      expect(input(s, 0, 1)).toBe("12");
      typeInto(s, 0, 2, "long text");
      expect(s.entryAlert()?.style).toBe("information");
      s.answerEntryAlert("ok");
      expect(input(s, 0, 2)).toBe("long text");
      // Circle invalid data finds both accepted-but-invalid cells.
      expect(s.invalidCircles()).toBeNull();
      expect(s.toggleInvalidCircles()).toBe(true);
      expect(
        s
          .invalidCircles()!
          .map((c) => [c.row, c.col])
          .sort(),
      ).toEqual([
        [0, 1],
        [0, 2],
      ]);
      s.toggleInvalidCircles(false);
      expect(s.invalidCircles()).toBeNull();
    });

    it("a list rule offers its items; choosing one enters it [sheet.validation.list]", async () => {
      const s = await open([]);
      s.state().engine!.setValidation!(0, "D1:D3", {
        type: "list",
        listItems: ["Low", "High"],
        inCellDropdown: true,
        showInput: true,
        promptTitle: "Priority",
        prompt: "Pick one",
      });
      s.selectCell(1, 3);
      expect(s.cellPrompt()).toEqual({
        title: "Priority",
        message: "Pick one",
        items: ["Low", "High"],
      });
      expect(s.handleGridKey({ key: "ArrowDown", altKey: true })).toBe(true);
      expect(s.validationListOpen()).toBe(true);
      s.chooseListItem("High");
      expect(s.validationListOpen()).toBe(false);
      expect(input(s, 1, 3)).toBe("High");
      s.selectCell(5, 5);
      expect(s.cellPrompt()).toBeNull();
      expect(s.openCellDropdown()).toBe(false);
    });

    it("the Data validation card authors and clears the selection's rule [sheet.validation.author]", async () => {
      const s = await open([]);
      s.selectCell(0, 0);
      s.extendSelection(2, 0);
      expect(s.openDataCard({ kind: "validation" })).toBe(true);
      expect(s.validationDraft()).toEqual({ range: "A1:A3", rule: null });
      expect(
        s.applyValidation({
          type: "decimal",
          operator: "greaterThan",
          formula1: "0",
          errorStyle: "stop",
          showError: true,
        }).ok,
      ).toBe(true);
      expect(s.dataCard()).toBeNull();
      const rule = s.validationDraft()!.rule!;
      expect(rule.type).toBe("decimal");
      expect(rule.sqref).toBe("A1:A3");
      typeInto(s, 1, 0, "-1");
      expect(s.entryAlert()?.style).toBe("stop");
      s.answerEntryAlert("cancel");
      s.selectCell(0, 0);
      s.extendSelection(2, 0);
      expect(s.clearValidationOnSelection().ok).toBe(true);
      expect(s.validationDraft()!.rule).toBeNull();
    });
  },
);

describe.skipIf(!built)("protection in the grid [sheet.protect.sheet]", () => {
  it("a locked cell refuses an edit with an alert; a hidden formula is flagged", async () => {
    const s = await open([[0, 0, "=1+1"]]);
    const e = s.state().engine!;
    e.setStyle!(0, "B1", { locked: false });
    e.setStyle!(0, "A1", { formulaHidden: true });
    e.protectSheet!(0, {});
    s.selectCell(0, 0);
    expect(s.beginCellEdit("x", "enter")).toBe(false);
    expect(s.entryAlert()).toMatchObject({ protected: true });
    s.answerEntryAlert("ok");
    expect(s.entryAlert()).toBeNull();
    expect(s.handleGridKey({ key: "F2" })).toBe(false);
    s.answerEntryAlert("ok");
    expect(s.cellProtectionAt(0, 0)).toEqual({
      locked: true,
      formulaHidden: true,
      sheetProtected: true,
    });
    typeInto(s, 0, 1, "free");
    expect(input(s, 0, 1)).toBe("free");
  });
});

describe.skipIf(!built)(
  "AutoFilter in the grid [sheet.filter.dropdown]",
  () => {
    const table: [number, number, string][] = [
      [0, 0, "Fruit"],
      [0, 1, "Qty"],
      [1, 0, "apple"],
      [1, 1, "3"],
      [2, 0, "pear"],
      [2, 1, "9"],
      [3, 0, "apple"],
      [3, 1, "1"],
    ];

    it("Ctrl+Shift+L filters the data around the cell; the header has buttons", async () => {
      const s = await open(table);
      s.selectCell(1, 0);
      expect(s.handleGridKey({ key: "L", ctrlKey: true, shiftKey: true })).toBe(
        true,
      );
      expect(s.filterButtons()).toEqual({
        row: 0,
        left: 0,
        right: 1,
        filtered: [],
      });
      // Alt+Down on a header cell opens its filter menu.
      s.selectCell(0, 1);
      expect(s.openCellDropdown()).toBe(true);
      expect(s.dataCard()).toEqual({ kind: "filter", col: 1 });
      s.closeDataCard();
      const v = s.filterValues(0)!;
      expect(v.items.map((i) => [i.text, i.count])).toEqual([
        ["apple", 2],
        ["pear", 1],
      ]);
      expect(s.applyFilter(0, { kind: "values", values: ["pear"] }).ok).toBe(
        true,
      );
      expect(s.filterButtons()!.filtered).toEqual([0]);
      expect(s.state().engine!.filterState!(0)!.hiddenRows).toEqual([1, 3]);
      expect(s.applyFilter(0, null).ok).toBe(true);
      expect(s.state().engine!.filterState!(0)!.hiddenRows).toEqual([]);
      expect(
        s.applyFilter(1, {
          kind: "custom",
          and: true,
          conditions: [{ op: "greaterThan", val: "2" }],
        }).ok,
      ).toBe(true);
      expect(s.state().engine!.filterState!(0)!.hiddenRows).toEqual([3]);
      // Off again: every row shows.
      s.handleGridKey({ key: "L", ctrlKey: true, shiftKey: true });
      expect(s.filterButtons()).toBeNull();
    });

    it("the menu's sort orders the filtered range under its header; one undo step", async () => {
      const s = await open(table);
      s.selectCell(0, 0);
      s.toggleAutofilter();
      expect(s.sortFilterColumn(1, { descending: true }).ok).toBe(true);
      expect([1, 2, 3].map((r) => input(s, r, 1))).toEqual(["9", "3", "1"]);
      expect(input(s, 0, 1)).toBe("Qty");
      expect(s.undoCellEdit()).toBe(true);
      expect([1, 2, 3].map((r) => input(s, r, 1))).toEqual(["3", "9", "1"]);
    });
  },
);

describe.skipIf(!built)("the Sort card's sort [sheet.sort.multikey]", () => {
  it("offers the region's columns by header and sorts by two keys as one undo step", async () => {
    const s = await open([
      [0, 0, "Team"],
      [0, 1, "Score"],
      [1, 0, "b"],
      [1, 1, "2"],
      [2, 0, "a"],
      [2, 1, "5"],
      [3, 0, "b"],
      [3, 1, "7"],
    ]);
    s.selectCell(2, 1);
    expect(s.openDataCard({ kind: "sort" })).toBe(true);
    const info = s.sortDialogInfo()!;
    expect(info.range).toBe("A1:B4");
    expect(info.hasHeader).toBe(true);
    expect(info.columns.map((c) => c.header)).toEqual(["Team", "Score"]);
    const r = s.sortWith({
      keys: [{ index: 0 }, { index: 1, descending: true }],
      hasHeader: true,
    });
    expect(r.ok).toBe(true);
    expect(s.dataCard()).toBeNull();
    expect([1, 2, 3].map((row) => input(s, row, 1))).toEqual(["5", "7", "2"]);
    expect(s.undoCellEdit()).toBe(true);
    expect([1, 2, 3].map((row) => input(s, row, 1))).toEqual(["2", "5", "7"]);
  });

  it("a refused sort answers the engine's reason", async () => {
    const s = await open([[0, 0, "x"]]);
    s.selectCell(0, 0);
    const r = s.sortWith({ keys: [{ index: 5 }] }, "A1:A3");
    expect(r.ok).toBe(false);
  });
});

describe("outline keys [sheet.outline.group]", () => {
  it("Alt+Shift+Right groups, Alt+Shift+Left ungroups", () => {
    expect(
      gridKeyAction({ key: "ArrowRight", altKey: true, shiftKey: true }, null),
    ).toEqual({ kind: "group", on: true });
    expect(
      gridKeyAction({ key: "ArrowLeft", altKey: true, shiftKey: true }, null),
    ).toEqual({ kind: "group", on: false });
  });
});

describe.skipIf(!built)(
  "hide and unhide in the grid [sheet.outline.hide]",
  () => {
    it("hides the selected rows, or whole columns; one undo step each", async () => {
      const s = await open([[0, 0, "a"]]);
      const e = s.state().engine!;
      s.selectCell(2, 0);
      s.extendSelection(3, 0);
      expect(s.hideSelection(true).ok).toBe(true);
      expect(e.outline!(0).hiddenRows).toEqual([2, 3]);
      // Whole columns selected (a column heading): the columns hide.
      s.selectCell(0, 4);
      s.extendSelection(1_048_575, 4);
      expect(s.hideSelection(true).ok).toBe(true);
      expect(e.outline!(0).hiddenCols).toEqual([4]);
      expect(s.undoCellEdit()).toBe(true);
      expect(e.outline!(0).hiddenCols).toEqual([]);
      // Unhide over a span keeps what was hidden before it on undo.
      s.selectCell(1, 0);
      s.extendSelection(4, 0);
      expect(s.hideSelection(false).ok).toBe(true);
      expect(e.outline!(0).hiddenRows).toEqual([]);
      expect(s.undoCellEdit()).toBe(true);
      expect(e.outline!(0).hiddenRows).toEqual([2, 3]);
    });
  },
);

describe.skipIf(!built)(
  "group and ungroup in the grid [sheet.outline.group]",
  () => {
    it("Alt+Shift+Right groups the selected rows; undo ungroups", async () => {
      const s = await open([[0, 0, "a"]]);
      const e = s.state().engine!;
      s.selectCell(1, 0);
      s.extendSelection(3, 0);
      expect(
        s.handleGridKey({ key: "ArrowRight", altKey: true, shiftKey: true }),
      ).toBe(true);
      expect(e.outline!(0).rows).toHaveLength(1);
      expect(e.outline!(0).maxRowLevel).toBe(1);
      expect(s.groupSelection(false).ok).toBe(true);
      expect(e.outline!(0).rows).toHaveLength(0);
      expect(s.undoCellEdit()).toBe(true);
      expect(e.outline!(0).rows).toHaveLength(1);
      expect(s.undoCellEdit()).toBe(true);
      expect(e.outline!(0).rows).toHaveLength(0);
    });
  },
);

describe.skipIf(!built)(
  "Goal Seek from the grid [sheet.whatif.goalseek]",
  () => {
    it("finds the input that makes the formula reach the target; one undo step", async () => {
      const s = await open([
        [0, 0, "2"],
        [0, 1, "=A1*A1"],
      ]);
      expect(s.canGoalSeek()).toBe(true);
      expect(s.openDataCard({ kind: "goalSeek" })).toBe(true);
      const r = s.goalSeek("B1", 49, "A1");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.found).toBe(true);
      expect(Math.abs(Number(input(s, 0, 0)) - 7)).toBeLessThan(0.01);
      expect(s.undoCellEdit()).toBe(true);
      expect(input(s, 0, 0)).toBe("2");
    });

    it("refuses a target that is not a number, or a set cell without a formula", async () => {
      const s = await open([[0, 0, "2"]]);
      expect(s.goalSeek("B1", Number.NaN, "A1").ok).toBe(false);
      expect(s.goalSeek("A1", 3, "A1").ok).toBe(false);
    });
  },
);
