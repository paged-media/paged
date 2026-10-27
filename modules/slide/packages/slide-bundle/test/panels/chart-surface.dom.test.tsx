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

// [plugin-slide.charts] The chart data sheet (slide ADR 715), RENDERED
// (happy-dom): the workbook's cells under column letters and row numbers,
// the cells the chart reads tinted, typing into a cell enters it, Escape
// throws the typing away, Done leaves with the edits kept, and a surface
// over a box too small for the sheet asks for full screen.

import { afterEach, describe, expect, it } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";
import * as React from "react";

import type { FrameSurfaceProps } from "@paged-media/plugin-api";

import {
  boundTint,
  columnName,
  makeChartSurface,
  type ChartEditSession,
  type GridSheet,
} from "../../src/chart-surface";

afterEach(() => cleanup());

function session(): ChartEditSession & { entered: string[][] } {
  let sheets: GridSheet[] = [
    {
      name: "Sheet1",
      rows: 3,
      cols: 2,
      cells: [
        { row: 0, col: 1, text: "North", input: "North" },
        { row: 1, col: 0, text: "Q1", input: "Q1" },
        { row: 1, col: 1, text: "4.3", input: "4.3" },
      ],
      bound: [
        [0, 1, 0, 1],
        [1, 0, 2, 0],
        [1, 1, 2, 1],
      ],
    },
  ];
  const listeners = new Set<() => void>();
  const entered: string[][] = [];
  return {
    entered,
    grid: () => sheets,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    enter(sheet, row, col, input) {
      if (input === "=bad(") return false;
      entered.push([sheet, String(row), String(col), input]);
      const s = sheets[0]!;
      sheets = [
        {
          ...s,
          cells: [
            ...s.cells.filter((c) => c.row !== row || c.col !== col),
            { row, col, text: input, input },
          ],
        },
      ];
      for (const l of listeners) l();
      return true;
    },
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
  it("names columns as Excel does and tints what the chart reads", () => {
    expect([0, 25, 26, 27].map(columnName)).toEqual(["A", "Z", "AA", "AB"]);
    const s = session().grid()![0]!;
    expect(boundTint(s, 0, 1)).toContain("220, 60, 60");
    expect(boundTint(s, 1, 0)).toContain("140, 80, 200");
    expect(boundTint(s, 2, 1)).toContain("50, 110, 220");
    expect(boundTint(s, 0, 0)).toBeNull();
  });

  it("types into a cell, Escape drops the typing, Done keeps the edits", () => {
    const sess = session();
    const Surface = makeChartSurface(sess, () => true);
    const { p, calls } = props();
    const view = render(<Surface {...p} />);
    const cell = (a: string) =>
      view.container.querySelector(`[data-cell="${a}"]`) as HTMLElement;
    expect(cell("B1").textContent).toBe("North");
    const root = view.container.querySelector(
      "[data-slide-chart-surface]",
    ) as HTMLElement;
    fireEvent.pointerDown(cell("B2"));
    fireEvent.keyDown(root, { key: "9" });
    const input = view.container.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "9.25" } });
    fireEvent.keyDown(root, { key: "Enter" });
    expect(sess.entered).toEqual([["Sheet1", "1", "1", "9.25"]]);
    expect(cell("B2").textContent).toBe("9.25");
    // Escape mid-edit drops the typing.
    fireEvent.keyDown(root, { key: "7" });
    fireEvent.keyDown(root, { key: "Escape" });
    expect(sess.entered.length).toBe(1);
    // A refused entry stays open and says so.
    fireEvent.keyDown(root, { key: "=" });
    fireEvent.change(view.container.querySelector("input")!, {
      target: { value: "=bad(" },
    });
    fireEvent.keyDown(root, { key: "Enter" });
    expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
    fireEvent.click(
      view.container.querySelector("[data-slide-chart-done]") as HTMLElement,
    );
    expect(calls).toContain("exit:true");
  });

  it("asks for full screen over a box too small for the sheet", () => {
    const Surface = makeChartSurface(session(), () => true);
    const { p, calls } = props({
      widthPt: 30,
      heightPt: 100,
      frameBoxPt: { widthPt: 30, heightPt: 100 },
    });
    render(<Surface {...p} />);
    expect(calls).toContain("present:fullscreen");
  });
});
