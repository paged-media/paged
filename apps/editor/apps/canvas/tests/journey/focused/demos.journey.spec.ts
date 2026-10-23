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
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// SOLO MODE — one plugin owns the whole application.
//
// WHY THE ASSERTIONS ARE SPREAD ACROSS SURFACES rather than checking one

// The embedding demos (docs/composable-editor-plan.md, H): host pages that
// mount the editor through `createEditor`. They are the example host of the
// host actions too: Submit in an actions bar reaches the host's `submit`.

import { test, expect } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

const ready = (page: import("@playwright/test").Page) =>
  expect(page.getByRole("status")).toContainText("ready", { timeout: 60_000 });

test.describe("journey · embedding demos", () => {
  test("the gallery links every demo @feat:editor-shell.solo-mode @level:happy", async ({
    page,
  }) => {
    await page.goto("/demos/index.html");
    await expect(page.locator("main.gallery a")).toHaveCount(10);
  });

  test("business card: fill a field, Submit hands the values to the host @feat:editor-shell.solo-mode @level:happy", async ({
    page,
  }) => {
    await page.goto("/demos/business-card.html");
    await ready(page);
    await expect(page.locator('[role="menubar"]')).toHaveCount(0);
    const input = page.locator('[data-field-input="name"]');
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill("Grace Example");
    await input.press("Enter");

    await page.locator('[data-region-command="paged.host.submit"]').click();
    const submitted = page.locator("[data-demo-submitted]");
    await expect(submitted).toContainText('"name": "Grace Example"', {
      timeout: 15_000,
    });
    await expect(page.getByText("Download business-card.paged")).toBeVisible();
  });

  test("custom host UI: the host's slot and Submit in its own actions bar @feat:editor-shell.solo-mode @level:happy", async ({
    page,
  }) => {
    await page.goto("/demos/custom-ui.html");
    await ready(page);
    await expect(page.locator("header.demo-header ~ * header")).toHaveCount(0);
    await expect(page.locator("[data-demo-price]")).toHaveText(
      "250 cards · 39.00",
    );
    covers("command:paged.host.submit");
    covers("command:paged.host.back");
    covers("command:paged.host.close");
    const run = (id: string) =>
      page.locator(`[data-region-command="${id}"]`).click();
    await run("paged.host.back");
    await expect(page.getByRole("status")).toHaveText("back to the shop");
    await run("paged.host.close");
    await expect(page.getByRole("status")).toHaveText(
      "closed without ordering",
    );
    await run("paged.host.submit");
    await expect(page.getByRole("status")).toHaveText("ordered: 250 cards");
  });

  test("postcard form: the host's form fills the template @feat:editor-shell.solo-mode @level:happy", async ({
    page,
  }) => {
    await page.goto("/demos/postcard-form.html");
    await ready(page);
    const headline = page.locator('[data-demo-field="headline"]');
    await headline.fill("Greetings from the coast");
    await headline.dispatchEvent("change");
    await expect(page.locator("[data-demo-problems]")).toHaveText("");
  });

  test("theme and language: the form speaks German, the host's accent applies @feat:editor-shell.solo-mode @level:happy", async ({
    page,
  }) => {
    await page.goto("/demos/theme-language.html");
    await ready(page);
    await page.locator("[data-demo-language]").selectOption("de");
    await expect(page.getByRole("status")).toHaveText("ready (de)", {
      timeout: 60_000,
    });
    await page.locator("[data-demo-accent]").selectOption("160 84% 30%");
    // On the editor's root element, not the host's page (plan task E1).
    expect(
      await page.evaluate(() => [
        document
          .querySelector<HTMLElement>("[data-paged-editor]")!
          .style.getPropertyValue("--paged-primary"),
        document.documentElement.style.getPropertyValue("--paged-primary"),
      ]),
    ).toEqual(["160 84% 30%", ""]);
    // The form in German: the card's empty picture field.
    await expect(page.locator('[data-field-picture="photo"]')).toHaveText(
      "Kein Bild",
    );
  });

  test("iframe: the host drives a framed editor through messages @feat:editor-shell.solo-mode @level:happy", async ({
    page,
  }) => {
    await page.goto("/demos/iframe.html");
    await ready(page);
    const messages = page.locator("[data-demo-messages]");
    await page.locator("[data-demo-set-name]").click();
    await expect(messages).toContainText("name set", { timeout: 15_000 });
    const frame = page.frameLocator("iframe");
    await expect(frame.locator('[data-field-input="name"]')).toHaveValue(
      "Mary Example",
      { timeout: 15_000 },
    );
    await frame.locator('[data-region-command="paged.host.submit"]').click();
    await expect(page.getByRole("status")).toHaveText("submitted");
    await expect(messages).toContainText('"Mary Example"');
  });
});
