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

// Engine ADR 1011 — artboards on the real canvas:
//
//   AB-01  shift+o picks the Artboard tool; dragging the first page moves
//          it on the canvas (the handle's pageOriginsPt), the other pages
//          stay; ONE undo puts it back.
//   AB-02  dragging a corner handle resizes the board, its content staying
//          put on the canvas; one undo.
//   AB-03  the Artboards panel names a board and exports each board as a
//          file named after it.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { openCanvas } from "../fidelity/canvas-driver";
import { loadViaReactPath, screenPoint } from "./harness/viewport";
import { undo } from "./harness/gesture";
import { openPanel } from "./harness/ui";

type Handle = {
  pageIds: string[];
  pageSizesPt: [number, number][];
  pageOriginsPt?: [number, number][];
};

async function handle(page: Page): Promise<Handle> {
  return page.evaluate(
    () =>
      (globalThis as unknown as { __canvas: { handle: Handle } }).__canvas
        .handle,
  );
}

async function pickArtboardTool(page: Page): Promise<void> {
  await page.keyboard.press("Shift+O");
  // The Artboard tool lives in the Page tool's slot (its flyout).
  await expect(
    page.locator('[data-tool-slot="page"][data-active="true"]'),
  ).toBeVisible();
}

async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / 8,
      from.y + ((to.y - from.y) * i) / 8,
    );
  }
  await page.mouse.up();
}

test("AB-01 — the Artboard tool moves a page on the canvas; ONE undo puts it back @feat:layout-model.artboards @level:gesture", async ({
  page,
}) => {
  covers("tool:paged.tool.artboard");
  await openCanvas(page);
  await loadViaReactPath(page, "geometry");
  const before = await handle(page);
  expect(before.pageOriginsPt?.length).toBe(before.pageIds.length);

  await pickArtboardTool(page);
  const from = await screenPoint(page, 100, 100);
  // 120 CSS px to the right, in pt at the fitted zoom.
  await drag(page, from, { x: from.x + 120, y: from.y });
  const dx = 120 / from.scale;

  await expect
    .poll(async () => (await handle(page)).pageOriginsPt?.[0]?.[0] ?? 0, {
      timeout: 5_000,
    })
    .toBeGreaterThan(dx - 8);
  const moved = await handle(page);
  expect(moved.pageOriginsPt![0][1]).toBeCloseTo(
    before.pageOriginsPt![0][1],
    0,
  );
  for (let i = 1; i < moved.pageIds.length; i++) {
    expect(moved.pageOriginsPt![i]).toEqual(before.pageOriginsPt![i]);
  }

  await undo(page);
  await expect
    .poll(async () => (await handle(page)).pageOriginsPt?.[0])
    .toEqual(before.pageOriginsPt![0]);
});

test("AB-02 — a corner handle resizes the board, the content staying put; one undo @feat:layout-model.artboards @level:gesture", async ({
  page,
}) => {
  await openCanvas(page);
  await loadViaReactPath(page, "geometry");
  const before = await handle(page);
  const [w, h] = before.pageSizesPt[0];
  await pickArtboardTool(page);
  // Select the board, then grab its bottom-right handle.
  const inside = await screenPoint(page, 50, 50);
  await page.mouse.click(inside.x, inside.y);
  const corner = await screenPoint(page, w, h);
  await drag(page, corner, { x: corner.x + 60, y: corner.y + 40 });
  await expect
    .poll(async () => (await handle(page)).pageSizesPt[0][0], {
      timeout: 5_000,
    })
    .toBeGreaterThan(w + 20);
  const after = await handle(page);
  expect(after.pageSizesPt[0][1]).toBeGreaterThan(h + 10);
  // The top-left (and so the content) did not move.
  expect(after.pageOriginsPt![0]).toEqual(before.pageOriginsPt![0]);
  await undo(page);
  await expect
    .poll(async () => (await handle(page)).pageSizesPt[0])
    .toEqual(before.pageSizesPt[0]);
});

test("AB-03 — the Artboards panel renames a board and exports one file per board, named after it @feat:layout-model.artboards @level:happy", async ({
  page,
}) => {
  covers("panel:paged.artboards");
  await openCanvas(page);
  await loadViaReactPath(page, "geometry");
  const { pageIds } = await handle(page);
  await openPanel(page, "paged.artboards");
  const panel = page.locator('[data-artboards-panel="ready"]');
  await expect(panel).toBeVisible();
  await panel.locator(`[data-list-row="${pageIds[0]}"]`).click();
  const name = panel.locator("[data-artboard-name]");
  await name.fill("Cover");
  await name.press("Enter");
  await expect(panel.locator(`[data-list-row="${pageIds[0]}"]`)).toContainText(
    "Cover",
  );

  // Record the files the export hands the browser (a burst of real
  // downloads is throttled by the browser itself).
  await page.evaluate(() => {
    const names: string[] = [];
    (globalThis as unknown as { __downloads: string[] }).__downloads = names;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.download) names.push(this.download);
    };
  });
  await panel.locator("[data-artboard-export-all]").click();
  await expect(panel.locator("[data-artboard-export-status]")).toContainText(
    `${pageIds.length} `,
    { timeout: 60_000 },
  );
  const downloads = await page.evaluate(
    () => (globalThis as unknown as { __downloads: string[] }).__downloads,
  );
  expect(downloads).toHaveLength(pageIds.length);
  expect(downloads[0]).toBe("Cover.png");
  expect(downloads[1]).toBe("Artboard 2.png");
});
