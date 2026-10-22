// sheet.edit.typed-entry: what a person types is stored the way Excel
// stores it (`45%` → 0.45 with the `0%` format), and the value and the
// format it implied are ONE undo step. The typing rules themselves live in
// Rust (sheet_format::entry, pinned by the Excel oracle's entry lane); this
// pins the journal contract — with a stateful fake that reports a restyle,
// and end-to-end against the real engine when its wasm artifact is built.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";

import { createWorkbookSession, type SheetEngine } from "../src";
import { bootEmptyEngine } from "../src/engine";
import { stubFrameWindow } from "./frame-window-stub";

const HERE = dirname(fileURLToPath(import.meta.url));
const built = existsSync(join(HERE, "..", "bin", "sheet_js_bg.wasm"));

const silentHost = {
  log: { debug() {}, info() {}, warn() {}, error() {} },
  document: {
    onDidChange: () => ({ dispose() {} }),
    onDidOpen: () => ({ dispose() {} }),
  },
  supports: () => false,
} as unknown as BundleHost;

/** A fake whose cells hold an input AND a style id; typing a `%` into a
 *  style-0 cell moves it to style 7 (the engine's restyle report), and the
 *  calls are logged so the undo ORDER is visible. */
function restylingEngine() {
  const inputs = new Map<string, string>();
  const styles = new Map<string, number>();
  const log: string[] = [];
  const key = (s: number, r: number, c: number) => `${s}:${r}:${c}`;
  const write = (sheet: number, row: number, col: number, input: string) => {
    const k = key(sheet, row, col);
    const prev = inputs.get(k) ?? "";
    inputs.set(k, input);
    log.push(`write ${input}`);
    const before = styles.get(k) ?? 0;
    if (input.endsWith("%") && before === 0) {
      styles.set(k, 7);
      return { prev, restyled: [{ sheet, row, col, before, after: 7 }] };
    }
    return { prev, restyled: [] };
  };
  const engine = {
    loadXlsx() {},
    saveXlsx: () => new Uint8Array(),
    setCell: (sheet: number, row: number, col: number, input: string) => {
      const { restyled } = write(sheet, row, col, input);
      return { changed: [{ sheet, row, col, display: input }], restyled };
    },
    setCells: (
      batch: readonly {
        sheet: number;
        row: number;
        col: number;
        input: string;
      }[],
    ) => {
      const prevInputs: string[] = [];
      const restyled = [];
      for (const c of batch) {
        const w = write(c.sheet, c.row, c.col, c.input);
        prevInputs.push(w.prev);
        restyled.push(...w.restyled);
      }
      return {
        changedCount: batch.length,
        circular: [],
        prevInputs,
        restyled,
      };
    },
    getStyleIds: (_sheet: number, range: string) => [
      styles.get(`0:${Number(range.slice(1)) - 1}:0`) ?? 0,
    ],
    setStyleIds: (_sheet: number, range: string, ids: readonly number[]) => {
      styles.set(`0:${Number(range.slice(1)) - 1}:0`, ids[0]);
      log.push(`style ${range}=${ids[0]}`);
    },
    getCellDisplay: (s: number, r: number, c: number) =>
      inputs.get(key(s, r, c)) ?? "",
    getCellInput: (s: number, r: number, c: number) =>
      inputs.get(key(s, r, c)) ?? "",
    sortRange: () => ({ changed: [], edits: [] }),
    findAll: () => [],
    replaceAll: () => ({ occurrences: 0, changed: [], edits: [], skipped: [] }),
    getRangeLowered: () => ({
      cols: [],
      rows: [],
      rules: { h: [], v: [] },
      merges: [],
    }),
    getRangeStyled: () => ({
      cols: [],
      rows: [],
      rules: { h: [], v: [] },
      merges: [],
    }),
    getRangeValues: () => [],
    paginate: () => [],
    getFrameWindow: stubFrameWindow,
    getGridScene: () => ({
      viewport: {
        firstRow: 0,
        firstCol: 0,
        rows: 1,
        cols: 1,
        xOffsets: [0, 40],
        yOffsets: [0, 20],
      },
      cells: [],
      styles: [],
      gridlines: { h: [], v: [] },
      selection: null,
    }),
    setGridSelection() {},
    listSheets: () => [{ id: 0, name: "Sheet1", rows: 9, cols: 9 }],
    listCharts: () => [],
    chartKinds: () => ["column"],
    addChart: () => 0,
    listFreezePanes: () => [],
    listDataValidations: () => [],
    listComments: () => [],
    listFunctions: () => [],
    getChartGeometry: () => ({ widthPt: 0, heightPt: 0, prims: [] }),
    dispose() {},
  } as unknown as SheetEngine;
  return { engine, inputs, styles, log };
}

function booted(engine: SheetEngine) {
  const session = createWorkbookSession(silentHost);
  const st = session.state();
  st.engine = engine;
  st.activeSheet = 0;
  st.fileName = "demo.xlsx";
  return session;
}

describe("sheet_edit_typed_entry: value + implied format are one undo step", () => {
  it("one Cmd-Z restores the input and the style; redo re-applies both", () => {
    const { engine, inputs, styles, log } = restylingEngine();
    const session = booted(engine);
    expect(session.editCell(0, 0, 0, "45%")).toBe(true);
    expect(styles.get("0:0:0")).toBe(7);

    log.length = 0;
    expect(session.undoCellEdit()).toBe(true);
    expect(inputs.get("0:0:0")).toBe("");
    expect(styles.get("0:0:0")).toBe(0);
    // The prior input is re-typed FIRST, then the prior style is put back.
    expect(log).toEqual(["write ", "style A1=0"]);
    expect(session.canUndoCellEdit()).toBe(false); // ONE step, not two

    log.length = 0;
    expect(session.redoCellEdit()).toBe(true);
    expect(inputs.get("0:0:0")).toBe("45%");
    expect(styles.get("0:0:0")).toBe(7);
    expect(log).toEqual(["write 45%", "style A1=7"]);
  });

  it("an entry that restyles nothing journals a plain cell step", () => {
    const { engine, styles } = restylingEngine();
    const session = booted(engine);
    session.editCell(0, 0, 0, "12");
    expect(styles.get("0:0:0")).toBeUndefined();
    expect(session.undoCellEdit()).toBe(true);
    expect(session.canUndoCellEdit()).toBe(false);
  });
});

describe.skipIf(!built)("sheet_edit_typed_entry: the real engine", () => {
  it("45% stores 0.45 as 0%, a date its serial; undo puts General back", async () => {
    const engine = await bootEmptyEngine();
    const session = booted(engine);
    expect(session.editCell(0, 0, 0, "45%")).toBe(true);
    expect(engine.getCellInput(0, 0, 0)).toBe("0.45");
    expect(engine.getCellDisplay(0, 0, 0)).toBe("45%");
    expect(engine.getStyle!(0, 0, 0).numFmt).toBe("0%");

    expect(session.editCell(0, 1, 0, "2024-01-15")).toBe(true);
    expect(engine.getCellInput(0, 1, 0)).toBe("45306");
    expect(engine.getStyle!(0, 1, 0).numFmt).toBe("m/d/yy");

    expect(session.editCell(0, 2, 0, "'1/2")).toBe(true);
    expect(engine.getCellDisplay(0, 2, 0)).toBe("1/2");
    expect(engine.getCellInput(0, 2, 0)).toBe("'1/2");
    expect(engine.getStyle!(0, 2, 0).quotePrefix).toBe(true);

    expect(session.undoCellEdit()).toBe(true);
    expect(session.undoCellEdit()).toBe(true);
    expect(session.undoCellEdit()).toBe(true);
    expect(engine.getCellInput(0, 0, 0)).toBe("");
    expect(engine.getStyle!(0, 0, 0).numFmt).toBe("General");
    expect(engine.getStyle!(0, 1, 0).numFmt).toBe("General");

    expect(session.redoCellEdit()).toBe(true);
    expect(engine.getCellDisplay(0, 0, 0)).toBe("45%");
    expect(engine.getStyle!(0, 0, 0).numFmt).toBe("0%");
    engine.dispose();
  });
});
