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

// Journey: without a WebGPU adapter the canvas still shows the document.
//
// The twin of gpu-backend.journey.spec.ts. Playwright's bundled Chromium
// (the `journeys` lane) exposes `navigator.gpu` but grants no adapter, which
// is also what a blocklisted GPU or a virtual machine looks like. The worker
// then falls back to the CPU tile compositor, which needs the canvas's 2D
// context. `initGpu` used to bind the canvas to WebGPU before it found out
// there was no adapter, so the fallback had nothing to draw on and the
// viewport stayed blank under a "CPU" badge. This asserts the page is drawn.
//
// Where WebGPU engages (the `journeys-gpu` lane) the fallback is not in play,
// and gpu-backend.journey.spec.ts covers that lane instead.

import { expect, test } from "@playwright/test";
import { PNG } from "pngjs";

import { Designer } from "../driver/designer";

test.describe("journey · CPU fallback", () => {
  test("without a WebGPU adapter the canvas still draws the page @feat:the-renderer.gpu-backend @level:edge", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();

    const gpuActive = await page
      .waitForFunction(
        () => {
          const v = (
            globalThis as unknown as {
              __canvas?: { gpuActive?: boolean | null };
            }
          ).__canvas?.gpuActive;
          return v === true || v === false ? { v } : null;
        },
        null,
        { timeout: 20_000 },
      )
      .then((h) => h.jsonValue() as Promise<{ v: boolean }>);
    test.skip(
      gpuActive.v,
      "WebGPU engaged here; gpu-backend.journey.spec.ts covers this lane",
    );

    // The new document's page is white on a grey pasteboard. A canvas the
    // fallback cannot draw on stays one flat colour, with no white at all.
    const canvas = page.locator("canvas[data-paged-canvas]");
    await expect
      .poll(
        async () => {
          const png = PNG.sync.read(await canvas.screenshot());
          let white = 0;
          for (let i = 0; i < png.data.length; i += 4) {
            if (
              png.data[i] > 245 &&
              png.data[i + 1] > 245 &&
              png.data[i + 2] > 245
            )
              white++;
          }
          return white / (png.width * png.height);
        },
        {
          message: "share of the canvas the white page covers",
          timeout: 15_000,
        },
      )
      .toBeGreaterThan(0.05);
  });
});
