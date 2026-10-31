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

// paged.slide's presenter view (slide ADR 716, extensions ADR 345, editor
// ADR 305): Alt+F5 opens the audience window and turns the editor's window
// into the presenter console. Next in the console advances the audience
// (over the presentation's BroadcastChannel); a key pressed in the
// audience window comes back to the console; the console shows the next
// slide and the notes; End show closes the audience window. The menu entry
// Slide Show ▸ Presenter View does the same.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { clickEntry, installMenuProbe } from "../../plugin-surface/menu-driver";
import { focusEditor, openDeck } from "./slide-show-helpers";

const consoleRoot = (page: Page) =>
  page.locator('[data-paged-presentation="console"]');
const audienceStage = (popup: Page) =>
  popup.locator('[data-paged-presentation="audience"] [data-show-stage]');

test.describe("journey · paged.slide presenter view", () => {
  test("Alt+F5 opens the audience window; the console drives it @feat:plugin-slide.slideshow @level:happy", async ({
    page,
    context,
  }) => {
    covers(
      "command:media.paged.slide.command.presenterView",
      "keybinding:alt+f5→media.paged.slide.command.presenterView",
    );
    const ids = await openDeck(page);
    await focusEditor(page);

    const popupOpened = context.waitForEvent("page");
    await page.keyboard.press("Alt+F5");
    const popup = await popupOpened;
    await expect(consoleRoot(page)).toBeVisible({ timeout: 15_000 });
    await expect(audienceStage(popup)).toHaveAttribute(
      "data-slide-number",
      "1",
      {
        timeout: 15_000,
      },
    );
    // The console: slide x of y, the next slide, the notes.
    await expect(
      consoleRoot(page).locator('[data-presenter="position"]'),
    ).toContainText("1");
    await expect(
      consoleRoot(page).locator('[data-presenter="next-preview"]'),
    ).toHaveAttribute("data-page-id", ids[1]);
    await expect(
      consoleRoot(page).locator('[data-presenter="notes"]'),
    ).toBeVisible();

    // Next in the console advances the audience.
    await page.keyboard.press("n");
    await expect(audienceStage(popup)).toHaveAttribute(
      "data-slide-number",
      "2",
    );
    await consoleRoot(page).locator('[data-presenter="next"]').click();
    await expect(audienceStage(popup)).toHaveAttribute(
      "data-slide-number",
      "3",
    );
    // A key pressed in the audience window comes back to the console.
    await popup.locator('[data-paged-presentation="audience"]').focus();
    await popup.keyboard.press("p");
    await expect(audienceStage(popup)).toHaveAttribute(
      "data-slide-number",
      "2",
    );
    await expect(
      consoleRoot(page).locator("[data-presenter-view]"),
    ).toHaveAttribute("data-slide-index", "1");
    // Black screen from the console blanks the audience.
    await consoleRoot(page).locator('[data-presenter="black"]').click();
    await expect(audienceStage(popup)).toHaveAttribute("data-blank", "black");

    // End show closes the audience window and gives the editor back.
    const closed = popup.waitForEvent("close");
    await consoleRoot(page).locator('[data-presenter="end"]').click();
    await closed;
    await expect(consoleRoot(page)).toHaveCount(0);
    await expect(page.locator('nav[aria-label="Main menu"]')).toBeVisible();
  });

  test("Slide Show ▸ Presenter View from the menu @feat:plugin-slide.slideshow @level:happy", async ({
    page,
    context,
  }) => {
    covers("menu:Slide Show/Presenter View");
    await openDeck(page);
    await installMenuProbe(page);
    const popupOpened = context.waitForEvent("page");
    await clickEntry(
      page,
      "Slide Show/Presenter View",
      "media.paged.slide.command.presenterView",
    );
    const popup = await popupOpened;
    await expect(audienceStage(popup)).toHaveAttribute(
      "data-slide-number",
      "1",
      {
        timeout: 15_000,
      },
    );
    const closed = popup.waitForEvent("close");
    await page.keyboard.press("Escape");
    await closed;
    await expect(consoleRoot(page)).toHaveCount(0);
  });
});
