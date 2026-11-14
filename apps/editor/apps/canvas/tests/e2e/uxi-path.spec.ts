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

// The Pen and path editing (the interaction specification's §8.4,
// `UXI-DRW-002`, `UXI-DRW-003`, `UXI-DRW-006`; plan task IC11; UX audit
// F-35): the Pen stays the Pen after it closes a path and the next clicks
// start another one, each path one undo step; deleting selected points
// removes only those, as one undo step. Each test asserts the model
// (`modelSnapshot`) and the history (the engine's undo log).

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { idsOfKind } from "./harness/gesture-kit";
import { expectUndoSteps, undoDepth } from "./harness/history";
import { activateTool, clientPointOf } from "./harness/interaction";
import { modelSnapshot } from "./harness/model-dump";
import { openUxiFixture, UXI_B } from "./harness/uxi-fixtures";

const B = UXI_B;

async function undo(page: Page): Promise<void> {
  await page.evaluate(() =>
    (
      globalThis as unknown as {
        __canvas: { client: { undo(): Promise<unknown> } };
      }
    ).__canvas.client.undo(),
  );
}

async function click(page: Page, at: readonly [number, number]) {
  const p = await clientPointOf(page, { at });
  await page.mouse.click(p.x, p.y);
}

async function paths(page: Page): Promise<number> {
  const kinds = await Promise.all(
    ["polygon", "graphicLine"].map((k) => idsOfKind(page, k)),
  );
  return kinds.reduce((n, ids) => n + ids.length, 0);
}

const toolActive = (page: Page, id: string) =>
  page.locator(`[data-tool="${id}"][data-active="true"]`).first();

test.describe("UXI path — the Pen and path editing (IC11)", () => {
  test.beforeEach(async ({ page }) => {
    await openUxiFixture(page, "B");
  });

  test("UXI-T17 — the Pen closes a path and stays the Pen; the next clicks draw another path; one undo step each @feat:plugin-draw.pen-machine @level:gesture", async ({
    page,
  }) => {
    covers("tool:paged.tool.pen");
    await activateTool(page, "paged.tool.pen");
    const model = await modelSnapshot(page);
    const before = await paths(page);
    // A triangle, closed on its first anchor.
    await expectUndoSteps(page, 1, async () => {
      await click(page, [380, 300]);
      await click(page, [480, 300]);
      await click(page, [430, 380]);
      await click(page, [380, 300]);
    });
    await expect(toolActive(page, "paged.tool.pen")).toBeVisible();
    expect(await paths(page)).toBe(before + 1);
    // Another, open, ended with Enter: a path of its own.
    await expectUndoSteps(page, 1, async () => {
      await click(page, [380, 450]);
      await click(page, [500, 470]);
      await page.keyboard.press("Enter");
    });
    await expect(toolActive(page, "paged.tool.pen")).toBeVisible();
    expect(await paths(page)).toBe(before + 2);
    await undo(page);
    await undo(page);
    expect(await modelSnapshot(page)).toBe(model);
  });

  test("UXI-T18 — deleting two selected points removes only them; one undo restores the path @feat:editor-tools.path.direct-edit @level:gesture", async ({
    page,
  }) => {
    covers("tool:paged.tool.directSelect");
    await activateTool(page, "paged.tool.directSelect");
    const model = await modelSnapshot(page);
    const depth = await undoDepth(page);
    // Direct Selection on the path: its anchors appear.
    await click(page, B.path.at);
    await expect(page.locator("[data-path-edit]")).toHaveCount(1);
    const [a0, a1] = B.path.anchors;
    await click(page, a0);
    const p1 = await clientPointOf(page, { at: a1 });
    await page.keyboard.down("Shift");
    await page.mouse.click(p1.x, p1.y);
    await page.keyboard.up("Shift");
    await expectUndoSteps(page, 1, () => page.keyboard.press("Delete"));
    // Two of four anchors left.
    await expect(page.locator('[data-path-anchor$=":anchor"]')).toHaveCount(2);
    await undo(page);
    expect(await modelSnapshot(page), "one undo restores the path").toBe(model);
    expect(await undoDepth(page)).toBe(depth);
  });
});
