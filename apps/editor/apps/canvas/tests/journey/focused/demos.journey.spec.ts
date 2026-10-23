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
    await expect(page.locator("main.gallery a")).toHaveCount(11);
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
    // Scripts reach the frame too (dev and demo builds).
    await page.locator("[data-demo-run-script]").click();
    await expect(messages).toContainText("pages: 1");
  });

  test("two editors on one page: each fills, submits and answers its own keys @feat:editor-shell.solo-mode @level:happy", async ({
    page,
  }) => {
    await page.goto("/demos/two-editors.html");
    await ready(page);
    const left = page.locator('[data-demo-editor="left"]');
    const right = page.locator('[data-demo-editor="right"]');
    // Two roots, nothing of either written on the host's page.
    await expect(page.locator("[data-paged-editor]")).toHaveCount(2);
    expect(
      await page.evaluate(() => ({
        html: document.documentElement.getAttribute("class"),
        style: document.documentElement.getAttribute("style"),
        body: document.body.getAttribute("style"),
        canvas: "__canvas" in globalThis,
      })),
    ).toEqual({ html: null, style: null, body: null, canvas: false });

    const name = (side: typeof left) =>
      side.locator('[data-field-input="name"]');
    await expect(name(left)).toBeVisible({ timeout: 15_000 });
    await expect(name(right)).toBeVisible({ timeout: 15_000 });
    await name(left).fill("Ada Example");
    await name(left).press("Enter");
    await name(right).fill("Grace Example");
    await name(right).press("Enter");
    // The left field keeps its value: the right editor wrote its own.
    await expect(name(left)).toHaveValue("Ada Example");

    await left.locator('[data-region-command="paged.host.submit"]').click();
    await right.locator('[data-region-command="paged.host.submit"]').click();
    const submitted = (side: string) =>
      page.locator(`[data-demo-submitted="${side}"]`);
    await expect(submitted("left")).toContainText('"name": "Ada Example"', {
      timeout: 15_000,
    });
    await expect(submitted("right")).toContainText('"name": "Grace Example"', {
      timeout: 15_000,
    });
    await expect(submitted("left")).not.toContainText("Grace");
    await expect(submitted("right")).not.toContainText("Ada");

    // Undo in the right editor's field undoes the right editor's fill only.
    await name(right).click();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(name(left)).toHaveValue("Ada Example");
  });

  test("an editor disposed and mounted again in place works, and leaves nothing behind @feat:editor-shell.solo-mode @level:happy", async ({
    page,
  }) => {
    await page.goto("/demos/two-editors.html");
    await ready(page);
    const left = page.locator('[data-demo-editor="left"]');
    const right = page.locator('[data-demo-editor="right"]');
    await right.locator('[data-field-input="name"]').fill("Grace Example");
    await right.locator('[data-field-input="name"]').press("Enter");

    await page.locator("[data-demo-remount]").click();
    await expect(page.getByRole("status")).toHaveText(
      "ready: the left editor again",
      { timeout: 60_000 },
    );
    // One root per editor: the disposed one is gone, not stacked.
    await expect(left.locator("[data-paged-editor]")).toHaveCount(1);
    await expect(page.locator("[data-paged-editor]")).toHaveCount(2);
    const name = left.locator('[data-field-input="name"]');
    await expect(name).toBeVisible({ timeout: 15_000 });
    await name.fill("Ada Again");
    await name.press("Enter");
    await left.locator('[data-region-command="paged.host.submit"]').click();
    await expect(page.locator('[data-demo-submitted="left"]')).toContainText(
      '"name": "Ada Again"',
      { timeout: 15_000 },
    );
    // The other editor kept its document through the remount.
    await expect(right.locator('[data-field-input="name"]')).toHaveValue(
      "Grace Example",
    );
  });
});
