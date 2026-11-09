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

// [plugin-slide.charts] The chart data sheet (slide ADR 715, ADR 724
// amendment 1), RENDERED (happy-dom): the frame around the workbook
// editor's surface (paged.sheet's grid through the workbook door,
// extensions ADR 1102). The editor's surface is mounted in the box below
// the title; Done and an Esc the grid did not take leave with the edits
// kept; full screen is asked for over a box too small for the sheet; with
// no workbook editor the surface says why. The ranges the chart reads go
// to the editor by role.

import { afterEach, describe, expect, it } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import type {
  FrameSurfaceProps,
  WorkbookEditSession,
  WorkbookEditorProps,
} from "@paged-media/plugin-api";

import { makeChartDataSurface } from "../../src/chart-data-surface";
import { rangesOf, type ChartEditProblem } from "../../src/charts";

afterEach(() => cleanup());

function editing(
  open: WorkbookEditSession | null,
  problem: ChartEditProblem | null = null,
) {
  return {
    session: () => open,
    problem: () => problem,
    subscribe: () => () => {},
  };
}

function sheetSession(seen: WorkbookEditorProps[]): WorkbookEditSession {
  function Grid(p: WorkbookEditorProps) {
    seen.push(p);
    return (
      <div data-test-grid="">
        <input
          aria-label="B2"
          onKeyDown={(e) => {
            if (e.key === "Escape") e.preventDefault();
          }}
        />
      </div>
    );
  }
  return {
    editor: "media.paged.sheet.workbookEditor",
    Surface: Grid,
    changed: () => false,
    xlsx: () => new Uint8Array(),
    onDidChange: () => ({ dispose() {} }),
    close() {},
  };
}

function props(over: Partial<FrameSurfaceProps> = {}) {
  const calls: string[] = [];
  const p: FrameSurfaceProps = {
    elementId: "u1",
    widthPt: 400,
    heightPt: 240,
    pxPerPt: 1,
    presentation: "frame",
    frameBoxPt: { widthPt: 400, heightPt: 240 },
    toContentPt: () => null,
    requestPresentation: (v) => calls.push(`present:${v}`),
    exit: (o) => calls.push(`exit:${o.commit}`),
    ...over,
  };
  return { p, calls };
}

describe("[plugin-slide.charts] the chart data sheet", () => {
  it("gives the workbook editor the ranges the chart reads, by role", () => {
    expect(
      rangesOf([
        {
          name: "Sheet1",
          rows: 3,
          cols: 2,
          cells: [],
          bound: [
            [0, 1, 0, 1],
            [1, 0, 2, 0],
            [1, 1, 2, 1],
          ],
        },
      ]).map((r) => [
        r.sheet,
        r.startRow,
        r.startCol,
        r.endRow,
        r.endCol,
        r.role,
      ]),
    ).toEqual([
      ["Sheet1", 0, 1, 0, 1, "name"],
      ["Sheet1", 1, 0, 2, 0, "category"],
      ["Sheet1", 1, 1, 2, 1, "value"],
    ]);
  });

  it("mounts the editor's surface below the title; Esc the grid took stays, Done leaves", () => {
    const seen: WorkbookEditorProps[] = [];
    const Surface = makeChartDataSurface(
      editing(sheetSession(seen)),
      () => true,
    );
    const { p, calls } = props();
    const view = render(<Surface {...p} />);
    expect(view.container.querySelector("[data-test-grid]")).not.toBeNull();
    expect(seen.at(-1)).toEqual({ width: 400, height: 216 });
    // An Esc the grid took (its cell editor) does not leave the chart.
    fireEvent.keyDown(view.getByLabelText("B2"), { key: "Escape" });
    expect(calls).toEqual([]);
    // One it did not take does, with the edits kept.
    const root = view.container.querySelector(
      "[data-slide-chart-surface]",
    ) as HTMLElement;
    fireEvent.keyDown(root, { key: "Escape" });
    expect(calls).toEqual(["exit:true"]);
    fireEvent.click(
      view.container.querySelector("[data-slide-chart-done]") as HTMLElement,
    );
    expect(calls).toEqual(["exit:true", "exit:true"]);
  });

  it("Esc in full screen goes back to the slide first", () => {
    const Surface = makeChartDataSurface(editing(sheetSession([])), () => true);
    const { p, calls } = props({ presentation: "fullscreen" });
    const view = render(<Surface {...p} />);
    fireEvent.keyDown(
      view.container.querySelector("[data-slide-chart-surface]") as HTMLElement,
      { key: "Escape" },
    );
    expect(calls).toEqual(["present:frame"]);
  });

  it("asks for full screen over a box too small for the sheet", () => {
    const Surface = makeChartDataSurface(editing(sheetSession([])), () => true);
    const { p, calls } = props({
      widthPt: 30,
      heightPt: 100,
      frameBoxPt: { widthPt: 30, heightPt: 100 },
    });
    render(<Surface {...p} />);
    expect(calls).toContain("present:fullscreen");
  });

  it("says why when no workbook editor is there", () => {
    const Surface = makeChartDataSurface(editing(null, "noEditor"), () => true);
    const { p } = props();
    const view = render(<Surface {...p} />);
    const alert = view.container.querySelector('[role="alert"]')!;
    expect(alert.getAttribute("data-slide-chart-problem")).toBe("noEditor");
    expect(alert.textContent).toContain("paged.sheet");
  });
});
