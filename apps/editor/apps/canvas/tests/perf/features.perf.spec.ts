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

// The React 19 features' probe (apps/editor ADR 240,
// docs/migration/react-19-features.md): the shell interactions the features
// change, each driven the same number of times and measured like the panel
// probe (./probe.ts: next frame, settled, commits, renders, listeners):
//
//   - canvas pan: wheel steps over the canvas (the viewport re-renders with
//     the camera; its window listeners must not re-subscribe);
//   - dock tab switch: the right dock's tabs, round robin;
//   - chrome toggle: Tab hides the panels and the rail, Tab shows them;
//   - mode round trip: Design → Export → Design;
//   - memory: JS heap and DOM counters after the switches (CDP, after a GC);
//   - long page list: the Pages panel over a 60-page document, how many
//     thumbnails it decodes and how long it takes to settle (ADR 240: they
//     are shown as they come near the panel's view);
//   - boot: the fetch priority Chromium gave the lazy bundle chunks and the
//     engine wasm, whether any module preload carries a `fetchpriority`,
//     and the time to the boot lane settling (ADR 222);
//   - canvas resize: frames from a window resize until the canvas overlay is
//     sized to the viewport again (React 19 lands the ResizeObserver's
//     update in the next frame; before the overlay read the size during
//     render and kept the old one until something else re-rendered).
//
// Run against the production build like the panel probe
// (docs/migration/react-compiler.md has the commands). Numbers, not
// assertions.

import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";

import {
  OUT,
  ROUNDS,
  installInputProbe,
  resetProbe,
  sample,
  seed,
  summarize,
  type Sample,
} from "./probe";
import { installRenderCounter } from "./render-counter";

const results: Record<string, Sample[]> = {};
const memory: Record<string, unknown> = {};

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript({
    content: `(${installRenderCounter.toString()})(globalThis);(${installInputProbe.toString()})(globalThis);`,
  });
});

test.afterAll(() => {
  const summary = Object.entries(results).map(([k, v]) => summarize(k, v));
  console.log(`PERF ${JSON.stringify(summary)}`);
  console.log(`MEMORY ${JSON.stringify(memory)}`);
  if (OUT) {
    writeFileSync(
      OUT,
      `${JSON.stringify({ summary, memory, results }, null, 2)}\n`,
    );
  }
});

/** JS heap after a full GC, and the renderer's DOM counters (CDP). */
async function measureMemory(page: Page): Promise<{
  heapUsedMB: number;
  nodes: number;
  listeners: number;
}> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.collectGarbage");
  const heap = (await cdp.send("Runtime.getHeapUsage")) as {
    usedSize: number;
  };
  const dom = (await cdp.send("Memory.getDOMCounters")) as {
    nodes: number;
    jsEventListeners: number;
  };
  await cdp.detach();
  return {
    heapUsedMB: +(heap.usedSize / 1024 / 1024).toFixed(1),
    nodes: dom.nodes,
    listeners: dom.jsEventListeners,
  };
}

test("canvas pan", async ({ page }) => {
  await seed(page);
  const canvas = page.locator("[data-paged-canvas]");
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const out: Sample[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    await resetProbe(page);
    await page.evaluate(() =>
      (
        globalThis as unknown as { __pagedProbe: { mark(): void } }
      ).__pagedProbe.mark(),
    );
    await page.mouse.wheel(0, i % 2 === 0 ? 120 : -120);
    out.push(await sample(page));
  }
  results["canvas pan"] = out;
});

test("dock tab switch", async ({ page }) => {
  const { d } = await seed(page);
  const ids = ["paged.properties", "paged.swatches", "paged.layers"];
  for (const id of ids) await d.openPanel(id);
  const tab = (id: string) => page.locator(`[data-dock-tab="${id}"]`);
  await expect(tab(ids[2]!)).toBeVisible();
  const out: Sample[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    await resetProbe(page);
    await tab(ids[i % ids.length]!).click();
    out.push(await sample(page));
  }
  results["dock tab switch"] = out;
  memory["after tab switches"] = await measureMemory(page);
});

test("chrome toggle", async ({ page }) => {
  await seed(page);
  const canvas = page.locator("[data-paged-canvas]");
  await expect(canvas).toBeVisible();
  // Tab is the canvas's: focus nothing that takes it.
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  const out: Sample[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    await resetProbe(page);
    await page.keyboard.press("Tab");
    out.push(await sample(page));
  }
  results["chrome toggle"] = out;
});

test("mode round trip", async ({ page }) => {
  await seed(page);
  const option = (id: string) => page.locator(`[data-mode-option="${id}"]`);
  await expect(option("export")).toBeVisible();
  const out: Sample[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    await resetProbe(page);
    await option(i % 2 === 0 ? "export" : "design").click();
    out.push(await sample(page, 500));
  }
  await expect(page.locator("[data-paged-canvas]")).toBeVisible();
  results["mode round trip"] = out;
  memory["after mode switches"] = await measureMemory(page);
});

test("canvas resize", async ({ page }) => {
  await seed(page);
  const overlay = page.locator("[data-paged-viewport] svg").first();
  await expect(overlay).toBeVisible();
  const frames: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const width = i % 2 === 0 ? 1400 : 1600;
    await page.setViewportSize({ width, height: 1000 });
    frames.push(
      await page.evaluate(async () => {
        const wrap = document.querySelector<HTMLElement>(
          "[data-paged-viewport]",
        )!;
        const svg = wrap.querySelector("svg")!;
        for (let f = 0; f < 60; f++) {
          if (Number(svg.getAttribute("width")) === wrap.clientWidth) return f;
          await new Promise((r) => requestAnimationFrame(r));
        }
        return -1;
      }),
    );
  }
  memory["canvas resize: frames until the overlay fits (-1: never)"] = frames;
});

test("long page list", async ({ page }) => {
  const { d } = await seed(page);
  for (let i = 0; i < 54; i++) await d.addPage();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              globalThis as unknown as {
                __canvas: { handle?: { pageCount: number } };
              }
            ).__canvas.handle?.pageCount ?? 0,
        ),
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(60);
  await page.waitForTimeout(1500); // the thumbnail queue settles
  const out: Sample[] = [];
  const shown: number[] = [];
  for (let i = 0; i < Math.min(ROUNDS, 6); i++) {
    await d.openPanel("paged.properties");
    await resetProbe(page);
    await page.evaluate(() =>
      (
        globalThis as unknown as { __pagedProbe: { mark(): void } }
      ).__pagedProbe.mark(),
    );
    await d.openPanel("paged.pages");
    out.push(await sample(page, 500));
    shown.push(
      await page.locator('[data-panel-host="paged.pages"] img').count(),
    );
  }
  results["long page list (open Pages)"] = out;
  memory["long page list: thumbnails decoded by the Pages panel"] = shown;
  memory["long page list"] = await measureMemory(page);
});

test("boot", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const priorities: Record<string, Record<string, number>> = {};
  cdp.on(
    "Network.requestWillBeSent",
    (e: {
      request: { url: string; initialPriority: string };
      type?: string;
    }) => {
      const url = e.request.url;
      const kind = url.endsWith(".wasm")
        ? "wasm"
        : /\.m?js(\?|$)/.test(url)
          ? "js"
          : null;
      if (!kind) return;
      const row = (priorities[kind] ??= {});
      row[e.request.initialPriority] =
        (row[e.request.initialPriority] ?? 0) + 1;
    },
  );
  const t0 = Date.now();
  await page.goto("/");
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              globalThis as unknown as {
                __pluginBundles?: { settled: boolean };
              }
            ).__pluginBundles?.settled ?? false,
        ),
      { timeout: 60_000, intervals: [50] },
    )
    .toBe(true);
  const settledMs = Date.now() - t0;
  const preloads = await page.evaluate(() =>
    [...document.querySelectorAll('link[rel="modulepreload"]')].map(
      (l) => l.getAttribute("fetchpriority") ?? "",
    ),
  );
  memory["boot"] = {
    settledMs,
    priorities,
    modulePreloads: preloads.length,
    modulePreloadsWithFetchPriority: preloads.filter(Boolean).length,
  };
  await cdp.detach();
});
