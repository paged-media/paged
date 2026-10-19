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

// ADR 233 — what the cockpit hides stays mounted in an <Activity>: the
// side columns under Tab / Shift+Tab, the left panel of a mode left
// behind, the dock tabs that are not on screen, and the document viewport
// under an export-style mode. Hidden, a panel keeps its state and its DOM
// (a typed query, a scroll position) and holds no subscription; shown
// again, it is the same panel, not a new one.

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { blurAll, openShell, setMode } from "./harness/shell-surface";

const invoke = (page: Page, id: string) =>
  page.evaluate(
    (cmd) =>
      (
        globalThis as unknown as {
          __canvas: {
            registries: { commands: { invoke(id: string): Promise<unknown> } };
          };
        }
      ).__canvas.registries.commands.invoke(cmd),
    id,
  );

const openPanel = (page: Page, id: string) =>
  invoke(page, `paged.panel.show.${id}`);

test.describe("hidden panels stay mounted (ADR 233)", () => {
  test("a query typed in the left panel survives Tab hiding the panels", async ({
    page,
  }) => {
    covers("command:paged.chrome.toggleAll");
    await openShell(page, { doc: true });
    const search = page.locator("[data-document-map-search]");
    await expect(search).toBeVisible();
    await search.fill("2");
    await blurAll(page);
    await invoke(page, "paged.chrome.toggleAll");
    await expect(search).toBeHidden();
    await invoke(page, "paged.chrome.toggleAll");
    await expect(search).toBeVisible();
    await expect(search).toHaveValue("2");
  });

  test("a mode's left panel keeps its state across a mode round trip", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    const search = page.locator("[data-document-map-search]");
    await search.fill("2");
    await setMode(page, "content");
    await expect(search).toBeHidden();
    await setMode(page, "design");
    await expect(search).toBeVisible();
    await expect(search).toHaveValue("2");
  });

  test("a dock tab keeps its scroll position while another tab is on screen", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    await openPanel(page, "paged.keyboard-shortcuts");
    const scroller = page.locator(
      '[data-dock-panel="paged.keyboard-shortcuts"]',
    );
    await expect(scroller).toBeVisible();
    const scrolled = await scroller.evaluate((el) => {
      el.scrollTop = 400;
      return el.scrollTop;
    });
    expect(scrolled).toBeGreaterThan(0);
    await page.locator('[data-dock-tab="paged.properties"]').click();
    await expect(scroller).toBeHidden();
    await page.locator('[data-dock-tab="paged.keyboard-shortcuts"]').click();
    await expect(scroller).toBeVisible();
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollTop))
      .toBe(scrolled);
  });

  test("the viewport is kept, not remounted, under the Export mode", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    const canvas = page.locator("[data-paged-canvas]");
    await expect(canvas).toBeVisible();
    await canvas.evaluate((el) => el.setAttribute("data-kept", "1"));
    await setMode(page, "export");
    await expect(canvas).toBeHidden();
    await setMode(page, "design");
    await expect(canvas).toBeVisible();
    // The same element: the transferred canvas and its camera stayed.
    await expect(canvas).toHaveAttribute("data-kept", "1");
  });
});
