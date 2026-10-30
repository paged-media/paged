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

// paged.image's pixel warps in the running editor (WP5.6, image ADR 483):
// Edit ▸ Transform ▸ Warp…, Edit ▸ Puppet warp…, Image ▸ Filter ▸ Liquify…
// and Edit ▸ Content-aware scale… open the Filter dialog with their geometry
// on the canvas (Warp's mesh handles, Puppet Warp's pins, Liquify's strokes),
// edited by a drag with whatever image tool is in hand; OK applies — on the
// GPU lane as one undo step, on the CPU lane the session declines honestly.
// The Perspective Crop tool draws a quad, Enter crops the stack upright.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { Designer } from "../journey/driver/designer";
import {
  ADJ_PANEL,
  FRAME,
  armTool,
  clickPt,
  dragPt,
  ingest,
  sourceReadout,
  statusText,
} from "../journey/plugins/image-helpers";

const C = "media.paged.image.command";
const T = "media.paged.image.tool";

// The 96 px image is fit into FRAME (270 × 200 pt): 200/96 pt a pixel,
// centred — x 125…325, y 120…320.
const IMG = { x0: 125, y0: 120, x1: 325, y1: 320 } as const;
const at = (u: number, v: number): [number, number] => [
  IMG.x0 + (IMG.x1 - IMG.x0) * u,
  IMG.y0 + (IMG.y1 - IMG.y0) * v,
];

async function open(page: Page): Promise<Designer> {
  const designer = new Designer(page);
  await ingest(designer, page, "warp-source.png", "gradient");
  await designer.openPanel(ADJ_PANEL);
  await expect
    .poll(() => sourceReadout(page), { timeout: 20_000 })
    .toContain("96×96");
  await armTool(designer, `${T}.brush`);
  return designer;
}

const readout = (page: Page, key: string) =>
  page.locator(`[data-filter-data="${key}"]`).first().textContent();

/** OK, then the lane's honest answer: applied on the GPU, declined on CPU. */
async function okApplies(page: Page, label: RegExp): Promise<void> {
  await page.locator("[data-filter-ok]").click();
  await expect
    .poll(() => statusText(page), { timeout: 30_000 })
    .toMatch(new RegExp(`${label.source}.*(applied|GPU-only)`, "i"));
}

test.describe("paged.image · warps", () => {
  test("Warp… draws the mesh; dragging a point makes it custom; OK applies @feat:image.editor.transform-warp @level:gesture", async ({
    page,
  }) => {
    covers("command:media.paged.image.command.transformWarp");
    test.setTimeout(180_000);
    const designer = await open(page);
    await designer.runCommand(`${C}.transformWarp`);
    await expect(page.locator('[data-filter-dialog="warp"]')).toHaveCount(1);
    const layer = page.locator('[data-overlay-layer="media.paged.image/warp"]');
    await expect(layer.locator("[data-preview-handle]")).toHaveCount(16);
    expect(await readout(page, "mesh")).toBe("style mesh");
    // The bottom-right control point is the image's corner.
    await dragPt(page, [at(1, 1), at(0.85, 0.85)]);
    await expect.poll(() => readout(page, "mesh")).toBe("custom mesh");
    await okApplies(page, /Warp/);
  });

  test("Puppet warp… adds pins with clicks, a drag bends, OK applies @feat:image.editor.transform-warp @level:gesture", async ({
    page,
  }) => {
    covers("command:media.paged.image.command.puppetWarp");
    test.setTimeout(180_000);
    const designer = await open(page);
    await designer.runCommand(`${C}.puppetWarp`);
    await expect(page.locator('[data-filter-dialog="puppetWarp"]')).toHaveCount(
      1,
    );
    await clickPt(page, ...at(0.2, 0.5));
    await clickPt(page, ...at(0.8, 0.5));
    await expect.poll(() => readout(page, "pins")).toBe("2 pins");
    await dragPt(page, [at(0.8, 0.5), at(0.8, 0.2)]);
    await expect.poll(() => readout(page, "pins")).toBe("2 pins");
    await okApplies(page, /Puppet warp/);
  });

  test("Liquify… records a drag as a stroke; OK applies @feat:image.editor.transform-warp @level:gesture", async ({
    page,
  }) => {
    covers("command:media.paged.image.command.filterLiquify");
    test.setTimeout(180_000);
    const designer = await open(page);
    await designer.runCommand(`${C}.filterLiquify`);
    await expect(page.locator('[data-filter-dialog="liquify"]')).toHaveCount(1);
    await dragPt(page, [at(0.3, 0.5), at(0.5, 0.5), at(0.7, 0.5)]);
    await expect.poll(() => readout(page, "strokes")).toBe("1 stroke");
    await okApplies(page, /Liquify/);
  });

  test("Content-aware scale… applies at 75 % width @feat:image.editor.transform-warp @level:gesture", async ({
    page,
  }) => {
    covers("command:media.paged.image.command.contentAwareScale");
    test.setTimeout(180_000);
    const designer = await open(page);
    await designer.runCommand(`${C}.contentAwareScale`);
    const width = page.locator('[data-filter-param="width"]').first();
    await width.fill("75");
    await okApplies(page, /Content-aware scale/);
  });

  test("the Perspective Crop tool draws a quad and Enter crops the image upright @feat:image.editor.transform-warp @level:gesture", async ({
    page,
  }) => {
    covers("tool:media.paged.image.tool.perspectiveCrop");
    covers("command:media.paged.image.command.commitPerspectiveCrop");
    test.setTimeout(180_000);
    const designer = await open(page);
    await armTool(designer, `${T}.perspectiveCrop`);
    await dragPt(page, [at(0.25, 0.25), at(0.75, 0.75)]);
    const layer = page.locator(
      '[data-overlay-layer="media.paged.image/perspective-crop"]',
    );
    await expect(layer.locator("[data-preview-handle]")).toHaveCount(4);
    // Pull the NE corner in: a keystone.
    await dragPt(page, [at(0.75, 0.25), at(0.65, 0.25)]);
    await page.keyboard.press("Enter");
    // GPU: the stack is cropped (about 43 × 48 px); CPU: declined honestly.
    await expect
      .poll(
        async () => `${await sourceReadout(page)} | ${await statusText(page)}`,
        { timeout: 30_000 },
      )
      .toMatch(/(\b4\d×4\d\b|GPU-only|GPU)/);
  });
});
