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

// Sheet ADR 510 — what the grid shows is what lands on the page. The grid
// inside the frame is drawn by the sheet's Canvas2D painter; the page's
// table by the engine. Leaving the frame must not move anything: the cells
// the grid showed (right of and below its headings) and the page's table
// (at the frame's corner) are compared as ink maps sampled in points, so
// the two renderers' antialiasing and the grid's light gridlines do not
// count, but a cell out of place does. A one-row shift of the same page is
// the control: the measure must tell that apart from the real pair.

import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";

import { Designer } from "../driver/designer";
import {
  elementScreenBox,
  elementScreenCenter,
  importAndLower,
  placedValues,
} from "./sheet-kit";

/** 30 rows × 4 columns whose text lengths differ from row to row, so a
 *  row out of place changes the picture. Every text fits its column: a
 *  window frame widens a column too narrow for its text on the page, so
 *  that no cell wraps (ADR 510), and the grid would then show less. */
const CSV = Array.from({ length: 30 }, (_, r) =>
  [
    "n".repeat(1 + ((r * 3) % 5)),
    String(10 ** ((r * 3) % 5) + r),
    "x".repeat(1 + ((r * 2) % 5)),
    String(r % 4 === 0 ? 1234 : r),
  ].join(","),
).join("\n");

/** One sample block, pt. */
const BLOCK_PT = 3;

interface Shot {
  png: PNG;
  /** Device px per CSS px. */
  dpr: number;
}

async function shoot(page: Page): Promise<Shot> {
  const png = PNG.sync.read(await page.screenshot());
  const css = page.viewportSize()!.width;
  return { png, dpr: png.width / css };
}

/** The ink map of a region: `cols × rows` blocks of BLOCK_PT, each the
 *  mean ink of its pixels, counted from a light grey down (text and dark
 *  rules; light gridlines and fills are not ink). */
function inkMap(
  shot: Shot,
  originX: number,
  originY: number,
  pxPerPt: number,
  cols: number,
  rows: number,
): Float64Array {
  const { png, dpr } = shot;
  const out = new Float64Array(cols * rows);
  const step = pxPerPt * dpr * BLOCK_PT;
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const x0 = Math.round(originX * dpr + bx * step);
      const y0 = Math.round(originY * dpr + by * step);
      const x1 = Math.round(originX * dpr + (bx + 1) * step);
      const y1 = Math.round(originY * dpr + (by + 1) * step);
      let ink = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
          const i = (y * png.width + x) * 4;
          const lum =
            0.2126 * png.data[i]! +
            0.7152 * png.data[i + 1]! +
            0.0722 * png.data[i + 2]!;
          // Ink from mid grey down: light gridlines and fills are none.
          ink += Math.max(0, (200 - lum) / 200);
          n++;
        }
      }
      out[by * cols + bx] = n ? ink / n : 0;
    }
  }
  return out;
}

/** A 3×3 box blur: a glyph a point off still overlaps itself. */
function blur(m: Float64Array, cols: number, rows: number): Float64Array {
  const out = new Float64Array(m.length);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
          s += m[yy * cols + xx]!;
          n++;
        }
      }
      out[y * cols + x] = s / n;
    }
  }
  return out;
}

/** How far apart two ink maps are: each scaled to the same total ink (the
 *  page's softer raster carries less), then the absolute difference over
 *  the ink both carry — 0 is the same picture, 1 nothing in common. */
function distance(a: Float64Array, b: Float64Array): number {
  const sum = (m: Float64Array) => m.reduce((x, y) => x + y, 0);
  const ka = 1 / (sum(a) || 1);
  const kb = 1 / (sum(b) || 1);
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! * ka - b[i]! * kb);
  return d / 2;
}

test.describe("journey · paged.sheet — the grid shows what the page prints", () => {
  test("the cells the grid shows and the page's table after leaving line up @feat:sheet.grid.inframe @feat:sheet.lower.page @level:gesture", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();
    const frame = await importAndLower(page, "A1:D10", {
      name: "items.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(CSV),
    });
    await expect
      .poll(async () => (await placedValues(page))[0]?.[0] ?? "", {
        timeout: 15_000,
      })
      .toBe("n");

    // ── Zoom to 200 %: a point is a couple of pixels. ──
    // The preset, not keystrokes: on a loaded runner the zoom keys raced the
    // first fit and the page was measured at 95 % or 130 %, where the blur
    // alone moved the distance past the bound. The readout must hold 200 %.
    await page.locator("[data-zoom-control]").click();
    await page.locator('[data-zoom-preset="2"]').click();
    await expect
      .poll(
        async () => {
          await page.waitForTimeout(400);
          return (await page.locator("[data-zoom-control]").textContent())
            ?.replace(/\s/g, "")
            .includes("200%");
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    // Scroll the frame into the middle of the canvas.
    for (let i = 0; i < 4; i++) {
      const b = await elementScreenBox(page, frame);
      const dy = b.y - 150;
      const dx = b.x - 420;
      if (Math.abs(dy) < 12 && Math.abs(dx) < 40) break;
      await page.mouse.move(600, 400);
      await page.mouse.wheel(dx, dy);
      await page.waitForTimeout(400);
    }

    // ── Enter, and let the document's faces load into the painter. ──
    const at = await elementScreenCenter(page, frame);
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    const surface = page.locator('[data-testid="sheet-frame-surface"]');
    await expect(surface).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1_000);
    const sBox = (await surface.boundingBox())!;
    const [headW, headH] = (await surface.getAttribute("data-heading-pt"))!
      .split(",")
      .map(Number) as [number, number];
    const surfaceCells = await surface.getAttribute("data-cells-pt");
    const geo = await elementScreenBox(page, frame);
    const gridPxPerPt = sBox.width / geo.widthPt;
    const gridShot = await shoot(page);

    // ── Leave, and wait for the page's table to settle. ──
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-edit-context-breadcrumb]")).toHaveCount(0);
    // Nothing selected (the frame's handles would cover the table), and
    // the page re-rasterised at this zoom: two shots in a row agree.
    await page.keyboard.press("Escape");
    {
      const b = await elementScreenBox(page, frame);
      const clip = {
        x: Math.floor(b.x),
        y: Math.floor(b.y),
        width: Math.ceil(b.widthPt * b.pxPerPt),
        height: Math.ceil(b.heightPt * b.pxPerPt),
      };
      let prev = await page.screenshot({ clip });
      await expect
        .poll(
          async () => {
            await page.waitForTimeout(700);
            const next = await page.screenshot({ clip });
            const same = Buffer.compare(prev, next) === 0;
            prev = next;
            return same;
          },
          { timeout: 20_000 },
        )
        .toBe(true);
    }
    const pageBox = await elementScreenBox(page, frame);
    const pageShot = await shoot(page);

    // Only the whole cells the grid showed: the page adds the column and
    // rows that fit once the headings are gone.
    const [cellsW, cellsH] = surfaceCells!.split(",").map(Number) as [
      number,
      number,
    ];
    const cols = Math.floor(cellsW / BLOCK_PT);
    const rows = Math.floor(cellsH / BLOCK_PT);
    const grid = blur(
      inkMap(
        gridShot,
        sBox.x + headW * gridPxPerPt,
        sBox.y + headH * gridPxPerPt,
        gridPxPerPt,
        cols,
        rows,
      ),
      cols,
      rows,
    );
    const placed = blur(
      inkMap(pageShot, pageBox.x, pageBox.y, pageBox.pxPerPt, cols, rows),
      cols,
      rows,
    );
    // The controls: the same page one row (15 pt) down, one column right.
    const rowOff = blur(
      inkMap(
        pageShot,
        pageBox.x,
        pageBox.y + 15 * pageBox.pxPerPt,
        pageBox.pxPerPt,
        cols,
        rows,
      ),
      cols,
      rows,
    );
    const colOff = blur(
      inkMap(
        pageShot,
        pageBox.x + 44 * pageBox.pxPerPt,
        pageBox.y,
        pageBox.pxPerPt,
        cols,
        rows,
      ),
      cols,
      rows,
    );
    const same = distance(grid, placed);
    const row = distance(grid, rowOff);
    const col = distance(grid, colOff);
    test.info().annotations.push({
      type: "screen-vs-page",
      description: `distance ${same.toFixed(3)} · a row off ${row.toFixed(3)} · a column off ${col.toFixed(3)}`,
    });
    // Measured 2026-10-28 (CPU canvas, 200 %): 0.22 · 0.51 · 0.74.
    expect(same, "the grid's cells and the page's table line up").toBeLessThan(
      0.3,
    );
    expect(same, "closer than a row out of place").toBeLessThan(row / 2);
    expect(same, "closer than a column out of place").toBeLessThan(col / 2);
  });
});
