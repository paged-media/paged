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

// The React Compiler's interaction-latency probe (ADR 228,
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

import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";

import { Designer } from "../journey/driver/designer";
import { installRenderCounter, type RenderCounter } from "./render-counter";

const ROUNDS = Number(process.env.PAGED_PERF_ROUNDS ?? 12);
const OUT = process.env.PAGED_PERF_OUT;

interface Sample {
  nextFrame: number;
  settled: number;
  commits: number;
  renders: number;
}

/** The input probe: the first pointerdown / keydown / change after a reset
 *  marks the input; the frame after it is timed with rAF + a task. */
function installInputProbe(target: object): void {
  const g = target as {
    __pagedProbe?: unknown;
    addEventListener: (t: string, f: () => void, o: boolean) => void;
  };
  const probe = {
    inputAt: -1,
    nextFrameAt: -1,
    reset() {
      probe.inputAt = -1;
      probe.nextFrameAt = -1;
    },
    mark() {
      if (probe.inputAt >= 0) return;
      probe.inputAt = performance.now();
      requestAnimationFrame(() =>
        setTimeout(() => {
          probe.nextFrameAt = performance.now();
        }, 0),
      );
    },
  };
  g.__pagedProbe = probe;
  for (const type of ["pointerdown", "keydown", "change", "input"]) {
    g.addEventListener(type, () => probe.mark(), true);
  }
}

type ProbeWindow = {
  __pagedRenderCounter: RenderCounter;
  __pagedProbe: {
    inputAt: number;
    nextFrameAt: number;
    reset(): void;
    mark(): void;
  };
};

async function resetProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as ProbeWindow;
    w.__pagedRenderCounter.reset();
    w.__pagedProbe.reset();
  });
}

/** Wait until React has not committed for `quietMs`, then read the sample. */
async function sample(page: Page, quietMs = 300): Promise<Sample> {
  return page.evaluate(async (quiet) => {
    const w = globalThis as unknown as ProbeWindow;
    const deadline = performance.now() + 5_000;
    for (;;) {
      const times = w.__pagedRenderCounter.counts().commitTimes;
      const last = times.at(-1) ?? w.__pagedProbe.inputAt;
      if (
        w.__pagedProbe.nextFrameAt >= 0 &&
        performance.now() - last >= quiet
      ) {
        break;
      }
      if (performance.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const c = w.__pagedRenderCounter.counts();
    const t0 = w.__pagedProbe.inputAt;
    const last = c.commitTimes.at(-1) ?? t0;
    return {
      nextFrame: w.__pagedProbe.nextFrameAt - t0,
      settled: Math.max(0, last - t0),
      commits: c.commits,
      renders: c.renders,
    };
  }, quietMs);
}

/** A programmatic input: mark it in the page, then run it there. */
async function selectInPage(
  page: Page,
  refs: Array<{ kind: string; id: string }>,
): Promise<void> {
  await page.evaluate((r) => {
    const w = globalThis as unknown as ProbeWindow & {
      __canvas: {
        setContentSelection?: (s: null) => void;
        setElementSelection?: (r: unknown[], mode: string) => void;
      };
    };
    w.__pagedProbe.mark();
    w.__canvas.setContentSelection?.(null);
    w.__canvas.setElementSelection?.(r, "replace");
  }, refs);
}

const results: Record<string, Sample[]> = {};
let census: unknown = null;

function summarize(name: string, samples: Sample[]) {
  const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
  const median = (xs: number[]) => {
    const s = sorted(xs);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  const p95 = (xs: number[]) => {
    const s = sorted(xs);
    return s.length
      ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]
      : 0;
  };
  const mean = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  return {
    panel: name,
    interactions: samples.length,
    nextFrameMedianMs: +median(samples.map((s) => s.nextFrame)).toFixed(1),
    nextFrameP95Ms: +p95(samples.map((s) => s.nextFrame)).toFixed(1),
    settledMedianMs: +median(samples.map((s) => s.settled)).toFixed(1),
    settledP95Ms: +p95(samples.map((s) => s.settled)).toFixed(1),
    commitsPerInteraction: +mean(samples.map((s) => s.commits)).toFixed(1),
    rendersPerInteraction: +mean(samples.map((s) => s.renders)).toFixed(1),
  };
}

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

/** A document with what the five panels show: frames, layers, pages,
 *  swatches. */
async function seed(page: Page) {
  const d = new Designer(page);
  await d.open();
  await d.newDocument();
  const frames: Array<{ kind: string; id: string }> = [];
  for (let i = 0; i < 8; i++) {
    const f = await d.addFrame({
      x0: 40 + (i % 4) * 120,
      y0: 60 + Math.floor(i / 4) * 160,
      x1: 140 + (i % 4) * 120,
      y1: 200 + Math.floor(i / 4) * 160,
    });
    if (f) frames.push(f);
  }
  const layers: string[] = [];
  for (let i = 0; i < 6; i++) layers.push(await d.addLayer(`Layer ${i + 1}`));
  for (let i = 0; i < 6; i++) await d.addPage();
  const swatches: string[] = [];
  for (let i = 0; i < 6; i++) {
    swatches.push(
      await d.createSwatch(`Swatch ${i + 1}`, [40 * i, 255 - 40 * i, 128]),
    );
  }
  return { d, frames, layers, swatches };
}

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
  // The sections open and close without a GPU (the adjustments' pixels
  // need one): the panel re-renders on its own state.
  const toggles = page.locator("details > summary", { hasNotText: "About" });
  const count = Math.max(1, Math.min(6, await toggles.count()));
  const out: Sample[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    await resetProbe(page);
    await toggles.nth(i % count).click();
    out.push(await sample(page));
  }
  results["image adjustments"] = out;
});

// The "Memo ✨" spot check, counted: with the five panels open, how many
// mounted function components carry a React Compiler cache (what DevTools
// marks with the badge), overall and for the components that render most.
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
