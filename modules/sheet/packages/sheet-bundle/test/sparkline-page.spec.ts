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

// W4 — sparklines on the placed page table: the window's content carries
// each visible sparkline's primitives, and the page draws them in their
// table cells beside the data bars.

import { describe, expect, it } from "bun:test";

import type { LoweredContent } from "../../sheet-host-model/src";
import type { SheetEngine } from "../src/engine";
import { sparklineOps, withSparklines } from "../src/lower";

const content: LoweredContent = {
  cols: [
    { index: 2, widthPt: 40 },
    { index: 3, widthPt: 60 },
  ],
  rows: [
    { index: 5, heightPt: 15, cells: [] },
    { index: 6, heightPt: 20, cells: [] },
  ],
  rules: { h: [], v: [] },
  merges: [],
};

const line = {
  kind: "line",
  pts: [
    [0, 10],
    [30, 2],
  ],
  stroke: "#376092",
  strokeW: 0.75,
};

describe("sparklines on the page table [sheet.chart.sparklines]", () => {
  it("attaches the sparklines that fall in the window's cells", () => {
    const asked: [number, number, number, number][] = [];
    const engine = {
      listSparklines: () => [
        { sheet: 0, row: 6, col: 3, kind: "line", data: "A7:B7" },
        { sheet: 0, row: 40, col: 3, kind: "line", data: "A41:B41" },
      ],
      sparklineGeometry: (
        _s: number,
        row: number,
        col: number,
        w: number,
        h: number,
      ) => {
        asked.push([row, col, w, h]);
        return [line];
      },
    } as unknown as SheetEngine;
    const out = withSparklines(engine, 0, content);
    // Only the one inside the window, sized to its cell.
    expect(asked).toEqual([[6, 3, 60, 20]]);
    expect(out.sparklines).toHaveLength(1);
  });

  it("draws each sparkline at its cell's page position", () => {
    const ops = sparklineOps(
      {
        ...content,
        sparklines: [{ row: 6, col: 3, wPt: 60, hPt: 20, prims: [line] }],
      },
      { pageId: "p1" as never, origin: [100, 50], widths: [40, 60] },
      new Set(),
    );
    const path = ops.find((o) => o.op === "insertPath") as
      { args: { anchors: { anchor: [number, number] }[] } } | undefined;
    expect(path).toBeDefined();
    // Column 3 starts 40 pt in, row 6 15 pt down: the cell's page corner
    // is (90, 115), and the line's first point (0, 10) lands at (90, 125).
    expect(path!.args.anchors[0]!.anchor).toEqual([90, 125]);
    expect(ops.some((o) => o.op === "setPluginMetadata")).toBe(false);
  });
});
