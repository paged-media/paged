// Sheet ADR 517 — the data tools on the frame surface, as components over a
// fake session: the entry alert's buttons per style, the Data validation
// card's rule, the active cell's input message and list dropdown.

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";

import type { FrameSurfaceProps } from "@paged-media/plugin-api";

import type { GridScene } from "../../sheet-host-model/src";
import type { DataToolsApi, EntryAlert } from "../src/data-tools";
import type {
  FilterColumnValues,
  FilterCriterion,
  SortSpec,
  ValidationRuleArg,
} from "../src/engine-w2";
import {
  makeSheetFrameSurface,
  type FrameSurfaceSession,
} from "../src/surface/sheet-frame-surface";
import { dataToolsStub } from "./data-tools-stub";

afterEach(cleanup);

const scene: GridScene = {
  viewport: {
    firstRow: 0,
    firstCol: 0,
    rows: 3,
    cols: 3,
    xOffsets: [0, 44, 88, 132],
    yOffsets: [0, 15, 30, 45],
  },
  cells: [],
  styles: [],
  gridlines: { h: [], v: [] },
  selection: { anchorRow: 0, anchorCol: 0, rows: 1, cols: 1 },
};

/** A fake session: `data` overrides the data tools; `changed()` re-renders. */
function fakeSession(data: Partial<DataToolsApi> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const l of listeners) l();
  };
  let active = { row: 0, col: 0 };
  const session: FrameSurfaceSession = {
    ...dataToolsStub(data),
    undoCellEdit: () => (calls.push(["undo"]), true),
    pasteSpecialOpen: () => false,
    closePasteSpecial: () => {},
    pasteAtSelection: async () => ({ ok: true as const, rows: 1, cols: 1 }),
    frameView: () => null,
    setFrameViewLock: () => true,
    attachFrameSurface(sink) {
      sink(scene);
      return () => {};
    },
    pointerDownInFrame: () => true,
    pointerMoveInFrame: () => true,
    pointerUpInFrame: () => true,
    wheelInFrame: () => true,
    handleGridKey: (e) => (calls.push(["key", e.key]), true),
    isCellEditing: () => false,
    cellEditState: () => null,
    beginCellEdit: (text, mode) => (calls.push(["begin", text, mode]), true),
    setCellEditText: () => true,
    commitCellEdit: () => (calls.push(["commit"]), true),
    cancelCellEdit: () => {},
    onDidChange: (l) => {
      listeners.add(l as () => void);
      return { dispose: () => listeners.delete(l as () => void) };
    },
    activeCell: () => active,
    selectCell: (r, c) => {
      active = { row: r, col: c };
      changed();
    },
    extendSelection: () => {},
    setColumnWidth: () => ({ ok: true as const }),
    setRowHeight: () => ({ ok: true as const }),
    selectionStats: () => null,
    cellInputAt: () => "=SECRET()",
    functionList: () => [],
    sheets: () => [{ id: 0, name: "Sheet1", rows: 3, cols: 3 }],
    state: () => ({ activeSheet: 0, gridSelection: scene.selection }) as never,
    setFrameSheet: () => true,
    documentTextDefault: async () => null,
    documentFontFace: async () => null,
    documentSwatchColors: async () => new Map(),
    documentStyleRevision: () => 0,
    documentStyleChoices: async () => ({
      paragraphStyles: [{ id: "ParagraphStyle/Cells", name: "Cells" }],
      swatches: [{ id: "Color/Brand", name: "Brand", rgbHex: "#c8102e" }],
    }),
    applyDocumentSwatch: async (target, id) => {
      calls.push(["swatch", target, id]);
      return { ok: true as const };
    },
    styleAtTarget: () => null,
    grabAt: () => "cell" as const,
    setStyle: (patch) => {
      calls.push(["style", patch]);
      return { ok: true as const };
    },
  };
  return { session, calls, changed };
}

function props(over: Partial<FrameSurfaceProps> = {}): FrameSurfaceProps {
  return {
    elementId: "f1",
    widthPt: 300,
    heightPt: 200,
    pxPerPt: 1,
    presentation: "frame",
    frameBoxPt: { widthPt: 300, heightPt: 200 },
    toContentPt: (x, y) => [x, y],
    requestPresentation: () => {},
    exit: () => {},
    ...over,
  };
}

function alertSession(alert: EntryAlert) {
  let open: EntryAlert | null = alert;
  const answers: string[] = [];
  const fake = fakeSession({
    entryAlert: () => open,
    answerEntryAlert: (a) => {
      answers.push(a);
      open = null;
      fake.changed();
    },
  });
  return { ...fake, answers };
}

describe("entry alert card [sheet.validation.enforce]", () => {
  it("a stop alert offers Retry and Cancel; Esc cancels", () => {
    const { session, answers } = alertSession({
      style: "stop",
      title: "Out of range",
      message: "1 to 10 only",
      protected: false,
    });
    const r = render(
      createElement(makeSheetFrameSurface(session).bar, props()),
    );
    const card = r.getByTestId("sheet-entry-alert");
    expect(card.textContent).toContain("1 to 10 only");
    expect(r.getByTestId("sheet-entry-alert-retry")).toBeTruthy();
    expect(r.queryByTestId("sheet-entry-alert-yes")).toBeNull();
    fireEvent.keyDown(card, { key: "Escape" });
    expect(answers).toEqual(["cancel"]);
    expect(r.queryByTestId("sheet-entry-alert")).toBeNull();
  });

  it("a warning asks Continue? with Yes / No / Cancel", () => {
    const { session, answers } = alertSession({
      style: "warning",
      title: "Check",
      message: "Unusual value",
      protected: false,
    });
    const r = render(
      createElement(makeSheetFrameSurface(session).bar, props()),
    );
    expect(r.getByTestId("sheet-entry-alert").textContent).toContain(
      "Continue?",
    );
    fireEvent.click(r.getByTestId("sheet-entry-alert-no"));
    expect(answers).toEqual(["no"]);
  });

  it("a protected cell shows OK only", () => {
    const { session, answers } = alertSession({
      style: "information",
      title: "Protected cell",
      message: "protected sheet",
      protected: true,
    });
    const r = render(
      createElement(makeSheetFrameSurface(session).bar, props()),
    );
    expect(r.queryByTestId("sheet-entry-alert-cancel")).toBeNull();
    fireEvent.click(r.getByTestId("sheet-entry-alert-ok"));
    expect(answers).toEqual(["ok"]);
  });
});

describe("data validation card [sheet.validation.author]", () => {
  it("edits the selection's rule and hands it to the session", () => {
    let applied: ValidationRuleArg | null = null;
    let open = true;
    const fake = fakeSession({
      dataCard: () => (open ? { kind: "validation" } : null),
      closeDataCard: () => {
        open = false;
        fake.changed();
      },
      validationDraft: () => ({
        range: "B2:B9",
        rule: {
          index: 0,
          sqref: "B2:B9",
          type: "whole",
          operator: "between",
          formula1: "=1",
          formula2: "=10",
          allowBlank: true,
          inCellDropdown: true,
          showInput: true,
          showError: true,
          errorStyle: "stop",
        },
      }),
      applyValidation: (rule) => {
        applied = rule;
        return { ok: true };
      },
    });
    const r = render(
      createElement(makeSheetFrameSurface(fake.session).bar, props()),
    );
    const card = r.getByTestId("sheet-validation-card");
    expect(card.textContent).toContain("B2:B9");
    const f1 = r.getByTestId("sheet-validation-formula1") as HTMLInputElement;
    expect(f1.value).toBe("1");
    fireEvent.change(r.getByTestId("sheet-validation-type"), {
      target: { value: "list" },
    });
    fireEvent.change(r.getByTestId("sheet-validation-source"), {
      target: { value: "Low, High" },
    });
    fireEvent.click(r.getByRole("tab", { name: "Error alert" }));
    fireEvent.change(r.getByTestId("sheet-validation-style"), {
      target: { value: "warning" },
    });
    fireEvent.click(r.getByTestId("sheet-validation-ok"));
    expect(applied).toMatchObject({
      type: "list",
      listItems: ["Low", "High"],
      errorStyle: "warning",
      inCellDropdown: true,
    });
    expect(r.queryByTestId("sheet-validation-card")).toBeNull();
  });

  it("shows the engine's refusal and stays open", () => {
    const fake = fakeSession({
      dataCard: () => ({ kind: "validation" }),
      validationDraft: () => ({ range: "A1", rule: null }),
      applyValidation: () => ({ ok: false, message: "bad formula" }),
    });
    const r = render(
      createElement(makeSheetFrameSurface(fake.session).bar, props()),
    );
    fireEvent.change(r.getByTestId("sheet-validation-type"), {
      target: { value: "custom" },
    });
    fireEvent.click(r.getByTestId("sheet-validation-ok"));
    expect(r.getByRole("alert").textContent).toBe("bad formula");
    expect(r.getByTestId("sheet-validation-card")).toBeTruthy();
  });
});

describe("cell dropdown and input message [sheet.validation.list]", () => {
  it("shows the input message beside the active cell and the list button", () => {
    let listOpen = false;
    const chosen: string[] = [];
    const fake = fakeSession({
      cellPrompt: () => ({
        title: "Priority",
        message: "Pick one",
        items: ["Low", "High"],
      }),
      validationListOpen: () => listOpen,
      openCellDropdown: (open = true) => {
        listOpen = open;
        fake.changed();
        return true;
      },
      chooseListItem: (t) => {
        chosen.push(t);
        listOpen = false;
        fake.changed();
      },
    });
    const r = render(
      createElement(makeSheetFrameSurface(fake.session).render, props()),
    );
    expect(r.getByTestId("sheet-input-message").textContent).toBe(
      "PriorityPick one",
    );
    fireEvent.click(r.getByTestId("sheet-list-button"));
    const list = r.getByTestId("sheet-list");
    expect(
      [...list.querySelectorAll("li")].map((li) => li.textContent),
    ).toEqual(["Low", "High"]);
    // The keys walk the list; Enter chooses.
    const editor = r.getByTestId("sheet-cell-editor");
    fireEvent.keyDown(editor, { key: "ArrowDown" });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(chosen).toEqual(["High"]);
    expect(r.queryByTestId("sheet-list")).toBeNull();
  });

  it("a hidden formula on a protected sheet is not shown in the bar", () => {
    const fake = fakeSession({
      cellProtectionAt: () => ({
        locked: true,
        formulaHidden: true,
        sheetProtected: true,
      }),
    });
    const r = render(
      createElement(makeSheetFrameSurface(fake.session).bar, props()),
    );
    expect((r.getByTestId("sheet-bar-formula") as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("a refused edit leaves nothing typed in the cell editor", () => {
    const fake = fakeSession();
    fake.session.beginCellEdit = () => false;
    const r = render(
      createElement(makeSheetFrameSurface(fake.session).render, props()),
    );
    const editor = r.getByTestId("sheet-cell-editor") as HTMLTextAreaElement;
    act(() => {
      editor.value = "x";
      fireEvent.input(editor);
    });
    expect(editor.value).toBe("");
  });
});

const fruit: FilterColumnValues = {
  kind: "text",
  items: [
    { text: "apple", count: 2, selected: true },
    { text: "pear", count: 1, selected: true },
  ],
  dates: [],
  blanks: 1,
  blanksSelected: true,
  fillColors: [],
  fontColors: [],
  criterion: null,
};

function filterSession() {
  let open: { kind: "filter"; col: number } | null = null;
  const applied: [number, FilterCriterion | null][] = [];
  const sorted: unknown[] = [];
  const fake = fakeSession({
    filterButtons: () => ({ row: 0, left: 0, right: 1, filtered: [1] }),
    dataCard: () => open,
    openDataCard: (c) => {
      open = c as typeof open;
      fake.changed();
      return true;
    },
    closeDataCard: () => {
      open = null;
      fake.changed();
    },
    filterValues: () => fruit,
    applyFilter: (col, criterion) => {
      applied.push([col, criterion]);
      open = null;
      fake.changed();
      return { ok: true };
    },
    sortFilterColumn: (col, key) => {
      sorted.push([col, key]);
      open = null;
      fake.changed();
      return { ok: true };
    },
  });
  return { ...fake, applied, sorted };
}

describe("AutoFilter buttons and menu [sheet.filter.dropdown]", () => {
  it("draws a button on each header cell; a filtered column shows the funnel", () => {
    const { session } = filterSession();
    const r = render(
      createElement(makeSheetFrameSurface(session).render, props()),
    );
    const buttons = r.getAllByTestId("sheet-filter-button");
    expect(buttons.map((b) => b.getAttribute("data-col"))).toEqual(["0", "1"]);
    expect(buttons[1]!.getAttribute("aria-label")).toContain("Filtered");
  });

  it("a header button opens the menu under the bar; unticking filters by value", () => {
    const fake = filterSession();
    const surface = makeSheetFrameSurface(fake.session);
    const grid = render(createElement(surface.render, props()));
    const bar = render(createElement(surface.bar, props()));
    act(() => {
      fireEvent.click(grid.getAllByTestId("sheet-filter-button")[0]!);
    });
    const menu = bar.getByTestId("sheet-filter-menu");
    expect(menu.textContent).toContain("Sort A to Z");
    const items = bar.getAllByTestId("sheet-filter-item");
    expect(items).toHaveLength(2);
    fireEvent.click(items[0]!); // untick apple
    fireEvent.click(bar.getByTestId("sheet-filter-ok"));
    expect(fake.applied).toEqual([
      [0, { kind: "values", values: ["pear"], blanks: true }],
    ]);
  });

  it("everything ticked clears the column; search narrows the list", () => {
    const fake = filterSession();
    fake.session.openDataCard({ kind: "filter", col: 0 });
    const bar = render(
      createElement(makeSheetFrameSurface(fake.session).bar, props()),
    );
    fireEvent.change(bar.getByTestId("sheet-filter-search"), {
      target: { value: "pe" },
    });
    expect(bar.getAllByTestId("sheet-filter-item")).toHaveLength(1);
    fireEvent.change(bar.getByTestId("sheet-filter-search"), {
      target: { value: "" },
    });
    fireEvent.click(bar.getByTestId("sheet-filter-ok"));
    expect(fake.applied).toEqual([[0, null]]);
  });

  it("Text Filters ▸ Begins with… writes Excel's wildcard condition", () => {
    const fake = filterSession();
    fake.session.openDataCard({ kind: "filter", col: 0 });
    const bar = render(
      createElement(makeSheetFrameSurface(fake.session).bar, props()),
    );
    fireEvent.click(bar.getByTestId("sheet-filter-conditions"));
    fireEvent.click(bar.getByText("Begins with…"));
    fireEvent.change(bar.getByTestId("sheet-filter-value1"), {
      target: { value: "ap" },
    });
    fireEvent.click(bar.getByTestId("sheet-filter-custom-ok"));
    expect(fake.applied).toEqual([
      [
        0,
        {
          kind: "custom",
          and: true,
          conditions: [{ op: "equal", val: "ap*" }],
        },
      ],
    ]);
  });

  it("the menu's sort hands the column to the session", () => {
    const fake = filterSession();
    fake.session.openDataCard({ kind: "filter", col: 1 });
    const bar = render(
      createElement(makeSheetFrameSurface(fake.session).bar, props()),
    );
    fireEvent.click(bar.getByTestId("sheet-filter-sort-desc"));
    expect(fake.sorted).toEqual([[1, { descending: true }]]);
    expect(bar.queryByTestId("sheet-filter-menu")).toBeNull();
  });
});

describe("Sort card [sheet.sort.multikey]", () => {
  it("builds levels by header and hands the keys to the session", () => {
    let open = true;
    const sorts: [SortSpec, string | undefined][] = [];
    const fake = fakeSession({
      dataCard: () => (open ? { kind: "sort" } : null),
      closeDataCard: () => {
        open = false;
        fake.changed();
      },
      sortDialogInfo: () => ({
        range: "A1:C9",
        hasHeader: true,
        columns: [
          { index: 0, label: "Column A", header: "Team" },
          { index: 1, label: "Column B", header: "Score" },
          { index: 2, label: "Column C", header: "Rank" },
        ],
      }),
      sortWith: (spec, range) => {
        sorts.push([spec, range]);
        return { ok: true };
      },
    });
    const r = render(
      createElement(makeSheetFrameSurface(fake.session).bar, props()),
    );
    const keys = () =>
      r.getAllByTestId("sheet-sort-key") as HTMLSelectElement[];
    expect([...keys()[0]!.options].map((o) => o.textContent)).toEqual([
      "Team",
      "Score",
      "Rank",
    ]);
    fireEvent.click(r.getByTestId("sheet-sort-add"));
    expect(keys()).toHaveLength(2);
    fireEvent.change(keys()[1]!, { target: { value: "1" } });
    const orders = r.getAllByTestId("sheet-sort-order");
    fireEvent.change(orders[1]!, { target: { value: "desc" } });
    fireEvent.change(orders[0]!, { target: { value: "custom" } });
    fireEvent.change(r.getByTestId("sheet-sort-custom-list"), {
      target: { value: "Low, High" },
    });
    // Unticking headers labels the columns by letter.
    fireEvent.click(r.getByTestId("sheet-sort-header"));
    expect(keys()[0]!.options[0]!.textContent).toBe("Column A");
    fireEvent.click(r.getByTestId("sheet-sort-ok"));
    expect(sorts).toEqual([
      [
        {
          keys: [
            { index: 0, descending: false, customList: ["Low", "High"] },
            { index: 1, descending: true },
          ],
          hasHeader: false,
          leftToRight: false,
          caseSensitive: false,
        },
        "A1:C9",
      ],
    ]);
    expect(r.queryByTestId("sheet-sort-card")).toBeNull();
  });
});

describe("Goal Seek card [sheet.whatif.goalseek]", () => {
  it("takes typed references or a click in the grid, then reports the result", () => {
    let open = true;
    const seeks: [string, number, string][] = [];
    const fake = fakeSession({
      dataCard: () => (open ? { kind: "goalSeek" } : null),
      closeDataCard: () => {
        open = false;
        fake.changed();
      },
      goalSeek: (set, target, changing) => {
        seeks.push([set, target, changing]);
        return { ok: true, found: true, value: 7, result: 49, iterations: 4 };
      },
    });
    const r = render(
      createElement(makeSheetFrameSurface(fake.session).bar, props()),
    );
    const set = r.getByTestId("sheet-goal-seek-set") as HTMLInputElement;
    expect(set.value).toBe("A1"); // the active cell
    fireEvent.change(set, { target: { value: "B1" } });
    fireEvent.change(r.getByTestId("sheet-goal-seek-target"), {
      target: { value: "49" },
    });
    // Focus the changing cell, then click C3 in the grid.
    const changing = r.getByTestId(
      "sheet-goal-seek-changing",
    ) as HTMLInputElement;
    fireEvent.focus(changing);
    act(() => fake.session.selectCell(2, 2));
    expect(changing.value).toBe("C3");
    fireEvent.click(r.getByTestId("sheet-goal-seek-ok"));
    expect(seeks).toEqual([["B1", 49, "C3"]]);
    expect(r.getByTestId("sheet-goal-seek-current").textContent).toContain(
      "49",
    );
    // Cancel on the status takes the change back.
    fireEvent.keyDown(r.getByTestId("sheet-goal-seek-status"), {
      key: "Escape",
    });
    expect(fake.calls).toContainEqual(["undo"]);
    expect(r.queryByTestId("sheet-goal-seek-status")).toBeNull();
  });
});
