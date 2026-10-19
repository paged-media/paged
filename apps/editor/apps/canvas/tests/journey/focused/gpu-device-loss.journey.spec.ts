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

// Journey: a lost GPU device is noticed, and the canvas draws again.
//
// When the browser's GPU process crashes (or a driver resets) the WebGPU
// device is lost: every present fails from then on. The canvas used to stay
// blank for the rest of the session under a "GPU 60 fps" badge. Now the
// worker asks for a new device on the same canvas; when the browser grants
// none, the viewport hands the worker a NEW canvas (the old one keeps its
// WebGPU context and can never draw 2D) and the page is drawn on the CPU,
// with the badge saying so.
//
// Runs only in the `journeys-gpu` project (real Chrome, WebGPU over Metal).

import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { PNG } from "pngjs";

import { Designer } from "../driver/designer";

type Handle = {
  gpuActive?: boolean | null;
  client: {
    subscribe(
      l: (m: { kind: string; payload?: { kind?: string } }) => void,
    ): () => void;
  };
};

async function gpuActive(page: Page): Promise<boolean> {
  return page
    .waitForFunction(
      () => {
        const v = (globalThis as unknown as { __canvas?: Handle }).__canvas
          ?.gpuActive;
        return v === true || v === false ? { v } : null;
      },
      null,
      { timeout: 20_000 },
    )
    .then(async (h) => ((await h.jsonValue()) as { v: boolean }).v);
}

/** Share of the canvas the new document's white page covers. */
async function whiteShare(page: Page): Promise<number> {
  const png = PNG.sync.read(
    await page.locator("canvas[data-paged-canvas]").screenshot(),
  );
  let white = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] > 245 && png.data[i + 1] > 245 && png.data[i + 2] > 245)
      white++;
  }
  return white / (png.width * png.height);
}

/** Record the worker's GPU warnings (`gpuLost`, `gpuRecovered`, `canvasNeeded`). */
async function watchGpuWarnings(page: Page) {
  await page.evaluate(() => {
    const g = globalThis as unknown as {
      __canvas: Handle;
      __gpuWarnings?: string[];
    };
    g.__gpuWarnings = [];
    g.__canvas.client.subscribe((m) => {
      if (m.kind === "warning" && m.payload?.kind?.startsWith("gpu")) {
        g.__gpuWarnings!.push(m.payload.kind);
      }
      if (m.kind === "warning" && m.payload?.kind === "canvasNeeded") {
        g.__gpuWarnings!.push("canvasNeeded");
      }
    });
  });
  return () =>
    page.evaluate(
      () =>
        (globalThis as unknown as { __gpuWarnings: string[] }).__gpuWarnings,
    );
}

/** Prepend `shim` to the canvas worker module. */
async function shimWorker(
  context: BrowserContext,
  shim: string,
): Promise<void> {
  await context.route(
    /\/src\/worker\/worker\.ts\?worker_file/,
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: shim + (await response.text()) });
    },
  );
}

function loseGpu(page: Page) {
  return page.evaluate(() => {
    const c = (globalThis as unknown as { __canvas: { client: unknown } })
      .__canvas.client as {
      worker: Worker;
    };
    c.worker.postMessage({ kind: "simulateGpuLoss" });
  });
}

test.describe("journey · GPU device loss", () => {
  test("a lost device is replaced and the canvas draws again @feat:the-renderer.gpu-backend @level:edge", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();
    test.skip(!(await gpuActive(page)), "this lane needs a WebGPU device");
    await expect
      .poll(() => whiteShare(page), { timeout: 15_000 })
      .toBeGreaterThan(0.05);
    const warnings = await watchGpuWarnings(page);

    await loseGpu(page);

    await expect
      .poll(warnings, { timeout: 15_000 })
      .toEqual(["gpuLost", "gpuRecovered"]);
    expect(await gpuActive(page), "the badge still says GPU").toBe(true);
    // Something must present again for the page to show: nudge the camera.
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, 40);
    await expect
      .poll(() => whiteShare(page), { timeout: 15_000 })
      .toBeGreaterThan(0.05);
  });

  test("with no new device the viewport gets a new canvas, drawn on the CPU @feat:the-renderer.gpu-backend @level:edge", async ({
    page,
    context,
  }) => {
    // The adapter checks at attach time pass; every later request — the
    // recovery's — is refused, as on a machine whose GPU stays blocklisted
    // after a crash.
    await shimWorker(
      context,
      `{
  const gpu = self.navigator.gpu;
  if (gpu) {
    const request = gpu.requestAdapter.bind(gpu);
    let calls = 0;
    gpu.requestAdapter = (options) => (++calls <= 2 ? request(options) : Promise.resolve(null));
  }
}
`,
    );
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();
    test.skip(!(await gpuActive(page)), "this lane needs a WebGPU device");
    const warnings = await watchGpuWarnings(page);

    await loseGpu(page);

    await expect
      .poll(warnings, { timeout: 15_000 })
      .toEqual(["gpuLost", "canvasNeeded"]);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (globalThis as unknown as { __canvas?: Handle }).__canvas
                ?.gpuActive,
          ),
        { timeout: 15_000 },
      )
      .toBe(false);
    await expect
      .poll(() => whiteShare(page), { timeout: 15_000 })
      .toBeGreaterThan(0.05);
  });
});
