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

// Commands say why they do not apply, and align honours its key object, in
// the running editor (track FI4 and FI5; editor ADR 1218, ADR 1201's D-07
// and D-16). Each asserts the document and the engine's undo log.

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { openPanel } from "../fidelity/canvas-driver";
import { elementPageRectPt } from "./harness/fixtures";
import { selectElements } from "./harness/gesture-kit";
import { expectHistoryUnchanged, expectUndoSteps } from "./harness/history";
import { activateTool } from "./harness/interaction";
import { modelSnapshot } from "./harness/model-dump";
import { openUxiFixture, UXI_A } from "./harness/uxi-fixtures";

const A = UXI_A;

async function invoke(page: Page, id: string, payload?: unknown) {
  await page.evaluate(
    ([command, args]) =>
      (
        globalThis as unknown as {
          __canvas: {
            registries: {
              commands: { invoke(id: string, p?: unknown): Promise<unknown> };
            };
          };
        }
      ).__canvas.registries.commands.invoke(command as string, args),
    [id, payload] as const,
  );
}

async function openMenu(page: Page, top: string) {
  const trigger = page.locator(`[data-menu-trigger="${top}"]`).first();
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  return page.locator(`[id="${await trigger.getAttribute("aria-controls")}"]`);
}

test.describe("UXI FI4 — commands say why they do not apply", () => {
  test.beforeEach(async ({ page }) => {
    await openUxiFixture(page, "A");
    await activateTool(page, "paged.tool.select");
    await selectElements(page, []);
  });

  test("@uxi:UXI-PNL-004 — with nothing selected the Object menu greys Group and says why; choosing it runs nothing @uxi:UXI-CMD-002 @feat:editor-shell.menus @level:edge", async ({
    page,
  }) => {
    covers("menu:Object/Group");
    const menu = await openMenu(page, "Object");
    const group = menu
      .locator('[role="menuitem"]', { hasText: /^Group/ })
      .first();
    await expect(group).toHaveAttribute("aria-disabled", "true");
    await expect(group).toHaveAttribute("data-why", "Select an object first.");
    await expect(group).toHaveAttribute("title", "Select an object first.");
    const model = await modelSnapshot(page);
    // `force`: Playwright waits for an aria-disabled item to enable.
    await expectHistoryUnchanged(page, () => group.click({ force: true }));
    // The menu stays open on a greyed entry, and nothing changed.
    await expect(menu).toBeVisible();
    expect(await modelSnapshot(page)).toBe(model);
    await page.keyboard.press("Escape");
  });

  test("@uxi:UXI-CMD-002 — the palette lists Group with its reason instead of hiding it @uxi:UXI-PNL-004 @feat:editor-shell.command-palette @level:edge", async ({
    page,
  }) => {
    covers("command:paged.palette.toggle", "command:paged.object.group");
    await invoke(page, "paged.palette.toggle");
    const input = page.locator("[cmdk-input]");
    await expect(input).toBeVisible();
    await input.fill("Group");
    const row = page.locator('[data-palette-unavailable="paged.object.group"]');
    await expect(row).toBeVisible();
    await expect(row.locator("[data-palette-why]")).toHaveText(
      "Select an object first.",
    );
    await page.keyboard.press("Escape");
  });

  test('@uxi:UXI-CMD-001 — "go to page" in the palette navigates through the command and changes nothing in the document @feat:editor-shell.command-palette @level:happy', async ({
    page,
  }) => {
    covers("command:paged.palette.toggle", "command:paged.view.goToPage");
    const model = await modelSnapshot(page);
    await invoke(page, "paged.palette.toggle");
    const input = page.locator("[cmdk-input]");
    await input.fill("go to page 1");
    const row = page.locator("[data-palette-goto]");
    // The page at position 1, named by its folio (the fixture's page name).
    await expect(row).toHaveAttribute("data-palette-goto", A.pageId);
    await expect(row).toContainText("Go to page");
    await expectHistoryUnchanged(page, () => row.click());
    await expect(input).toBeHidden();
    expect(await modelSnapshot(page)).toBe(model);
  });
});

test.describe("UXI FI5 — align honours its key object (D-07)", () => {
  test.beforeEach(async ({ page }) => {
    await openUxiFixture(page, "A");
    await activateTool(page, "paged.tool.select");
  });

  test("@uxi:UXI-SEL-018 — the key object chosen in Align stays; the control bar aligns the others to it in one step, and its hover shows the reference @feat:editor-shell.panels.align @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.align");
    await selectElements(page, [A.back.id, A.free.id]);
    await openPanel(page, "paged.align");
    const panel = page.locator('[data-align-panel="ready"]');
    await panel.locator("[data-align-scope]").selectOption("keyObject");
    // The second object is the key, chosen explicitly.
    await panel.locator("[data-key-object-choice]").selectOption("1");
    const keyBefore = (await elementPageRectPt(page, A.free.id))!;
    const otherBefore = (await elementPageRectPt(page, A.back.id))!;
    const left = page.locator('[data-cockpit-action="align-left"]');
    await left.hover();
    await expect(
      page.locator('[data-align-reference="keyObject"]'),
    ).toHaveCount(1);
    await expectUndoSteps(page, 1, () => left.click());
    await expect
      .poll(async () => (await elementPageRectPt(page, A.back.id))!.left)
      .toBeCloseTo(keyBefore.left, 1);
    const keyAfter = (await elementPageRectPt(page, A.free.id))!;
    expect(keyAfter.left).toBeCloseTo(keyBefore.left, 3);
    expect(keyAfter.top).toBeCloseTo(keyBefore.top, 3);
    expect(otherBefore.left).not.toBeCloseTo(keyBefore.left, 1);
  });
});
