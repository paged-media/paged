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

// sheet ADR 510 / extensions ADR 334 — the sheet's frame surface as
// components: the grid windows to the cell area (the content box minus the
// heading strips), a click maps through the host's content mapping past the
// headings, a heading selects its column, typing starts an edit through the
// cell editor, Enter and Esc go to the grid's key map, F4 cycles a
// reference's dollars, and the bar shows the cell and commits the formula.

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";

import type { FrameSurfaceProps } from "@paged-media/plugin-api";

import {
  DEFAULT_HEADING_STYLE,
  rowHeadingWidthPt,
  type GridScene,
} from "../../sheet-host-model/src";
import {
  makeSheetFrameSurface,
  type FrameSurfaceSession,
} from "../src/surface/sheet-frame-surface";

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

function fakeSession() {
  const calls: Array<[string, ...unknown[]]> = [];
  let edit: {
    row: number;
    col: number;
    text: string;
    mode: "enter" | "edit";
  } | null = null;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const l of listeners) l();
  };
  let lock = false;
  const session: FrameSurfaceSession = {
    frameView: () => ({ topLeft: "A1", lock }),
    setFrameViewLock: (next) => {
      calls.push(["lock", next]);
      lock = next;
      changed();
      return true;
    },
    attachFrameSurface(sink, area) {
      calls.push(["attach", area]);
      sink(scene);
      return () => calls.push(["detach"]);
    },
    pointerDownInFrame: (x, y, m) => (calls.push(["down", x, y, m]), true),
    pointerMoveInFrame: (x, y) => (calls.push(["move", x, y]), true),
    pointerUpInFrame: (x, y) => (calls.push(["up", x, y]), true),
    wheelInFrame: (dx, dy) => (calls.push(["wheel", dx, dy]), true),
    handleGridKey: (e) => {
      calls.push(["key", e.key]);
      if (edit && (e.key === "Enter" || e.key === "Escape")) {
        edit = null;
        changed();
      }
      return true;
    },
    isCellEditing: () => edit !== null,
    cellEditState: () => edit,
    beginCellEdit: (text, mode) => {
      calls.push(["begin", text, mode]);
      edit = { row: 0, col: 0, text: text ?? "=SUM(A1)", mode };
      changed();
      return true;
    },
    setCellEditText: (text) => {
      calls.push(["text", text]);
      if (edit) edit = { ...edit, text };
      changed();
      return true;
    },
    commitCellEdit: () => (
      calls.push(["commit"]),
      (edit = null),
      changed(),
      true
    ),
    cancelCellEdit: () => {
      calls.push(["cancel"]);
      edit = null;
      changed();
    },
    onDidChange: (l) => {
      listeners.add(l as () => void);
      return { dispose: () => listeners.delete(l as () => void) };
    },
    activeCell: () => ({ row: 0, col: 0 }),
    selectCell: (r, c) => void calls.push(["select", r, c]),
    extendSelection: (r, c) => void calls.push(["extend", r, c]),
    setColumnWidth: (w) => (calls.push(["width", w]), { ok: true as const }),
    setRowHeight: (h) => (calls.push(["height", h]), { ok: true as const }),
    selectionStats: () => null,
    cellInputAt: () => "12",
    functionList: () => [
      { name: "SUM", family: "math", minArgs: 1, maxArgs: null },
    ],
    sheets: () => [{ id: 0, name: "Sheet1", rows: 3, cols: 3 }],
    state: () => ({ activeSheet: 0, gridSelection: scene.selection }) as never,
  };
  return { session, calls };
}

function props(over: Partial<FrameSurfaceProps> = {}): FrameSurfaceProps {
  return {
    elementId: "f1",
    widthPt: 300,
    heightPt: 200,
    pxPerPt: 1,
    presentation: "frame",
    frameBoxPt: { widthPt: 300, heightPt: 200 },
    // The client position IS the content point in this test.
    toContentPt: (x, y) => [x, y],
    requestPresentation: () => {},
    exit: () => {},
    ...over,
  };
}

const hw = rowHeadingWidthPt(0);
const hh = DEFAULT_HEADING_STYLE.colHeightPt;

describe("sheet frame surface", () => {
  it("windows the grid to the content box minus the heading strips", () => {
    const { session, calls } = fakeSession();
    render(createElement(makeSheetFrameSurface(session).render, props()));
    expect(calls[0]).toEqual(["attach", { wPt: 300 - hw, hPt: 200 - hh }]);
  });

  it("a click on the cells reaches the session in cell-area points", () => {
    const { session, calls } = fakeSession();
    const r = render(
      createElement(makeSheetFrameSurface(session).render, props()),
    );
    const root = r.getByTestId("sheet-frame-surface");
    fireEvent.pointerDown(root, {
      button: 0,
      clientX: hw + 10,
      clientY: hh + 5,
      shiftKey: true,
    });
    fireEvent.pointerUp(root, { button: 0, clientX: hw + 10, clientY: hh + 5 });
    expect(calls).toContainEqual(["down", 10, 5, { shift: true }]);
    expect(calls).toContainEqual(["up", 10, 5]);
  });

  it("a column heading selects its whole column; the corner selects all", () => {
    const { session, calls } = fakeSession();
    const r = render(
      createElement(makeSheetFrameSurface(session).render, props()),
    );
    const root = r.getByTestId("sheet-frame-surface");
    fireEvent.pointerDown(root, { button: 0, clientX: hw + 60, clientY: 4 });
    expect(calls).toContainEqual(["select", 0, 1]);
    expect(calls).toContainEqual(["extend", 1_048_575, 1]);
    fireEvent.pointerUp(root, { button: 0, clientX: hw + 60, clientY: 4 });
    fireEvent.pointerDown(root, { button: 0, clientX: 2, clientY: 2 });
    expect(calls).toContainEqual(["extend", 1_048_575, 16_383]);
  });

  it("dragging a column heading's border sets the column width", () => {
    const { session, calls } = fakeSession();
    const r = render(
      createElement(makeSheetFrameSurface(session).render, props()),
    );
    const root = r.getByTestId("sheet-frame-surface");
    fireEvent.pointerDown(root, { button: 0, clientX: hw + 44, clientY: 4 });
    fireEvent.pointerMove(root, { clientX: hw + 65, clientY: 4 });
    fireEvent.pointerUp(root, { button: 0, clientX: hw + 65, clientY: 4 });
    expect(calls).toContainEqual(["select", 0, 0]);
    expect(calls).toContainEqual(["width", 12.38]); // the column now ends at 65 pt: 65 / 5.25
  });

  it("typing starts an edit; Enter goes to the grid's key map; Esc then leaves the frame", () => {
    const { session, calls } = fakeSession();
    const exits: boolean[] = [];
    const r = render(
      createElement(
        makeSheetFrameSurface(session).render,
        props({ exit: ({ commit }) => exits.push(commit) }),
      ),
    );
    const editor = r.getByTestId("sheet-cell-editor") as HTMLTextAreaElement;
    fireEvent.keyDown(editor, { key: "ArrowDown" });
    expect(calls).toContainEqual(["key", "ArrowDown"]);
    editor.value = "4";
    fireEvent.input(editor);
    expect(calls).toContainEqual(["begin", "4", "enter"]);
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(calls).toContainEqual(["key", "Enter"]);
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(exits).toEqual([true]);
  });

  it("F4 cycles the reference at the caret", () => {
    const { session, calls } = fakeSession();
    const r = render(
      createElement(makeSheetFrameSurface(session).render, props()),
    );
    const editor = r.getByTestId("sheet-cell-editor") as HTMLTextAreaElement;
    act(() => {
      session.beginCellEdit("=A1", "edit");
    });
    editor.value = "=A1";
    editor.setSelectionRange(3, 3);
    fireEvent.keyDown(editor, { key: "F4" });
    expect(calls).toContainEqual(["text", "=$A$1"]);
  });

  it("the bar shows the cell and commits the formula on Enter", () => {
    const { session, calls } = fakeSession();
    const r = render(
      createElement(makeSheetFrameSurface(session).bar, props()),
    );
    expect(r.getByTestId("sheet-bar-name").textContent).toBe("A1");
    const formula = r.getByTestId("sheet-bar-formula") as HTMLInputElement;
    expect(formula.value).toBe("12");
    fireEvent.focus(formula);
    expect(calls).toContainEqual(["begin", null, "edit"]);
    formula.value = "=1+1";
    fireEvent.input(formula);
    fireEvent.keyDown(formula, { key: "Enter" });
    expect(calls).toContainEqual(["text", "=1+1"]);
    expect(calls).toContainEqual(["key", "Enter"]);
  });

  it("the bar's lock button pins the frame's view", () => {
    const { session, calls } = fakeSession();
    const r = render(
      createElement(makeSheetFrameSurface(session).bar, props()),
    );
    const lockButton = r.getByTestId("sheet-bar-lock");
    expect(lockButton.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(lockButton);
    expect(calls).toContainEqual(["lock", true]);
    expect(r.getByTestId("sheet-bar-lock").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("detaches on unmount", () => {
    const { session, calls } = fakeSession();
    const r = render(
      createElement(makeSheetFrameSurface(session).render, props()),
    );
    act(() => r.unmount());
    expect(calls.at(-1)).toEqual(["detach"]);
  });
});
