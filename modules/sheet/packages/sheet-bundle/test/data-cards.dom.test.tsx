// Sheet ADR 517 — the data tools on the frame surface, as components over a
// fake session: the entry alert's buttons per style, the Data validation
// card's rule, the active cell's input message and list dropdown.

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";

import type { FrameSurfaceProps } from "@paged-media/plugin-api";

import type { GridScene } from "../../sheet-host-model/src";
import type { DataToolsApi, EntryAlert } from "../src/data-tools";
import type { ValidationRuleArg } from "../src/engine-w2";
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
