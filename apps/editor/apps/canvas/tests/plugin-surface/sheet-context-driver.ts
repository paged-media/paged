/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// The sheet's RIGHT-CLICK driver: the `Context/…` rows a frame surface's
// bundle contributes (extensions ADR 334, editor ADR 281) show only in the
// canvas context menu, only while that bundle's edit context is active and
// the right-click lands inside its frame surface. The menu bar skips them,
// so menu-driver.ts cannot reach them.
//
// What it does, the way a user does it: import an .xlsx through the
// Workbook panel, place a range on the page, enter the placed frame
// (double-click), then right-click a cell of the frame surface and click a
// row of the menu that opens. Where each cell is on screen is MEASURED once
// (`calibrate`: click across the grid and read the name box), so no row
// height or column width of the workbook is assumed.
//
// What a click did is recorded by menu-driver.ts's probe: the command
// registry's own tap (exactly the row's command ran, once, and settled
// without an error) and the shell doors (`openPanel` …).

import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

import { expect, type Locator, type Page } from "@playwright/test";

import { openPanel } from "../fidelity/canvas-driver";
import {
  installMenuProbe,
  mark,
  recordedSince,
  type ClickOutcome,
} from "./menu-driver";

// sheet-02-formulas.xlsx: A1=2, B1="Sum", A2=3, B2="Product",
// A3=SUM(A1:A2)=5, B3=B1&B2="SumProduct".
export const XLSX_FIXTURE = pathResolve(
  dirname(fileURLToPath(import.meta.url)),
  "../e2e/harness/sheet-02-formulas.xlsx",
);
const WORKBOOK_PANEL = "media.paged.sheet.panel.workbook";
const GRID_PANEL = "media.paged.sheet.panel.grid";

interface ElementRef {
  kind: string;
  id: string;
}

interface CanvasHandle {
  __canvas: {
    client: {
      camera: { read: () => { scale: number; tx: number; ty: number } };
      elementGeometry: (ids: unknown[]) => Promise<
        Array<{
          bounds: [number, number, number, number];
          itemTransform?:
            [number, number, number, number, number, number] | null;
        }>
      >;
      executeScript: (
        s: string,
      ) => Promise<{ output: string[]; error: string | null }>;
    };
  };
}

async function selectedElement(page: Page): Promise<ElementRef | null> {
  return page.evaluate(async () => {
    const c = (globalThis as unknown as CanvasHandle).__canvas;
    const r = await c.client.executeScript("paged.selection()");
    const ids = JSON.parse(r.output[0] ?? "[]") as ElementRef[];
    return ids.length === 1 ? ids[0] : null;
  });
}

async function elementScreenCenter(
  page: Page,
  ref: ElementRef,
): Promise<{ x: number; y: number }> {
  const at = await page.evaluate(async (id) => {
    let best: HTMLCanvasElement | null = null;
    let bestArea = 0;
    for (const cv of Array.from(document.querySelectorAll("canvas"))) {
      const r = cv.getBoundingClientRect();
      if (r.width * r.height > bestArea) {
        bestArea = r.width * r.height;
        best = cv;
      }
    }
    const wrap = (best?.parentElement ?? best)!.getBoundingClientRect();
    const c = (globalThis as unknown as CanvasHandle).__canvas;
    const item = (await c.client.elementGeometry([id]))[0];
    if (!item) return null;
    const [top, left, bottom, right] = item.bounds;
    const [a, b, cc, d, tx, ty] = item.itemTransform ?? [1, 0, 0, 1, 0, 0];
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    const cam = c.client.camera.read();
    return {
      x: wrap.left + (a * cx + cc * cy + tx) * cam.scale + cam.tx,
      y: wrap.top + (b * cx + d * cy + ty) * cam.scale + cam.ty,
    };
  }, ref);
  expect(at, "the placed frame has on-screen geometry").not.toBeNull();
  return at!;
}

/** Import the fixture through the Workbook panel's picker and place
 *  `range` on the page; the placed frame. */
export async function importAndPlace(
  page: Page,
  range: string,
): Promise<ElementRef> {
  await openPanel(page, WORKBOOK_PANEL);
  const pick = page.locator("[data-sheet-pick]");
  await expect(pick).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await pick.click();
  await (await chooser).setFiles(XLSX_FIXTURE);
  const rangeInput = page.locator("[data-sheet-range]");
  await expect(rangeInput).toBeVisible({ timeout: 20_000 });
  await rangeInput.fill(range);
  await page.locator("[data-sheet-lower]").click();
  let frame: ElementRef | null = null;
  await expect
    .poll(
      async () => {
        frame = await selectedElement(page);
        return frame?.kind ?? null;
      },
      { timeout: 15_000 },
    )
    .not.toBeNull();
  return frame!;
}

/** The entered sheet: its frame surface and where each cell is on it. */
export interface SheetContext {
  surface: Locator;
  /** The screen centre of cell (row, col), 0-based, as measured. */
  cell(row: number, col: number): Promise<{ x: number; y: number }>;
}

export const surfaceOf = (page: Page) =>
  page.locator('[data-testid="sheet-frame-surface"]');
export const nameBox = (page: Page) =>
  page.locator('[data-testid="sheet-bar-name"]');
export const formulaBox = (page: Page) =>
  page.locator('[data-testid="sheet-bar-formula"]');

const a1 = (row: number, col: number) =>
  `${String.fromCharCode(65 + col)}${row + 1}`;

/** Enter the sheet context on `frame` (double-click) and measure where the
 *  first `rows` × `cols` cells are: a click across the cell area, the name
 *  box answering which cell each point is in. */
export async function enterSheet(
  page: Page,
  frame: ElementRef,
  rows: number,
  cols: number,
): Promise<SheetContext> {
  const at = await elementScreenCenter(page, frame);
  await page.mouse.dblclick(at.x, at.y);
  await expect(page.locator("[data-edit-context-breadcrumb]")).toBeVisible({
    timeout: 10_000,
  });
  await openPanel(page, GRID_PANEL);
  await page.waitForTimeout(600);
  const surface = surfaceOf(page);
  await expect(surface).toBeVisible({ timeout: 10_000 });
  await installMenuProbe(page);

  // Bands in surface pixels, per column (along the first row) and per row
  // (along the first column).
  const box = (await surface.boundingBox())!;
  const probe = async (x: number, y: number) => {
    await page.mouse.click(box.x + x, box.y + y);
    return (await nameBox(page).textContent())?.trim() ?? "";
  };
  const band = async (
    axis: "x" | "y",
    want: (i: number) => string,
    count: number,
    other: number,
    start: number,
    step: number,
  ) => {
    const span = axis === "x" ? box.width : box.height;
    const hits = new Map<number, number[]>();
    // Stop at the first cell past the ones wanted: a click on a cell the
    // frame shows only in part scrolls the grid's window, which would move
    // every cell measured so far.
    const past = want(count);
    for (let p = start; p < span - 1; p += step) {
      const name = await probe(
        axis === "x" ? p : other,
        axis === "x" ? other : p,
      );
      if (name === past) break;
      for (let i = 0; i < count; i++)
        if (name === want(i)) hits.set(i, [...(hits.get(i) ?? []), p]);
    }
    return Array.from({ length: count }, (_, i) => {
      const ps = hits.get(i);
      if (!ps) throw new Error(`cell ${want(i)} is not on the frame surface`);
      return (ps[0] + ps[ps.length - 1]) / 2;
    });
  };
  // Only the cell area is clicked: a click on a heading selects a whole
  // row or column, and near a heading's border it grabs the border. The
  // headings are 26 pt (rows) and 16 pt (columns) at the frame's scale.
  const widthPt = await page.evaluate(async (id) => {
    const c = (globalThis as unknown as CanvasHandle).__canvas;
    const g = (await c.client.elementGeometry([id]))[0]!;
    return g.bounds[3] - g.bounds[1];
  }, frame);
  const k = box.width / widthPt;
  const ys = await band("y", (r) => a1(r, 0), rows, 29 * k, 17 * k, 1);
  const xs = await band("x", (c) => a1(0, c), cols, ys[0], 27 * k, 2);
  return {
    surface,
    cell: async (row, col) => {
      const b = (await surface.boundingBox())!;
      return { x: b.x + xs[col], y: b.y + ys[row] };
    },
  };
}

/** Left-click cell (row, col): it becomes the selection. */
export async function clickCell(
  page: Page,
  sheet: SheetContext,
  row: number,
  col: number,
): Promise<void> {
  const p = await sheet.cell(row, col);
  await page.mouse.click(p.x, p.y);
  await expect(nameBox(page)).toHaveText(a1(row, col));
}

/** What cell (row, col) holds, read off the bar's formula field. */
export async function inputOf(
  page: Page,
  sheet: SheetContext,
  row: number,
  col: number,
): Promise<string> {
  await clickCell(page, sheet, row, col);
  return formulaBox(page).inputValue();
}

/** Right-click cell (row, col) — a cell outside the selection becomes the
 *  selection first, as in Excel — and answer the menu that opened. */
export async function openContextMenu(
  page: Page,
  sheet: SheetContext,
  row: number,
  col: number,
): Promise<Locator> {
  const p = await sheet.cell(row, col);
  await page.mouse.click(p.x, p.y, { button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

/** A row of the open context menu, by its label. A row's accessible name
 *  carries its shortcut after the label (`Copy ⌘C`), so the label is matched
 *  whole, optionally followed by a shortcut, and never as a prefix of a
 *  longer label (`Paste` is not `Paste special…`). */
export const contextRow = (menu: Locator, label: string) =>
  menu.getByRole("menuitem", {
    name: new RegExp(
      `^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( (⌘|⌥|⇧|⌃|Ctrl|Alt|Shift|Meta).*)?$`,
    ),
  });

/** Right-click cell (row, col), click the row `label`, and assert it ran
 *  exactly `command`, once, with no payload, settling without an error. */
export async function clickContextRow(
  page: Page,
  sheet: SheetContext,
  at: [row: number, col: number],
  label: string,
  command: string,
): Promise<Omit<ClickOutcome, "before" | "after">> {
  const m = await mark(page);
  const menu = await openContextMenu(page, sheet, at[0], at[1]);
  const row = contextRow(menu, label);
  await expect(
    row,
    `the sheet's right-click menu has "${label}"`,
  ).toBeVisible();
  await row.click();
  await expect
    .poll(
      async () =>
        (await recordedSince(page, m)).runs.filter(
          (r) => r.id === command && r.phase === "settled",
        ).length,
      { message: `${label} → ${command} settles`, timeout: 15_000 },
    )
    .toBe(1);
  await expect(page.getByRole("menu")).toHaveCount(0);
  const seen = await recordedSince(page, m);
  const started = seen.runs.filter((r) => r.phase === "started");
  expect(
    started.map((r) => r.id),
    `${label} runs exactly its command`,
  ).toEqual([command]);
  expect(started[0].payload, `${label} passes no payload`).toBe("undefined");
  expect(
    seen.runs.find((r) => r.phase === "settled")!.error,
    `${label}: the handler settles without throwing`,
  ).toBe(null);
  return seen;
}

/** One part of the open workbook as the sheet's .xlsx exporter writes it
 *  now (`xl/worksheets/sheet1.xml` …): what the grid holds that it does not
 *  draw (an outline group) is read back from the file Excel would open. */
export async function workbookPart(page: Page, part: string): Promise<string> {
  const bytes = await page.evaluate(async () => {
    const r = (
      globalThis as unknown as {
        __canvas: {
          registries: {
            exporters: {
              list(): Array<{
                id: string;
                export(): Promise<{ bytes: Uint8Array } | null>;
              }>;
            };
          };
        };
      }
    ).__canvas.registries;
    const e = r.exporters
      .list()
      .find((x) => x.id === "media.paged.sheet.exporter.xlsx");
    const out = await e!.export();
    return out ? Array.from(out.bytes) : null;
  });
  expect(bytes, "the workbook exports").not.toBeNull();
  const zip = Buffer.from(bytes!);
  // The ZIP's central directory names each entry and where it is.
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let at = zip.readUInt32LE(eocd + 16);
  const count = zip.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const skip =
      nameLen + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLen);
    if (name === part) {
      const local = zip.readUInt32LE(at + 42);
      const start =
        local +
        30 +
        zip.readUInt16LE(local + 26) +
        zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return (method === 0 ? data : inflateRawSync(data)).toString("utf8");
    }
    at += 46 + skip;
  }
  throw new Error(`the exported workbook has no ${part}`);
}
