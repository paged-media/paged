// sheet ADR 510, P2 — the grid scene stands on the frame window: the
// viewport lists the shown sheet rows/columns (frozen tracks first, hidden
// rows skipped), so hit-testing, the selection and the painter go through
// the index arrays, never `row - firstRow`.

import { describe, expect, it } from "bun:test";

import {
  cellEditorRect,
  cellRect,
  colPos,
  gridSceneToSvg,
  hitCell,
  paintGridScene,
  rowBand,
  rowPos,
  selectionRect,
  fillHandleRect,
  type GridScene,
  type LoweredStyle,
  type PaintContext,
} from "../src";

function style(key: number, extra: Partial<LoweredStyle> = {}): LoweredStyle {
  return {
    key,
    bold: false,
    italic: false,
    fontSizePt: null,
    fontName: null,
    fillRgb: null,
    textRgb: null,
    borderTop: false,
    borderRight: false,
    borderBottom: false,
    borderLeft: false,
    ...extra,
  };
}

// Rows 0–1 frozen, then the body from row 40 with row 41 hidden; column 0
// frozen, then the body from column 7. Columns 40 pt, rows 15 pt.
function frozenScene(): GridScene {
  return {
    viewport: {
      firstRow: 40,
      firstCol: 7,
      rows: 4,
      cols: 3,
      xOffsets: [0, 40, 80, 120],
      yOffsets: [0, 15, 30, 45, 60],
      rowIndices: [0, 1, 40, 42],
      colIndices: [0, 7, 8],
      frozenRows: 2,
      frozenCols: 1,
      partialRow: null,
      partialCol: 9,
    },
    cells: [
      { row: 0, col: 0, text: "corner", align: "left", styleKey: 0 },
      { row: 42, col: 8, text: "9", align: "right", styleKey: 1 },
      {
        row: 40,
        col: 0,
        text: "spills",
        align: "left",
        styleKey: 0,
        overflowTo: 0,
      },
      {
        row: 1,
        col: 7,
        text: "long heading",
        align: "left",
        styleKey: 0,
        overflowTo: 8,
      },
    ],
    styles: [
      style(0),
      style(1, {
        fillRgb: "#ffcc00",
        borderLines: {
          bottom: { style: "dashed", weightPt: 1.5, rgb: "#112233" },
        },
        borderBottom: true,
      }),
    ],
    gridlines: { h: [], v: [] },
    freeze: { rows: 2, cols: 1, frozenWidthPt: 40, frozenHeightPt: 30 },
    merges: [
      {
        row: 40,
        col: 7,
        rowSpan: 1,
        colSpan: 2,
        x: 40,
        y: 30,
        w: 80,
        h: 15,
        text: "Merged",
        align: "center",
        styleKey: 1,
      },
    ],
  };
}

describe("sheet_grid_window: index arrays [sheet.grid.inframe]", () => {
  it("maps sheet tracks to display positions through the arrays", () => {
    const vp = frozenScene().viewport;
    expect(rowPos(vp, 40)).toBe(2);
    expect(rowPos(vp, 41)).toBe(-1); // hidden
    expect(rowPos(vp, 5)).toBe(-1); // scrolled away
    expect(colPos(vp, 8)).toBe(2);
    expect(cellRect(vp, 42, 8)).toEqual([80, 45, 40, 15]);
    expect(rowBand(vp, 1, 41)).toEqual([1, 3]); // rows 1..41 → 1, 40
  });

  it("hitCell returns the sheet cell under the point, frozen band included", () => {
    const s = frozenScene();
    expect(hitCell(s, 10, 5)).toEqual({ row: 0, col: 0 });
    expect(hitCell(s, 100, 50)).toEqual({ row: 42, col: 8 });
    expect(hitCell(s, 10, 50)).toEqual({ row: 42, col: 0 });
    // Inside the merged area: its anchor.
    expect(hitCell(s, 110, 35)).toEqual({ row: 40, col: 7 });
    expect(cellEditorRect(s, 40, 7)).toEqual([40, 30, 80, 15]);
  });

  it("selectionRect covers the shown tracks of the selection", () => {
    const s = frozenScene();
    s.selection = { anchorRow: 40, anchorCol: 7, rows: 3, cols: 2 };
    expect(selectionRect(s)).toEqual([40, 30, 80, 30]);
    expect(fillHandleRect(s)).not.toBeNull();
    // Only scrolled-away rows: nothing shown.
    s.selection = { anchorRow: 5, anchorCol: 7, rows: 3, cols: 1 };
    expect(selectionRect(s)).toBeNull();
    // A selection whose last row is not shown has no fill handle.
    s.selection = { anchorRow: 42, anchorCol: 8, rows: 5, cols: 1 };
    expect(selectionRect(s)).toEqual([80, 45, 40, 15]);
    expect(fillHandleRect(s)).toBeNull();
  });

  it("the SVG draws cells at their display position, merges with their text, and the split", () => {
    const svg = gridSceneToSvg(frozenScene());
    expect(svg).toContain(">9</text>");
    expect(svg).toContain(">Merged</text>");
    // The merge's fill.
    expect(svg).toContain(
      '<rect x="40" y="30" width="80" height="15" fill="#ffcc00"/>',
    );
    // The split lines are drawn although the body is scrolled.
    expect(svg).toContain('y1="30" x2="120" y2="30"');
  });
});

interface Call {
  op: string;
  args: unknown[];
  strokeStyle?: unknown;
}

function recorder(): { ctx: PaintContext; calls: Call[] } {
  const calls: Call[] = [];
  const state = {
    fillStyle: "" as PaintContext["fillStyle"],
    strokeStyle: "" as PaintContext["strokeStyle"],
    lineWidth: 1,
    font: "",
    textAlign: "left" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
  };
  const rec =
    (op: string) =>
    (...args: unknown[]) =>
      calls.push({ op, args, strokeStyle: state.strokeStyle });
  const ctx = Object.assign(state, {
    save: rec("save"),
    restore: rec("restore"),
    translate: rec("translate"),
    beginPath: rec("beginPath"),
    rect: rec("rect"),
    clip: rec("clip"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    stroke: rec("stroke"),
    fillRect: rec("fillRect"),
    strokeRect: rec("strokeRect"),
    fillText: rec("fillText"),
    setLineDash: rec("setLineDash"),
    measureText: (t: string) => ({ width: t.length * 5 }),
  }) as unknown as PaintContext;
  return { ctx, calls };
}

describe("sheet_grid_paint: styles, merges, overflow, freeze [sheet.grid.inframe]", () => {
  const paint = () => {
    const { ctx, calls } = recorder();
    paintGridScene(ctx, frozenScene(), {
      headings: true,
      rowHeadingWidthPt: 30,
      widthPt: 200,
      heightPt: 100,
    });
    return calls;
  };

  it("labels the headings with the shown sheet rows and columns", () => {
    const texts = paint()
      .filter((c) => c.op === "fillText")
      .map((c) => c.args[0]);
    expect(texts).toEqual(
      expect.arrayContaining(["A", "H", "I", "1", "2", "41", "43"]),
    );
    expect(texts).not.toContain("42"); // row 41 is hidden
  });

  it("draws merges with their anchor text, fills and per-edge borders", () => {
    const calls = paint();
    expect(
      calls.some((c) => c.op === "fillText" && c.args[0] === "Merged"),
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.op === "fillRect" &&
          JSON.stringify(c.args) === JSON.stringify([40, 30, 80, 15]),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (c) => c.op === "setLineDash" && (c.args[0] as number[]).length > 0,
      ),
    ).toBe(true);
    expect(
      calls.some((c) => c.op === "stroke" && c.strokeStyle === "#112233"),
    ).toBe(true);
  });

  it("clips overflowing text to its empty neighbours, not to its cell", () => {
    const calls = paint();
    const i = calls.findIndex(
      (c) => c.op === "fillText" && c.args[0] === "long heading",
    );
    const clip = calls
      .slice(0, i)
      .reverse()
      .find((c) => c.op === "rect");
    // From column 7's left edge (40) to column 8's right edge (120).
    expect(clip?.args).toEqual([40, 15, 80, 15]);
  });

  it("draws the frozen split after the pinned tracks", () => {
    const calls = paint();
    const moves = calls.filter((c) => c.op === "moveTo").map((c) => c.args);
    expect(moves).toEqual(
      expect.arrayContaining([
        [0, 30],
        [40, 0],
      ]),
    );
  });
});
