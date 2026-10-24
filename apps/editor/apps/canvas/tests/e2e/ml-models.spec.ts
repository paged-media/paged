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

// E2E — editor ADR 290 / extensions ADR 345 in the real editor:
//   · Edit ▸ Settings ▸ Models… opens Settings ▸ Models; where models run
//     and the cache's disk use show; with no local host the Tier-B section
//     says the local image model is not running (the dev server's /api/ml
//     route answers 503);
//   · the Tier-A test fixture installs through the consent dialog, runs in
//     the real ML worker (onnxruntime-web, bundled by Vite) through the ML
//     doors, and is removed;
//   · a fake local host behind /api/ml: "Check again" finds it ready, and
//     a bundle's `host.ml.generate` (ml.generate@1) is answered by it over
//     the same-origin route, job events and PNG included.

import { expect, test, type Page, type Route } from "@playwright/test";
import { PNG } from "pngjs";
import { covers } from "@paged-media/test-kit";

import { clickMenuRow, openShell } from "./harness/shell-surface";

const panel = (page: Page) => page.locator('[data-models-panel="ready"]');
const fixture = (page: Page) =>
  panel(page).locator('[data-ml-model="paged.fixture.matte"]');

async function openModels(page: Page) {
  await clickMenuRow(page, "Edit/Settings/Models…");
  await expect(panel(page)).toBeVisible();
}

/** A PNG of `w × h`, green. */
function greenPng(w: number, h: number): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) png.data.set([0, 200, 0, 255], i * 4);
  return PNG.sync.write(png);
}

/** A fake paged-ml-host behind the page's /api/ml route. */
async function fakeHost(page: Page): Promise<{ jobs: unknown[] }> {
  const jobs: unknown[] = [];
  await page.route("**/api/ml/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (p === "/api/ml/health")
      return json({
        ok: true,
        version: "0.1.0",
        api: 1,
        runtime: { binary: "/opt/sd", found: true },
        model: {
          id: "qwen-image-2.1",
          configured: true,
          licenceAcknowledged: true,
        },
        ready: true,
        capabilities: ["generate", "edit"],
        queue: { running: 0, queued: 0 },
      });
    if (p === "/api/ml/config")
      return json({ sdBinary: "/opt/sd", model: null });
    if (p === "/api/ml/jobs" && route.request().method() === "POST") {
      jobs.push(route.request().postDataJSON());
      return json({ id: `j${jobs.length}`, state: "queued" }, 202);
    }
    const m = /^\/api\/ml\/jobs\/(j\d+)\/(events|result)$/.exec(p);
    if (m?.[2] === "events")
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          `event: progress\ndata: {"step":1,"total":2}\n\n` +
          `event: progress\ndata: {"step":2,"total":2}\n\n` +
          `event: done\ndata: {"id":"${m[1]}","kind":"generate","state":"done","progress":{"step":2,"total":2}}\n\n`,
      });
    if (m?.[2] === "result")
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        body: greenPng(8, 4),
      });
    return json({ error: "no_job", message: "no such job" }, 404);
  });
  return { jobs };
}

test.describe("ML service — Settings ▸ Models and the ML doors", () => {
  test("Edit ▸ Settings ▸ Models…: install the fixture with consent, run it in the ML worker, remove it @feat:plugin-platform.ml-service @level:happy", async ({
    page,
  }) => {
    covers("menu:Edit/Settings/Models…", "panel:paged.models");
    await openShell(page, { doc: false });
    await openModels(page);
    await expect(panel(page).locator("[data-ml-gpu]")).not.toHaveAttribute(
      "data-ml-gpu",
      "checking",
    );
    await expect(panel(page).locator("[data-ml-host]")).toHaveAttribute(
      "data-ml-host",
      "down",
    );
    await expect(panel(page).locator("[data-ml-host]")).toContainText(
      "Local image model not running",
    );
    await expect(fixture(page)).toHaveAttribute("data-installed", "false");

    // Cancel installs nothing.
    await fixture(page).locator('[data-action="ml-install"]').click();
    const dialog = page.getByTestId("model-consent-dialog");
    await expect(dialog).toContainText("147 B");
    await page.getByTestId("model-consent-cancel").click();
    await expect(dialog).toHaveCount(0);
    await expect(fixture(page)).toHaveAttribute("data-installed", "false");

    await fixture(page).locator('[data-action="ml-install"]').click();
    await page.getByTestId("model-consent-install").click();
    await expect(fixture(page)).toHaveAttribute("data-installed", "true");
    await expect(fixture(page)).toHaveAttribute("data-healthy", "true");
    await expect(panel(page).locator("[data-ml-disk]")).not.toHaveAttribute(
      "data-ml-disk",
      "0",
    );

    // The real worker runs it (onnxruntime-web, wasm or WebGPU).
    await fixture(page).locator('[data-action="ml-try"]').click();
    await expect(fixture(page).locator("[data-ml-try-result]")).toHaveAttribute(
      "data-ml-try-result",
      "paged.ml.paged.fixture.matte",
      { timeout: 60_000 },
    );
    await expect(fixture(page).locator("[data-ml-status]")).toContainText(
      /WebGPU|wasm/,
    );

    await fixture(page).locator('[data-action="ml-remove"]').click();
    await expect(fixture(page)).toHaveAttribute("data-installed", "false");
    await expect(panel(page).locator("[data-ml-disk]")).toHaveAttribute(
      "data-ml-disk",
      "0",
    );
  });

  test("a bundle's ml.generate@1 is answered by the local host through /api/ml @feat:plugin-platform.ml-service @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.models");
    const host = await fakeHost(page);
    await openShell(page, { doc: false });
    await openModels(page);
    await panel(page).locator('[data-action="ml-check-host"]').click();
    await expect(panel(page).locator("[data-ml-host]")).toHaveAttribute(
      "data-ml-host",
      "ready",
    );

    await page.waitForFunction(
      () =>
        typeof (globalThis as unknown as { __loadTestBundle?: unknown })
          .__loadTestBundle === "function",
    );
    const answer = await page.evaluate(async () => {
      type Host = {
        supports(f: string): boolean;
        ml: {
          generate(
            r: { prompt: string; width: number; height: number },
            o: { onProgress(p: { step: number; total: number }): void },
          ): Promise<{
            provider: string;
            tier: string;
            model?: string;
            image: { width: number; height: number; data: Uint8ClampedArray };
          }>;
        };
      };
      let host: Host | null = null;
      (
        globalThis as unknown as { __loadTestBundle: (b: unknown) => unknown }
      ).__loadTestBundle({
        manifest: {
          id: "com.example.mltest",
          name: "ml test",
          version: "0.0.0",
          apiVersion: "^0.2",
          capabilities: { ml: ["generate"] },
        },
        activate(h: Host) {
          host = h;
          return { dispose() {} };
        },
      });
      const h = host as unknown as Host;
      const steps: number[] = [];
      const r = await h.ml.generate(
        { prompt: "a green card", width: 64, height: 64 },
        { onProgress: (p) => steps.push(p.step) },
      );
      return {
        supports: h.supports("ml.generate@1"),
        segment: h.supports("ml.segment@1"),
        provider: r.provider,
        tier: r.tier,
        model: r.model,
        size: [r.image.width, r.image.height],
        pixel: [...r.image.data.slice(0, 4)],
        steps,
      };
    });
    expect(answer).toEqual({
      supports: true,
      segment: false,
      provider: "paged.ml-host",
      tier: "B",
      model: "qwen-image-2.1",
      size: [8, 4],
      pixel: [0, 200, 0, 255],
      steps: [1, 2],
    });
    expect(host.jobs).toEqual([
      { kind: "generate", prompt: "a green card", width: 64, height: 64 },
    ]);
  });
});
