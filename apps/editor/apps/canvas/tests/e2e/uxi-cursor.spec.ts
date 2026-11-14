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

// The cursor contract (the interaction specification's §14.3,
// `UXI-OVR-010`; plan task IC9, editor ADR 1227): the canvas
// shows the cursor of the session holding the pointer for the whole of
// its drag — a handle's resize cursor even where the pointer outruns the
// handle, the closed hand while the Hand pans — and the tool's again when
// it ends. Each test asserts the model (`modelSnapshot`) and the history
// (the engine's undo log).

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { selectElements } from "./harness/gesture-kit";
import {
  expectHistoryUnchanged,
  expectUndoSteps,
  undoDepth,
} from "./harness/history";
import { activateTool, clientPointOf } from "./harness/interaction";
import { modelSnapshot } from "./harness/model-dump";
import { openUxiFixture, UXI_A } from "./harness/uxi-fixtures";

const A = UXI_A;

const hostCursor = (page: Page) =>
  page
    .locator('[data-testid="viewport-canvas-host"]')
    .evaluate((el) => (el as HTMLElement).style.cursor);

async function undo(page: Page): Promise<void> {
  await page.evaluate(() =>
    (
      globalThis as unknown as {
        __canvas: { client: { undo(): Promise<unknown> } };
      }
    ).__canvas.client.undo(),
  );
}

test.describe("UXI cursor — one controller, the session's cursor first (IC9)", () => {
  test.beforeEach(async ({ page }) => {
    await openUxiFixture(page, "A");
  });

  test("a resize keeps its handle's cursor where the pointer outruns the handle, and the tool's comes back @feat:editor-tools.resize.handles @level:gesture @uxi:UXI-OVR-010", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    await activateTool(page, "paged.tool.select");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    await selectElements(page, [A.free.id]);
    const before = await hostCursor(page);
    const handle = page
      .locator(
        '[data-selection-handle="southEast"] > rect[data-handle="southEast"]',
      )
      .last();
    const box = (await handle.boundingBox())!;
    await expectUndoSteps(page, 1, async () => {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 60, box.y + 40, { steps: 6 });
      // The pointer is far from the handle now: the cursor is still the
      // resize's.
      await expect.poll(() => hostCursor(page)).toBe("nwse-resize");
      await page.mouse.up();
    });
    await expect.poll(() => hostCursor(page)).toBe(before);
    await undo(page);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(depth);
  });

  test("the Hand shows the closed hand while it pans and the open hand again after @feat:editor-tools.nav.hand @level:gesture @uxi:UXI-OVR-010", async ({
    page,
  }) => {
    covers("tool:paged.tool.hand");
    await activateTool(page, "paged.tool.hand");
    const model = await modelSnapshot(page);
    const p = await clientPointOf(page, { at: A.emptyAt });
    const open = await hostCursor(page);
    await expectHistoryUnchanged(page, async () => {
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await page.mouse.move(p.x + 40, p.y + 30, { steps: 5 });
      await expect.poll(() => hostCursor(page)).toBe("grabbing");
      await page.mouse.up();
    });
    await expect.poll(() => hostCursor(page)).toBe(open);
    expect(await modelSnapshot(page), "a pan changes nothing").toBe(model);
  });
});
