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

// sheet.grid.panel-edit-contract: the Grid panel's cells are readable in
// every editor theme (happy-dom, `bun run test:dom`).
//
// The scene carries the workbook's own colours (sheet ADR 510, ADR 518). An
// Excel workbook's default font is "Text 1", so the engine gives every body
// cell a stored #000000; a styled header has its own fill and white text; a
// Total row in a plain bold font has no colour and takes the panel's ink.
// The panel drew all of it on the editor's dark --pg-bg, and the body cells
// could not be read. The grid surface is paper (--paper-*): every cell's
// text is checked against the ground it is drawn on (its own fill, else the
// surface) with the colours resolved from the editor's theme.css, in the
// light and dark themes and their high-contrast variants.

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";

import type { BundleHost } from "@paged-media/plugin-api";
import type { GridScene } from "@paged-media/sheet-host-model";

import { stubFrameWindow } from "./frame-window-stub";
import { createWorkbookSession, makeGridPanel, type SheetEngine } from "../src";

import { fakeBundleHost } from "./fake-host";
// ── the editor's theme, from its one token file (editor ADR 210) ─────────

const css = readFileSync(
  new URL(
    "../../../../../apps/editor/packages/shell/src/styles/theme.css",
    import.meta.url,
  ),
  "utf8",
);

/** A block's custom properties, by the exact text that opens it. */
function block(head: string): Map<string, string> {
  const at = css.indexOf(head);
  if (at < 0) throw new Error(`no ${head} block in theme.css`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("\n}", open);
  const body = css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
    out.set(m[1]!, m[2]!.replace(/\s+/g, " ").trim());
  return out;
}

const light = block(":root,");
const dark = new Map([...light, ...block(".dark {")]);
const THEMES: Record<string, Map<string, string>> = {
  light,
  dark,
  "high-contrast light": new Map([
    ...light,
    ...block('[data-paged-editor][data-contrast="more"]:not(.dark) {'),
  ]),
  "high-contrast dark": new Map([
    ...dark,
    ...block('[data-paged-editor].dark[data-contrast="more"] {'),
  ]),
};

type Rgb = [number, number, number];

function hsl(h: number, s: number, l: number): Rgb {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** A CSS colour as the theme resolves it: `var(--token, fallback)`, hex or
 *  `hsl(h s% l%)`. */
function resolve(tokens: Map<string, string>, value: string, depth = 0): Rgb {
  const v = value.trim();
  if (depth > 8) throw new Error(`${value}: too deep`);
  const ref = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(v);
  if (ref) {
    const token = tokens.get(ref[1]!);
    if (token !== undefined) return resolve(tokens, token, depth + 1);
    if (ref[2] !== undefined) return resolve(tokens, ref[2], depth + 1);
    throw new Error(`${ref[1]} is not a theme token`);
  }
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m)
    return [0, 2, 4].map((i) => parseInt(m![1]!.slice(i, i + 2), 16)) as Rgb;
  m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return [...m[1]!].map((c) => parseInt(c + c, 16)) as Rgb;
  m = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/.exec(v);
  if (m) return hsl(Number(m[1]), Number(m[2]), Number(m[3]));
  throw new Error(`cannot read the colour "${value}"`);
}

const luminance = (c: Rgb) => {
  const [r, g, b] = c.map((x) => {
    const v = x / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Number(((hi! + 0.05) / (lo! + 0.05)).toFixed(2));
}

// ── a price list, shaped as the engine windows it ───────────────────────

const ROWS = [
  ["Item", "Qty", "Price", "Amount"],
  ["Notebooks", "40", "3.50", "140.00"],
  ["Pencils", "120", "0.80", "96.00"],
  ["Erasers", "60", "1.20", "72.00"],
  ["Total", "", "", "532.00"],
];
const HEADER = 1;
const BODY = 2; // the workbook's default font: "Text 1", stored #000000
const TOTAL = 3; // bold, no colour of its own

function priceList(): GridScene {
  const style = (key: number, over: object = {}) => ({
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
    ...over,
  });
  const xs = [0, 64, 104, 144, 194];
  const ys = ROWS.map((_, i) => i * 15).concat(ROWS.length * 15);
  return {
    viewport: {
      firstRow: 0,
      firstCol: 0,
      rows: ROWS.length,
      cols: 4,
      xOffsets: xs,
      yOffsets: ys,
    },
    cells: ROWS.flatMap((cols, row) =>
      cols.flatMap((text, col) =>
        text
          ? [
              {
                row,
                col,
                text,
                align: col === 0 ? ("left" as const) : ("right" as const),
                styleKey:
                  row === 0 ? HEADER : row === ROWS.length - 1 ? TOTAL : BODY,
              },
            ]
          : [],
      ),
    ),
    styles: [
      style(0),
      style(HEADER, { bold: true, fillRgb: "#2A2140", textRgb: "#FFFFFF" }),
      style(BODY, { textRgb: "#000000" }),
      style(TOTAL, { bold: true }),
    ],
    gridlines: {
      h: ys.map((at) => ({ at, from: 0, to: 194 })),
      v: xs.map((at) => ({ at, from: 0, to: ys.at(-1)! })),
    },
    selection: null,
  };
}

function fakeEngine(): SheetEngine {
  return {
    loadXlsx() {},
    saveXlsx: () => new Uint8Array(),
    setCell: (sheet, row, col, input) => ({
      changed: [{ sheet, row, col, display: input }],
    }),
    getCellDisplay: () => "",
    getCellInput: (_sheet, row, col) => ROWS[row]?.[col] ?? "",
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
    getGridScene: () => priceList(),
    setGridSelection() {},
    listSheets: () => [{ id: 0, name: "Prices", rows: 5, cols: 4 }],
    listCharts: () => [],
    chartKinds: () => ["column"],
    addChart: () => 0,
    listFreezePanes: () => [],
    listDataValidations: () => [],
    listComments: () => [],
    listFunctions: () => [],
    getChartGeometry: () => ({ widthPt: 0, heightPt: 0, prims: [] }),
    dispose() {},
  };
}

function fakeHost(): BundleHost {
  return fakeBundleHost({
    log: { debug() {}, info() {}, warn() {}, error() {} },
    supports: () => false,
    document: {
      onDidChange: () => ({ dispose() {} }),
      onDidOpen: () => ({ dispose() {} }),
    },
  });
}

/** The Grid panel over a loaded session, a body cell selected. */
function mount(): HTMLElement {
  const host = fakeHost();
  const session = createWorkbookSession(host);
  const st = session.state();
  st.engine = fakeEngine();
  st.activeSheet = 0;
  st.fileName = "prices.xlsx";
  st.gridSelection = { anchorRow: 1, anchorCol: 0, rows: 1, cols: 1 };
  const Panel = makeGridPanel(host, session);
  return render(createElement(Panel)).container;
}

const q = (root: ParentNode, sel: string) => {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`no ${sel} in the panel`);
  return el as HTMLElement;
};

/** An inline style's declared value (as React wrote it). */
function declared(el: HTMLElement, prop: string): string {
  const v = el.style.getPropertyValue(prop);
  if (!v) throw new Error(`no ${prop} on ${el.outerHTML.slice(0, 80)}`);
  return v;
}

const num = (el: Element, attr: string) => Number(el.getAttribute(attr));

/** Each cell's text with the colour it is drawn in and the ground under
 *  it: the cell's own fill rect, else the grid surface. */
function drawnTexts(root: HTMLElement) {
  const surface = q(root, "[data-grid-surface]");
  const svg = q(root, "[data-grid-svg-root]");
  // Cell fills are the rects without a stroke (the selection has one).
  const fills = [...svg.querySelectorAll("rect")].filter(
    (r) => !r.hasAttribute("stroke") && r.getAttribute("fill") !== "none",
  );
  return [...svg.querySelectorAll("text")].map((t) => {
    const x = num(t, "x");
    const y = num(t, "y");
    const under = fills.find(
      (r) =>
        x >= num(r, "x") &&
        x <= num(r, "x") + num(r, "width") &&
        y >= num(r, "y") &&
        y <= num(r, "y") + num(r, "height"),
    );
    return {
      text: t.textContent ?? "",
      ink: t.getAttribute("fill") ?? "",
      ground: under?.getAttribute("fill") ?? declared(surface, "background"),
    };
  });
}

afterEach(() => cleanup());

describe("sheet_grid_panel_edit_contract: the cells are readable in every theme", () => {
  it("draws every cell's text at 4.5:1 or more on its ground, light and dark", () => {
    const root = mount();
    const texts = drawnTexts(root);
    expect(texts.map((t) => t.text)).toContain("Notebooks");
    for (const [theme, tokens] of Object.entries(THEMES)) {
      const below = texts
        .map((t) => ({
          theme,
          text: t.text,
          ratio: contrast(resolve(tokens, t.ink), resolve(tokens, t.ground)),
        }))
        .filter((r) => r.ratio < 4.5);
      expect(below).toEqual([]);
    }
  });

  it("is paper: the ground, and the ink of text without a colour of its own, are the paper's in every theme", () => {
    const root = mount();
    const ground = declared(q(root, "[data-grid-surface]"), "background");
    const total = drawnTexts(root).find((t) => t.text === "Total")!;
    for (const tokens of Object.values(THEMES)) {
      expect(resolve(tokens, ground)).toEqual(resolve(tokens, "var(--paper)"));
      expect(resolve(tokens, total.ink)).toEqual(
        resolve(tokens, "var(--paper-fg)"),
      );
    }
    // The workbook's stored colours still win: the header's white on its
    // fill, the body's Text 1.
    const byText = new Map(drawnTexts(root).map((t) => [t.text, t]));
    expect(byText.get("Item")!.ink).toBe("#FFFFFF");
    expect(byText.get("Item")!.ground).toBe("#2A2140");
    expect(byText.get("Notebooks")!.ink).toBe("#000000");
  });

  it("draws gridlines and the selection with the paper's tokens, the selection at 3:1 or more", () => {
    const root = mount();
    const svg = q(root, "[data-grid-svg-root]");
    const ground = declared(q(root, "[data-grid-surface]"), "background");
    const lines = [...svg.querySelectorAll("line")];
    expect(lines.length).toBeGreaterThan(0);
    const selection = [...svg.querySelectorAll("rect")].find(
      (r) => r.hasAttribute("stroke") && !r.hasAttribute("data-fill-preview"),
    )!;
    expect(selection).toBeDefined();
    for (const tokens of Object.values(THEMES)) {
      for (const l of lines)
        expect(resolve(tokens, l.getAttribute("stroke")!)).toEqual(
          resolve(tokens, "var(--paper-rule)"),
        );
      const outline = resolve(tokens, selection.getAttribute("stroke")!);
      expect(outline).toEqual(resolve(tokens, "var(--paper-selection)"));
      expect(contrast(outline, resolve(tokens, ground))).toBeGreaterThanOrEqual(
        3,
      );
    }
  });

  it("opens the cell editor on the paper, its text at 4.5:1 or more", () => {
    const root = mount();
    const svg = q(root, "[data-grid-svg-root]");
    act(() => {
      fireEvent.doubleClick(svg, { clientX: 20, clientY: 22 });
    });
    const input = q(root, "[data-grid-editor]") as HTMLInputElement;
    expect(input.value).toBe("Notebooks");
    for (const tokens of Object.values(THEMES)) {
      expect(
        contrast(
          resolve(tokens, declared(input, "color")),
          resolve(tokens, declared(input, "background")),
        ),
      ).toBeGreaterThanOrEqual(4.5);
      expect(resolve(tokens, declared(input, "background"))).toEqual(
        resolve(tokens, "var(--paper)"),
      );
    }
  });
});
