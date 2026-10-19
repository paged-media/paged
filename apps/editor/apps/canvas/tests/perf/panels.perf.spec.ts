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

// The React Compiler's interaction-latency probe (ADR 229,
// docs/migration/react-compiler.md). Five heavy panels (Layers, Pages,
// Properties, Swatches, Image adjustments), each driven through the same
// interactions, measuring for every one:
//
//   - next frame: from the input (a real pointer or key event, or the
//     moment a programmatic selection is made) to the first frame after it,
//     the INP-style figure (rAF, then a task);
//   - settled: from the input to React's last commit for it (the panel has
//     finished re-rendering, round trips to the render worker included);
//   - commits and component renders (the render counter, a DevTools
//     stand-in installed before React loads; ./render-counter.ts).
//
// It runs against whatever server `baseURL` names. For the measurement that
// counts, that is the PRODUCTION build: `vite build --mode demo` (a
// production bundle that keeps the `__canvas` automation handle) served by
// `vite preview`. Not a test of behaviour: the `perf` project runs it on
// demand only, and the numbers go to `PAGED_PERF_OUT` (JSON) and stdout.

import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";

import {
  OUT,
  ROUNDS,
  installInputProbe,
  resetProbe,
  sample,
  seed,
  selectInPage,
  summarize,
  type ProbeWindow,
  type Sample,
} from "./probe";
import { installRenderCounter } from "./render-counter";

const results: Record<string, Sample[]> = {};
let census: unknown = null;

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript({
    content: `(${installRenderCounter.toString()})(globalThis);(${installInputProbe.toString()})(globalThis);`,
  });
});

test.afterAll(() => {
  const summary = Object.entries(results).map(([k, v]) => summarize(k, v));
  console.log(`PERF ${JSON.stringify(summary)}`);
  console.log(`CENSUS ${JSON.stringify(census)}`);
  if (OUT) {
    writeFileSync(
      OUT,
      `${JSON.stringify({ summary, census, results }, null, 2)}\n`,
    );
  }
});

test("layers", async ({ page }) => {
  const { d, frames } = await seed(page);
  await d.openPanel("paged.layers");
  await expect(page.locator("[data-list-row]").first()).toBeVisible();
  const out: Sample[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    await resetProbe(page);
    await selectInPage(page, [frames[i % frames.length]!]);
    out.push(await sample(page));
  }
  results.layers = out;
});

test("pages", async ({ page }) => {
  const { d } = await seed(page);
  await d.openPanel("paged.pages");
  const tiles = page.locator('button[title^="Jump to page"]');
  await expect(tiles.nth(3)).toBeVisible();
  const out: Sample[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    await resetProbe(page);
    await tiles.nth(i % 4).click();
    out.push(await sample(page, 500));
  }
  results.pages = out;
});

test("properties", async ({ page }) => {
  const { d, frames } = await seed(page);
  await d.openPanel("paged.properties");
  const out: Sample[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    await resetProbe(page);
    await selectInPage(page, [frames[i % frames.length]!]);
    out.push(await sample(page));
  }
  results.properties = out;
});

test("swatches", async ({ page }) => {
  const { d, frames, swatches } = await seed(page);
  await d.openPanel("paged.swatches");
  await selectInPage(page, [frames[0]!]);
  const fill = page.locator('[data-property-field="frameFillColor"] select');
  await expect(fill.first()).toBeVisible();
  const out: Sample[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    await resetProbe(page);
    await fill.first().selectOption(swatches[i % swatches.length]!);
    out.push(await sample(page));
  }
  results.swatches = out;
});

test("image adjustments", async ({ page }) => {
  const { d, frames } = await seed(page);
  await d.selectElement(frames[0]!.kind, frames[0]!.id);
  await page.evaluate(() =>
    (
      globalThis as unknown as {
        __canvas: {
          registries: { commands: { invoke: (c: string) => Promise<unknown> } };
        };
      }
    ).__canvas.registries.commands.invoke(
      "media.paged.image.command.adjustSelected",
    ),
  );
  await d.openPanel("media.paged.image.panel.adjustments");
  const bar = page.locator("[data-image-action-bar]").first();
  await expect(bar).toBeVisible();
  // A slider the panel holds in its own state (the adjustments' pixels need
  // a GPU; the panel's controls do not): every step sets a new value.
  const slider = page.locator('input[type="range"]:visible:enabled').first();
  await expect(slider).toBeVisible();
  const min = Number((await slider.getAttribute("min")) ?? 0);
  const max = Number((await slider.getAttribute("max")) ?? 1);
  const out: Sample[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    await resetProbe(page);
    await slider.fill(String(min + ((max - min) * ((i % 4) + 1)) / 5));
    out.push(await sample(page));
  }
  results["image adjustments"] = out;
});

// The "Memo ✨" spot check, counted: with the four editor panels open, how
// many mounted function components carry a React Compiler cache (what
// DevTools marks with the badge).
test("memo census", async ({ page }) => {
  const { d, frames } = await seed(page);
  for (const id of [
    "paged.layers",
    "paged.pages",
    "paged.properties",
    "paged.swatches",
  ]) {
    await d.openPanel(id);
  }
  await selectInPage(page, [frames[0]!]);
  await sample(page);
  census = await page.evaluate(() => {
    const c = (
      globalThis as unknown as ProbeWindow
    ).__pagedRenderCounter.census();
    return { functionComponents: c.functionComponents, compiled: c.compiled };
  });
  expect(census).not.toBeNull();
});
