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

// The React 19 features' probe (apps/editor ADR 233,
// docs/migration/react-19-features.md): the shell interactions the features
// change, each driven the same number of times and measured like the panel
// probe (./probe.ts: next frame, settled, commits, renders, listeners):
//
//   - canvas pan: wheel steps over the canvas (the viewport re-renders with
//     the camera; its window listeners must not re-subscribe);
//   - dock tab switch: the right dock's tabs, round robin;
//   - chrome toggle: Tab hides the panels and the rail, Tab shows them;
//   - mode round trip: Design → Export → Design;
//   - memory: JS heap and DOM counters after the switches (CDP, after a GC).
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
