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

// paged.slide's slide show (slide ADR 716, extensions ADR 345, editor ADR
// 304): F5 takes the deck full screen from its first slide with the
// editor's chrome gone; PowerPoint's keys move through it (next, previous,
// a number and Enter, black screen); Esc ends it and leaves the editor on
// the slide it ended on. Shift+F5 starts on the current slide. The same
// show and the Slide Sorter through the menus: Slide Show ▸ From
// Beginning / From Current Slide / Rehearse Timings (the time on each
// slide lands in its transition) and View ▸ Slide Sorter (the sorter in
// place of the canvas; a double-click opens a slide).

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import {
  clickEntry,
  closeMenus,
  installMenuProbe,
} from "../../plugin-surface/menu-driver";
import {
  activePage,
  focusEditor,
  goToSlide,
  openDeck,
  slideState,
} from "./slide-show-helpers";

const C = "media.paged.slide.command";
const show = (page: Page) => page.locator('[data-paged-presentation="show"]');
const stage = (page: Page) =>
  page.locator('[data-paged-presentation="show"] [data-show-stage]');

test.describe("journey · paged.slide slide show", () => {
  test("F5 shows the deck full screen; PowerPoint's keys move through it; Esc ends on the right slide @feat:plugin-slide.slideshow @level:happy", async ({
    page,
  }) => {
    covers(
      "command:media.paged.slide.command.slideShowFromBeginning",
      "keybinding:f5→media.paged.slide.command.slideShowFromBeginning",
    );
    const ids = await openDeck(page);
    await focusEditor(page);
    const menuBar = page.locator('nav[aria-label="Main menu"]');
    await expect(menuBar).toBeVisible();

    await page.keyboard.press("F5");
    await expect(show(page)).toBeVisible({ timeout: 15_000 });
    // The chrome is gone while the show runs.
    await expect(menuBar).toBeHidden();
    await expect(stage(page)).toHaveAttribute("data-slide-number", "1");
    // The slide is drawn from the engine's renderer.
    await expect(stage(page)).toHaveAttribute("data-frame", "drawn", {
      timeout: 20_000,
    });

    await page.keyboard.press("n");
    await expect(stage(page)).toHaveAttribute("data-slide-number", "2");
    await page.keyboard.press("ArrowRight");
    await expect(stage(page)).toHaveAttribute("data-slide-number", "3");
    await page.keyboard.press("Backspace");
    await expect(stage(page)).toHaveAttribute("data-slide-number", "2");
    // A number and Enter jumps.
    await page.keyboard.press("6");
    await page.keyboard.press("Enter");
    await expect(stage(page)).toHaveAttribute("data-slide-number", "6");
    // B blacks the screen, B again brings the slide back.
    await page.keyboard.press("b");
    await expect(stage(page)).toHaveAttribute("data-blank", "black");
    await page.keyboard.press("b");
    await expect(stage(page)).toHaveAttribute("data-blank", "");
    await page.keyboard.press("End");
    await expect(stage(page)).toHaveAttribute("data-slide-number", "10");
    await page.keyboard.press("Home");
    await expect(stage(page)).toHaveAttribute("data-slide-number", "1");
    await page.keyboard.press("PageDown");
    await page.keyboard.press("PageDown");
    await page.keyboard.press("PageDown");
    await expect(stage(page)).toHaveAttribute("data-slide-number", "4");

    // Esc ends the show: the chrome is back, on slide 4.
    await page.keyboard.press("Escape");
    await expect(show(page)).toHaveCount(0, { timeout: 10_000 });
    await expect(menuBar).toBeVisible();
    await expect.poll(() => activePage(page), { timeout: 10_000 }).toBe(ids[3]);
  });

  test("a slide's transition plays on WebGPU through the WGSL library, or cuts with a notice without it @feat:plugin-slide.slideshow @level:happy", async ({
    page,
  }) => {
    const ids = await openDeck(page);
    // Slide 2 gets a Push transition, as the Transition panel sets it.
    const set = await page.evaluate(async (pageId) => {
      const objects = (
        globalThis as unknown as {
          __canvas: {
            objects: {
              set(
                a: string,
                p: string,
                v: unknown,
              ): Promise<{ applied?: boolean }>;
            };
          };
        }
      ).__canvas.objects;
      return objects.set(
        `plugin:media.paged.slide/slide/${pageId}`,
        "transitionKind",
        "push",
      );
    }, ids[1]);
    expect(set).toMatchObject({ applied: true });
    await focusEditor(page);
    await page.keyboard.press("F5");
    await expect(stage(page)).toHaveAttribute("data-frame", "drawn", {
      timeout: 20_000,
    });
    // Give the show's device time to compile the shaders.
    await page.waitForTimeout(1500);
    await page.keyboard.press("n");
    await expect(stage(page)).toHaveAttribute("data-slide-number", "2");
    await expect(stage(page)).toHaveAttribute(
      "data-transition",
      /^(gpu:push|cut:no-webgpu)/,
      { timeout: 10_000 },
    );
    const how = await stage(page).getAttribute("data-transition");
    // The GPU lane (real Chrome with WebGPU) must play the shader.
    if (test.info().project.name === "journeys-gpu")
      expect(how).toMatch(/^gpu:push/);
    if (how?.startsWith("cut"))
      await expect(
        show(page).locator('[data-show-notice="no-webgpu"]'),
      ).toBeVisible();
    test
      .info()
      .annotations.push({ type: "transition", description: how ?? "" });
    await page.keyboard.press("Escape");
    await expect(show(page)).toHaveCount(0, { timeout: 10_000 });
  });

  test("Shift+F5 starts on the current slide @feat:plugin-slide.slideshow @level:happy", async ({
    page,
  }) => {
    covers(
      "command:media.paged.slide.command.slideShowFromCurrent",
      "keybinding:shift+f5→media.paged.slide.command.slideShowFromCurrent",
    );
    const ids = await openDeck(page);
    await goToSlide(page, ids[2]);
    await focusEditor(page);
    await page.keyboard.press("Shift+F5");
    await expect(stage(page)).toHaveAttribute("data-slide-number", "3", {
      timeout: 15_000,
    });
    await page.keyboard.press("Escape");
    await expect(show(page)).toHaveCount(0, { timeout: 10_000 });
  });

  test("the Slide Show menu and View ▸ Slide Sorter @feat:plugin-slide.slide-sorter @level:happy", async ({
    page,
  }) => {
    covers(
      "menu:Slide Show/From Beginning",
      "menu:Slide Show/From Current Slide",
      "menu:Slide Show/Rehearse Timings",
      "menu:View/Slide Sorter",
      "command:media.paged.slide.command.rehearseTimings",
      "command:media.paged.slide.command.slideSorter",
    );
    const ids = await openDeck(page);
    await installMenuProbe(page);

    // Slide Show ▸ From Beginning.
    await clickEntry(
      page,
      "Slide Show/From Beginning",
      `${C}.slideShowFromBeginning`,
    );
    await expect(stage(page)).toHaveAttribute("data-slide-number", "1");
    await page.keyboard.press("Escape");
    await expect(show(page)).toHaveCount(0, { timeout: 10_000 });

    // Slide Show ▸ From Current Slide.
    await goToSlide(page, ids[4]);
    await clickEntry(
      page,
      "Slide Show/From Current Slide",
      `${C}.slideShowFromCurrent`,
    );
    await expect(stage(page)).toHaveAttribute("data-slide-number", "5");
    await page.keyboard.press("Escape");
    await expect(show(page)).toHaveCount(0, { timeout: 10_000 });

    // Slide Show ▸ Rehearse Timings: the time on each slide lands in its
    // transition.
    await clickEntry(
      page,
      "Slide Show/Rehearse Timings",
      `${C}.rehearseTimings`,
    );
    await expect(show(page).locator("[data-show-typed]")).toContainText("0:0");
    await page.waitForTimeout(300);
    await page.keyboard.press("n");
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await expect(show(page)).toHaveCount(0, { timeout: 10_000 });
    await expect
      .poll(
        async () => (await slideState(page, ids[0])).transition?.advanceAfterMs,
        {
          timeout: 10_000,
        },
      )
      .toBeGreaterThan(0);

    // View ▸ Slide Sorter: the sorter in place of the canvas.
    await clickEntry(page, "View/Slide Sorter", `${C}.slideSorter`);
    const sorter = page.locator('[data-slide-sorter="ready"]');
    await expect(sorter).toBeVisible({ timeout: 10_000 });
    await expect(sorter.locator("[data-sorter-slide]")).toHaveCount(10);
    await expect(sorter.locator("[data-sorter-slide] img")).toHaveCount(10, {
      timeout: 30_000,
    });
    // Select slide 7 and hide it: one edit on the document.
    await sorter.locator(`[data-sorter-slide="${ids[6]}"]`).click();
    await sorter.locator('[data-sorter="hide"]').click();
    await expect
      .poll(async () => (await slideState(page, ids[6])).hidden)
      .toBe(true);
    // A double-click opens slide 8 in the normal view.
    await sorter.locator(`[data-sorter-slide="${ids[7]}"]`).dblclick();
    await expect(sorter).toHaveCount(0);
    await expect.poll(() => activePage(page), { timeout: 10_000 }).toBe(ids[7]);
    await closeMenus(page);
  });
});
