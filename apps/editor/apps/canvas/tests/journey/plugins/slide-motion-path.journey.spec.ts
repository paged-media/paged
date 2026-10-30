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
// paged.slide motion paths on the canvas (slide ADR 714, amendment
// 2026-10-30): add a motion path in the Animations pane, pick it, and its
// path shows on the slide with Bézier handles; dragging an end point
// writes the new path into the timing (one undo step) and export writes
// it as `p:animMotion path`. Lock the path sets `pathEditMode="fixed"`.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { Designer } from "../driver/designer";
import {
  exportedPart,
  goToSlide,
  openDeck,
  shapesOn,
} from "./slide-show-helpers";

const motion = async (page: Page) => {
  const xml = await exportedPart(page, "ppt/slides/slide1.xml");
  const m = /<p:animMotion [^>]*>/.exec(xml)?.[0] ?? "";
  return {
    path: /path="([^"]*)"/.exec(m)?.[1] ?? null,
    mode: /pathEditMode="([^"]*)"/.exec(m)?.[1] ?? null,
  };
};

test.describe("journey · paged.slide motion paths", () => {
  test("a motion path is shown on the slide, edited with its handles and locked @feat:plugin-slide.animations @level:happy", async ({
    page,
  }) => {
    covers("panel:media.paged.slide.panel.animations");
    const designer = new Designer(page);
    const ids = await openDeck(page);
    await goToSlide(page, ids[0]!);
    const [shape] = await shapesOn(page, ids[0]!);
    await designer.selectElement(shape!.kind, shape!.id);
    await designer.openPanel("media.paged.slide.panel.animations");
    const pane = page.locator("[data-animations-panel]");
    await expect(pane).toBeVisible({ timeout: 15_000 });
    await pane.locator('[data-animations-class="path"]').click();
    const preset = pane.locator('[data-animation-preset^="path:"]').first();
    await expect(preset).toBeEnabled({ timeout: 15_000 });
    await preset.click();
    const row = pane.locator('[data-animation-row="0"]');
    await expect(row).toBeVisible({ timeout: 15_000 });
    const before = await motion(page);
    expect(before.path).toBeTruthy();

    // Picked, its path is on the slide with its handles.
    await row.click();
    const overlay = page.locator("[data-slide-motion-path]");
    await expect
      .poll(async () => Number(await overlay.getAttribute("data-count")), {
        timeout: 15_000,
      })
      .toBeGreaterThan(1);
    const ends = page.locator('[data-slide-motion-path-handle":to"]');
    const last = ends.last();
    await expect(last).toBeVisible();

    // Drag the end point 40 px right and 20 px down.
    const box = (await last.boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 20, y + 10, { steps: 4 });
    await page.mouse.move(x + 40, y + 20, { steps: 4 });
    await page.mouse.up();
    await expect
      .poll(async () => (await motion(page)).path, { timeout: 15_000 })
      .not.toBe(before.path);
    const edited = (await motion(page)).path!;
    expect(edited).toMatch(/ E$/);

    // One undo puts the path back.
    await designer.runCommand("paged.editor.undo");
    await expect
      .poll(async () => (await motion(page)).path, { timeout: 15_000 })
      .toBe(before.path);

    // Lock the path.
    await row.click();
    const lock = pane.locator("[data-animation-path-locked]");
    await expect(lock).toBeVisible({ timeout: 15_000 });
    await lock.check();
    await expect
      .poll(async () => (await motion(page)).mode, { timeout: 15_000 })
      .toBe("fixed");
    // Auto-reverse is offered beside it.
    await expect(pane.locator("[data-animation-autoreverse]")).toBeVisible();
  });
});
