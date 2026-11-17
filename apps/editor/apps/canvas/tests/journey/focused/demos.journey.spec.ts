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

type Page = import("@playwright/test").Page;

// The demo's own status line, in the host page's header. Not every status
// on the page: while a document loads, each editor's canvas shows its
// stages in a polite live region of its own (editor ADR 1208, progressive
// loading), so the page holds one status per editor besides the host's.
const status = (page: Page) =>
  page.locator("header.demo-header").getByRole("status");

const ready = (page: Page) =>
  expect(status(page)).toContainText("ready", { timeout: 60_000 });

test.describe("journey · embedding demos", () => {
  test("the gallery links every demo @feat:editor-shell.solo-mode @level:happy", async ({
    page,
  }) => {
    await page.goto("/demos/index.html");
    await expect(page.locator("main.gallery a")).toHaveCount(14);
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
    await expect(status(page)).toHaveText("back to the shop");
    await run("paged.host.close");
    await expect(status(page)).toHaveText("closed without ordering");
    await run("paged.host.submit");
    await expect(status(page)).toHaveText("ordered: 250 cards");
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
    await expect(status(page)).toHaveText("ready (de)", {
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
    await expect(status(page)).toHaveText("submitted");
    await expect(messages).toContainText('"Mary Example"');
    // Scripts reach the frame too (dev and demo builds).
    await page.locator("[data-demo-run-script]").click();
    await expect(messages).toContainText("pages: 1");
  });

  test("docs lab: a viewer frame with an editing role, on a seed, writes by script and fits the view @feat:scripting.docs-playground-seeds @level:happy", async ({
    page,
  }) => {
    // The docs' scripting lab drives embed.html through connectEditor
    // (editor ADR 212, amendment 1): the viewer's chrome, role editor (the
    // viewer role changes nothing, scripts included), a seed document.
    await page.route("**/__lab/host.html", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        headers: {
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "credentialless",
        },
        body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>lab</title></head><body style="margin:0"></body></html>',
      }),
    );
    await page.goto("/__lab/host.html");
    const lab = await page.evaluate(async () => {
      // A variable, so the spec's own compiler does not resolve the module
      // the dev server answers.
      const url = "/src/embed/connect.ts";
      const { connectEditor } = await import(/* @vite-ignore */ url);
      const open = (config: Record<string, unknown>) => {
        const frame = document.createElement("iframe");
        frame.src = "/embed.html";
        frame.style.cssText = "width:1000px;height:640px;border:0";
        document.body.append(frame);
        return connectEditor(frame, config);
      };
      const editor = await open({
        profile: "viewer",
        role: "editor",
        seed: "one-text-frame-selected",
      });
      const fill =
        'const [el] = JSON.parse(paged.selection()); console.log(JSON.parse(paged.get(el.kind + ":" + el.id, "frameFillColor")).value);';
      const before = (await editor.runScript(fill)).output.join(" ");
      const wrote = await editor.runScript(
        'const [el] = JSON.parse(paged.selection()); paged.set(el.kind + ":" + el.id, "frameFillColor", "Color/Red");',
      );
      const after = (await editor.runScript(fill)).output.join(" ");
      await editor.fitSelection();
      // An unknown seed refuses with its code, before anything mounts.
      const refused = await open({
        profile: "viewer",
        seed: "no-such-seed",
      }).then(
        () => null,
        (e: { code?: string }) => e.code ?? String(e),
      );
      return { before, error: wrote.error, after, refused };
    });
    expect(lab.before).not.toContain("Color/Red");
    expect(lab.error).toBeNull();
    expect(lab.after).toContain("Color/Red");
    expect(lab.refused).toBe("unknownSeed");
    const frame = page.frameLocator("iframe").first();
    await expect(frame.locator("[data-paged-viewport]").first()).toBeVisible();
    await expect(frame.locator('[role="menubar"]')).toHaveCount(0);
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
    await expect(status(page)).toHaveText("ready: the left editor again", {
      timeout: 60_000,
    });
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
  test("price list: module fields fill through their modules, the rest is refused @feat:editor-shell.solo-mode @level:happy", async ({
    page,
  }) => {
    await page.goto("/demos/price-list.html");
    await ready(page);
    const values = page.locator("[data-demo-values]");
    await expect(values).toContainText('"offer": "Figs"', { timeout: 30_000 });

    // paged.sheet: a cell (a choice) and a range (a table).
    await page.locator('[data-field-input="offer"]').selectOption("Pears");
    await expect(values).toContainText('"offer": "Pears"', { timeout: 15_000 });
    const price = page.locator('[data-field-cell="prices:3:1"]');
    await price.fill("7.25");
    await price.blur();
    await expect(values).toContainText('"7.25"', { timeout: 15_000 });

    // paged.doc: the bookmarked paragraph of the placed Word document.
    const note = page.locator('[data-field-input="note"]');
    await note.fill("Prices per kilogram.");
    await note.press("Enter");
    await expect(values).toContainText('"note": "Prices per kilogram."', {
      timeout: 15_000,
    });

    // paged.draw: the band's fill, one of the template's swatches.
    await page
      .locator('[data-field-input="accent"]')
      .selectOption({ label: "Berry" });
    await expect(values).toContainText("Berry", { timeout: 15_000 });
    await expect(page.locator("[data-field-problem]")).toHaveCount(0);

    // Outside the fields the engine refuses the filler.
    await page.locator("[data-demo-try-title]").click();
    await expect(page.locator("[data-demo-refusal]")).toContainText("refused", {
      timeout: 15_000,
    });
  });

  test("print-ready PDF: the checks list findings, an error blocks the export, a PDF/X-4 comes out @feat:editor-shell.solo-mode @level:happy", async ({
    page,
  }) => {
    await page.goto("/demos/print-pdf.html");
    await ready(page);
    const verdict = page.locator("[data-demo-verdict]");
    await page.locator("[data-demo-check]").click();
    await expect(verdict).toContainText("ready to print", { timeout: 30_000 });

    // A name too long for its line: listed as an error, and Submit exports
    // nothing.
    const name = page.locator('[data-field-input="name"]');
    await expect(name).toBeVisible({ timeout: 15_000 });
    await name.fill("Maximiliane Alexandra Rosenkranz");
    await name.press("Enter");
    const submit = page.locator('[data-region-command="paged.host.submit"]');
    await submit.click();
    await expect(
      page.locator('[data-demo-findings] [data-demo-finding="error"]'),
    ).toContainText("Name does not fit", { timeout: 30_000 });
    await expect(page.locator("[data-demo-pdf]")).toContainText("Not exported");

    await name.fill("Grace Example");
    await name.press("Enter");
    await submit.click();
    const link = page.getByText("Download business-card.pdf");
    await expect(link).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("[data-demo-pdf]")).toContainText("PDF/X-4");
    const pdf = await link.evaluate(async (a) => {
      const bytes = new Uint8Array(
        await (await fetch((a as HTMLAnchorElement).href)).arrayBuffer(),
      );
      let text = "";
      for (const b of bytes) text += String.fromCharCode(b);
      return text;
    });
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf).toContain("/OutputIntent");
    expect(pdf).toContain("GTS_PDFX");
  });
});
