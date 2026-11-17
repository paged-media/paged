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

// The editor as a host embeds it (docs/composable-editor.md §8; editor ADR
// 212, amendment 1), for the docs' embedding, template and scripting pages
// and the live demos' posters:
//
//   · profile-full, profile-solo-draw, profile-template-fill, profile-viewer:
//     `createEditor` with each preset, on a page of the stills' own;
//   · template-filler: the template-fill session, fields being filled;
//   · lab-<theme>: the docs scripting lab's result posters, through
//     `connectEditor` over embed.html exactly as the lab drives it: the
//     viewer profile with an editing role, the theme's seed, its script,
//     `fitSelection`, then only the canvas captured;
//   · demo-draw-live, demo-draw-fill, demo-tour: the end of each live script
//     the website's and the docs' LiveDemo embed (`?script=<id>&embed&autoplay`).
//
// Recorded locally (PAGED_MEDIA_ROOT), dark like every still (kit.ts).

import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dressStage } from "../kit/stage";
import { FONTS, park, ROOT, seasoned, shot, STILL_VIEW } from "./kit";
import { LAB_THEMES } from "./lab-themes";

test.skip(!ROOT, "PAGED_MEDIA_ROOT is not set (stills are captured locally)");
test.use({
  viewport: STILL_VIEW,
  deviceScaleFactor: 2,
  colorScheme: "dark",
});

/** What @vitejs/plugin-react's dev server puts in every page it serves
 *  (vite's backend-integration recipe). */
const REACT_PREAMBLE = `import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;`;

/** A host page of the stills' own, cross-origin isolated as an embedding
 *  host must be, with the faces the stills' documents use. */
async function host(page: Page, body: string): Promise<void> {
  await dressStage(page);
  await seasoned(page);
  await page.route("**/__stills/host.html", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "credentialless",
      },
      // The dev server's React preamble, which it writes into the pages it
      // serves itself: the editor's modules expect it.
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>stills host</title><script type="module">${REACT_PREAMBLE}</script><style>html,body{margin:0;height:100%;background:#0e0e12;overflow:hidden}#host,#frame{position:fixed;inset:0;width:100%;height:100%;border:0}</style></head><body>${body}</body></html>`,
    }),
  );
  await page.route("**/__stills/fonts/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "font/ttf",
      body: readFileSync(
        join(
          FONTS,
          decodeURIComponent(
            route.request().url().split("/__stills/fonts/")[1],
          ),
        ),
      ),
    }),
  );
  await page.goto("/__stills/host.html");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
}

/** `createEditor` into the host page; the handle stays on `window.__still`. */
async function embed(
  page: Page,
  config: Record<string, unknown>,
  build?: "businessCard" | "drawing",
  role?: string,
): Promise<void> {
  await host(page, '<div id="host"></div>');
  await page.evaluate(
    async ({ config, build, role, drawing }) => {
      // Module specifiers the dev server answers; variables, so the test's
      // own compiler does not resolve them.
      const embedUrl = "/src/embed/index.ts";
      const templatesUrl = "/src/demos/templates.ts";
      const { createEditor } = await import(/* @vite-ignore */ embedUrl);
      const element = document.getElementById("host")!;
      // The page's own storage, where the stills' settings are (seasoned).
      const editor = await createEditor(element, {
        ...config,
        storage: "local",
      });
      (window as unknown as { __still: unknown }).__still = editor;
      for (const [family, file] of [
        ["Inter", "Inter.ttf"],
        ["Fraunces", "Fraunces-VF.ttf"],
      ]) {
        const res = await fetch(`/__stills/fonts/${file}`);
        await editor.client.registerFont(
          family,
          new Uint8Array(await res.arrayBuffer()),
          null,
        );
      }
      if (build === "businessCard") {
        const t = await import(/* @vite-ignore */ templatesUrl);
        await t.businessCard(editor);
      }
      if (build === "drawing") {
        const r = await editor.client.executeScript(drawing);
        if (r.error) throw new Error(r.error);
      }
      if (role) await editor.setRole(role);
    },
    { config, build: build ?? null, role: role ?? null, drawing: DRAWING },
  );
  await page.waitForTimeout(2500);
}

/** A drawing for the solo draw profile: shapes from the playground's
 *  draw-live script, by `paged.*`, on the profile's own artboard. */
const DRAWING = `for (const [selfId, name, rgb] of [
  ["Color/Rose", "Rose", [244, 127, 192]],
  ["Color/Violet", "Violet", [169, 139, 245]],
  ["Color/Mint", "Mint", [111, 220, 155]],
]) paged.createSwatch({ selfId, name, space: "RGB", value: rgb, model: "Process" });
const pid = JSON.parse(paged.pages())[0].selfId;
[[300, 300, 900, 900, "Color/Rose"], [520, 760, 1120, 1360, "Color/Violet"], [1000, 400, 1500, 900, "Color/Mint"], [1100, 1150, 1700, 1750, "Color/Rose"]]
  .forEach(([t, l, b, r, fill]) => {
    const f = paged.insertFrame(pid, [t, l, b, r]);
    paged.set(f, "frameFillColor", fill);
    paged.set(f, "frameCornerOptionTopLeft", "RoundedCorner");
    paged.set(f, "frameCornerOptionTopRight", "RoundedCorner");
    paged.set(f, "frameCornerOptionBottomLeft", "RoundedCorner");
    paged.set(f, "frameCornerOptionBottomRight", "RoundedCorner");
    paged.set(f, "frameCornerRadiusTopLeft", 96);
    paged.set(f, "frameCornerRadiusTopRight", 96);
    paged.set(f, "frameCornerRadiusBottomLeft", 96);
    paged.set(f, "frameCornerRadiusBottomRight", 96);
  });
paged.clearSelection();`;

/** What the embedded editor's handle answers. */
const still = <T>(page: Page, fn: string) =>
  page.evaluate(
    (src) =>
      new Function("e", `return (${src})(e)`)(
        (window as unknown as { __still: unknown }).__still,
      ),
    fn,
  ) as Promise<T>;

// ── The four presets a host embeds (docs: embedding/profiles-and-presets). ──

test("stills · profile-full", async ({ page }) => {
  test.setTimeout(240_000);
  await embed(page, { profile: "full" }, "businessCard", "editor");
  await expect(page.locator('[role="menubar"]')).toBeVisible();
  await park(page);
  await shot(page, "profile-full", {
    shows:
      'createEditor({ profile: "full" }): the whole editor, the business-card template open',
    profile: "full",
    document: "business card (src/demos/templates.ts)",
  });
});

test("stills · profile-solo-draw", async ({ page }) => {
  test.setTimeout(240_000);
  await embed(page, { profile: "solo:draw" }, "drawing");
  await expect(page.locator('[data-tool-slot="pen"]').first()).toBeVisible();
  await park(page);
  await shot(page, "profile-solo-draw", {
    shows:
      'createEditor({ profile: "solo:draw" }): paged.draw alone, four live-cornered shapes on its artboard',
    profile: "solo:draw",
  });
});

test("stills · profile-template-fill", async ({ page }) => {
  test.setTimeout(240_000);
  await embed(page, { profile: "template-fill" }, "businessCard", "filler");
  await expect(page.locator('[data-field-input="name"]')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('[role="menubar"]')).toHaveCount(0);
  await park(page);
  await shot(page, "profile-template-fill", {
    shows:
      'createEditor({ profile: "template-fill" }): the card and its form, a filler\'s session',
    profile: "template-fill",
    role: "filler",
    document: "business card (src/demos/templates.ts)",
  });
});

test("stills · profile-viewer", async ({ page }) => {
  test.setTimeout(240_000);
  await embed(page, { profile: "viewer" }, "businessCard", "viewer");
  await expect(page.locator('[role="menubar"]')).toHaveCount(0);
  await park(page);
  await shot(page, "profile-viewer", {
    shows:
      'createEditor({ profile: "viewer" }): the canvas and its pages, nothing to change',
    profile: "viewer",
    role: "viewer",
    document: "business card (src/demos/templates.ts)",
  });
});

// ── template-filler (docs: templates/filling): fields being filled. ──

test("stills · template-filler", async ({ page }) => {
  test.setTimeout(240_000);
  await embed(page, { profile: "template-fill" }, "businessCard", "filler");
  const name = page.locator('[data-field-input="name"]');
  await expect(name).toBeVisible({ timeout: 15_000 });
  await name.fill("Grace Example");
  await name.press("Enter");
  const title = page.locator('[data-field-input="title"]');
  await title.fill("Production editor");
  await title.press("Enter");
  await expect
    .poll(() =>
      still<Record<string, { kind: string; text?: string }>>(
        page,
        "(e) => e.getFieldValues()",
      ),
    )
    .toMatchObject({
      name: { kind: "text", text: "Grace Example" },
      title: { kind: "text", text: "Production editor" },
    });
  // The e-mail field focused: its outline on the card is the current one.
  await page.locator('[data-field-input="email"]').focus();
  await park(page);
  await page.waitForTimeout(1200);
  await shot(page, "template-filler", {
    shows:
      "a filler's session: the form with two fields filled and the e-mail field focused, the field outlines on the card",
    profile: "template-fill",
    role: "filler",
    values: { name: "Grace Example", title: "Production editor" },
  });
});

// ── lab-<theme>: the docs scripting lab's result posters. ──

for (const theme of LAB_THEMES) {
  test(`stills · lab-${theme.id}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await host(page, "");
    const out = await page.evaluate(
      async ({ seed, source }) => {
        const connectUrl = "/src/embed/connect.ts";
        const { connectEditor } = await import(/* @vite-ignore */ connectUrl);
        const frame = document.createElement("iframe");
        frame.id = "frame";
        frame.src = "/embed.html";
        frame.allow = "cross-origin-isolated";
        document.body.append(frame);
        const lab = await connectEditor(frame, {
          profile: "viewer",
          // The viewer role changes nothing, scripts included.
          role: "editor",
          seed,
        });
        const r = await lab.runScript(source);
        // A new document's own fit to its page can land after the first call
        // (the docs lab fits twice for the same reason).
        await lab.fitSelection();
        await new Promise((res) => setTimeout(res, 300));
        await lab.fitSelection();
        // The poster shows the result, not the selection's handles.
        await lab.runScript("paged.clearSelection()");
        return r as { output: string[]; error: string | null };
      },
      { seed: theme.seed, source: theme.script },
    );
    expect(out.error, `${theme.id}: the script runs`).toBeNull();
    const frame = page.frameLocator("#frame");
    const view = frame.locator("[data-paged-viewport]").first();
    await expect(view).toBeVisible();
    // The Hand, from the viewer's own rail, as a reader takes it to look
    // around: the Selection tool's modifier hints (shown on a fresh
    // editor's first uses) leave the canvas.
    await frame.locator('[data-tool-slot="hand"]').first().click();
    await expect(frame.locator("[data-modifier-hints]")).toHaveCount(0);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(2000);
    await shot(
      page,
      `lab-${theme.id}`,
      {
        shows: `the docs scripting lab, theme ${theme.title}: seed ${theme.seed}, its script run, fitted to the selection`,
        seed: theme.seed,
        output: out.output,
        profile: "viewer",
      },
      view,
    );
  });
}

// ── demo-<script>: the live demos' end states (LiveDemo posters). ──

for (const id of ["draw-live", "draw-fill", "tour"]) {
  test(`stills · demo-${id}`, async ({ page }) => {
    test.setTimeout(180_000);
    await dressStage(page);
    await seasoned(page);
    await page.goto(`/?script=${id}&embed&autoplay`);
    const chip = page.locator("[data-playground-status]");
    await expect(chip).toHaveAttribute(
      "data-playground-status",
      /playing|done/,
      { timeout: 60_000 },
    );
    const advance = page.locator("[data-demo-advance]");
    await expect
      .poll(
        async () => {
          const status = await chip.getAttribute("data-playground-status");
          if (status === "error")
            throw new Error(
              `${id}: ${await chip.getAttribute("data-playground-error")}`,
            );
          // A step that waits for its reader is advanced, as a reader would.
          if (status !== "done" && (await advance.isVisible()))
            await advance.click().catch(() => {});
          return status;
        },
        { timeout: 120_000, intervals: [700] },
      )
      .toBe("done");
    await page.mouse.move(2, STILL_VIEW.height - 2);
    await page.waitForTimeout(1500);
    await shot(page, `demo-${id}`, {
      shows: `the end of the live script ${id} (?script=${id}&embed&autoplay)`,
      script: id,
    });
  });
}
