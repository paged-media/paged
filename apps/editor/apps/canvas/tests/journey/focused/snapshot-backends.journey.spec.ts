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

// Journey: a snapshot is the page the screen shows, on either rasterizer.
//
// `requestSnapshot` — the eyedropper, PNG export, AI page images and the
// document thumbnails all read pixels through it — is answered by Vello on
// the worker's WebGPU device when the worker has one, and by the CPU
// rasterizer otherwise. Both draw the same display list, so:
//
//   1. a page snapshot from either agrees with the other to within the
//      budget below (measured, sized at the measurement plus headroom);
//   2. the eyedropper on the GPU path reads EXACTLY the pixel the screen
//      shows: the snapshot is the scene the worker presents, so a sampled
//      colour equals the screen's colour channel for channel. On the CPU
//      path it is within a level or two (8-bit compositing arithmetic).
//
// Runs only in the `journeys-gpu` project (real Chrome, WebGPU over Metal);
// skips when the worker reports no WebGPU device.

import { expect, test, type Page } from "@playwright/test";

import { openCanvas } from "../../fidelity/canvas-driver";
import {
  elementPageRectPt,
  type FixtureName,
} from "../../e2e/harness/fixtures";
import {
  activateTool,
  loadViaReactPath,
  screenPoint,
} from "../../e2e/harness/viewport";

type Backend = "auto" | "gpu" | "cpu";
type Info = {
  requested: Backend;
  gpuReady: boolean;
  last: "gpu" | "cpu" | null;
};

type Handle = {
  gpuActive?: boolean | null;
  handle: { pageIds: string[] } | null;
  client: {
    setSnapshotBackend(b: Backend): void;
    snapshotBackendInfo(): Promise<Info | null>;
    requestSnapshot(
      pageId: string,
      width: number,
      dpi?: number,
    ): Promise<{ widthPx: number; heightPx: number; pngBytes: number[] }>;
    mutate(m: unknown): Promise<unknown>;
    collection<T>(n: string): Promise<readonly T[]>;
    documentMeta(): Promise<{ defaultFillColor?: string | null }>;
  };
};

/**
 * GPU ↔ CPU snapshot budget per page at 72 dpi, over every channel of
 * every pixel: the mean absolute difference (0–255) and the share of
 * pixels with any channel more than 8 levels apart. Measured on Metal
 * against the tiny-skia CPU lane (see ADR 188): worst mean 0.104 (a
 * gradients page), worst share 0.574 % (a text page, glyph edges); sized
 * at the worst page × 1.25.
 */
const PARITY = { meanAbs: 0.13, overEight: 0.0072 };

/** The pages the parity check walks: every kind of content the model has. */
const PARITY_FIXTURES: FixtureName[] = [
  "transparency",
  "effects",
  "gradients",
  "strokes-fills",
  "text",
  "images",
];

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

/** Draw `pageId` through `backend`; report which lane actually drew it. */
async function snapshot(page: Page, pageId: string, backend: Backend) {
  return page.evaluate(
    async ({ pageId, backend }) => {
      const c = (globalThis as unknown as { __canvas: Handle }).__canvas.client;
      c.setSnapshotBackend(backend);
      const shot = await c.requestSnapshot(pageId, 0, 72);
      const info = await c.snapshotBackendInfo();
      return {
        png: shot.pngBytes,
        w: shot.widthPx,
        h: shot.heightPx,
        drawnBy: info?.last ?? null,
      };
    },
    { pageId, backend },
  );
}

/** Mean absolute channel difference and share of pixels > 8 levels apart. */
async function compare(page: Page, a: number[], b: number[]) {
  return page.evaluate(
    async ({ a, b }) => {
      const pixels = async (png: number[]) => {
        const bmp = await createImageBitmap(
          new Blob([new Uint8Array(png)], { type: "image/png" }),
        );
        const cv = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = cv.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      };
      const [pa, pb] = await Promise.all([pixels(a), pixels(b)]);
      if (pa.length !== pb.length)
        return { sameSize: false, meanAbs: 255, overEight: 1, max: 255 };
      let sum = 0;
      let over = 0;
      let max = 0;
      for (let i = 0; i < pa.length; i += 4) {
        let worst = 0;
        for (let c = 0; c < 4; c++) {
          const d = Math.abs(pa[i + c] - pb[i + c]);
          sum += d;
          worst = Math.max(worst, d);
        }
        if (worst > 8) over++;
        max = Math.max(max, worst);
      }
      return {
        sameSize: true,
        meanAbs: sum / pa.length,
        overEight: over / (pa.length / 4),
        max,
      };
    },
    { a, b },
  );
}

/** Decode a PNG screenshot in the page and read its centre pixel. */
async function pngCentre(page: Page, png: Buffer) {
  return page.evaluate(async (bytes) => {
    const bmp = await createImageBitmap(
      new Blob([new Uint8Array(bytes)], { type: "image/png" }),
    );
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(
      Math.floor(bmp.width / 2),
      Math.floor(bmp.height / 2),
      1,
      1,
    ).data;
    return { r: d[0], g: d[1], b: d[2] };
  }, Array.from(png));
}

/** The colour the eyedropper sampled, read back from the swatch it picked. */
async function sampledColour(page: Page) {
  return page.evaluate(async () => {
    const c = (globalThis as unknown as { __canvas: Handle }).__canvas.client;
    const id = (await c.documentMeta()).defaultFillColor;
    const sw = (
      await c.collection<{ selfId: string; name?: string | null }>("swatches")
    ).find((s) => s.selfId === id);
    const m = /R=(\d+) G=(\d+) B=(\d+)/.exec(sw?.name ?? "");
    return m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) } : null;
  });
}

test.describe("journey · snapshot backends", () => {
  test("GPU and CPU snapshots of the same page agree within the parity budget @feat:the-renderer.gpu-backend @level:edge", async ({
    page,
  }) => {
    test.setTimeout(10 * 60_000);
    await openCanvas(page);
    const measured: string[] = [];
    for (const name of PARITY_FIXTURES) {
      const fx = await loadViaReactPath(page, name);
      test.skip(!(await gpuActive(page)), "this lane needs a WebGPU device");
      for (const p of fx.pages.slice(0, 6)) {
        const gpu = await snapshot(page, p.pageId, "gpu");
        const cpu = await snapshot(page, p.pageId, "cpu");
        expect(gpu.drawnBy, `${name} ${p.pageId}: the GPU path drew it`).toBe(
          "gpu",
        );
        expect(cpu.drawnBy, `${name} ${p.pageId}: the CPU path drew it`).toBe(
          "cpu",
        );
        expect([gpu.w, gpu.h], "both lanes size the page alike").toEqual([
          cpu.w,
          cpu.h,
        ]);
        const d = await compare(page, gpu.png, cpu.png);
        measured.push(
          `${name} ${p.pageId}: mean ${d.meanAbs.toFixed(3)} over8 ${(d.overEight * 100).toFixed(3)}% max ${d.max}`,
        );
        // Soft, so one run reports every page: the table is how the
        // budget is re-measured.
        expect
          .soft(d.meanAbs, `${name} ${p.pageId} mean |GPU − CPU|`)
          .toBeLessThanOrEqual(PARITY.meanAbs);
        expect
          .soft(d.overEight, `${name} ${p.pageId} pixels > 8 apart`)
          .toBeLessThanOrEqual(PARITY.overEight);
      }
    }
    console.log(`snapshot parity, GPU vs CPU:\n${measured.join("\n")}`);
    test
      .info()
      .annotations.push({ type: "parity", description: measured.join("\n") });
    console.log(measured.join("\n"));
  });

  test("the eyedropper reads the pixel the screen shows @feat:plugin-platform.host-eyedropper @level:edge", async ({
    page,
  }) => {
    await openCanvas(page);
    const fx = await loadViaReactPath(page, "geometry");
    test.skip(!(await gpuActive(page)), "this lane needs a WebGPU device");
    const target = fx.firstRectangle;
    test.skip(!target, "fixture exposes no rectangle to paint");

    // A colour composited over the paper at 35 % opacity: what the screen
    // shows is the blend, so a sampler that read anything but the screen's
    // own arithmetic would come back a level or more off.
    await page.evaluate(async (el) => {
      const c = (globalThis as unknown as { __canvas: Handle }).__canvas.client;
      await c.mutate({
        op: "createSwatch",
        args: { spec: { name: "probe", space: "RGB", value: [10, 120, 200] } },
      });
      const id = (
        await c.collection<{ selfId: string; name?: string | null }>("swatches")
      ).find((s) => s.name === "probe")?.selfId;
      await c.mutate({
        op: "setElementProperty",
        args: {
          elementId: el,
          path: "frameFillColor",
          value: { type: "colorRef", value: id },
        },
      });
      await c.mutate({
        op: "setElementProperty",
        args: {
          elementId: el,
          path: "frameOpacity",
          value: { type: "length", value: 35 },
        },
      });
    }, target!);
    await page.waitForTimeout(1000);

    const b = await elementPageRectPt(page, target!);
    test.skip(!b, "fixture exposes no page rect for the painted frame");
    const p = await screenPoint(
      page,
      (b!.left + b!.right) / 2,
      (b!.top + b!.bottom) / 2,
    );
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    const shot = await page.screenshot({
      clip: { x: x - 1, y: y - 1, width: 3, height: 3 },
    });
    const screen = await pngCentre(page, shot);

    await activateTool(page, "eyedropper");
    for (const backend of ["gpu", "cpu"] as const) {
      await page.evaluate(
        (bk) =>
          (
            globalThis as unknown as { __canvas: Handle }
          ).__canvas.client.setSnapshotBackend(bk),
        backend,
      );
      await page.mouse.click(x, y);
      await page.waitForTimeout(1500);
      const sampled = await sampledColour(page);
      const info = await page.evaluate(() =>
        (
          globalThis as unknown as { __canvas: Handle }
        ).__canvas.client.snapshotBackendInfo(),
      );
      expect(info?.last, `the ${backend} path drew the sample`).toBe(backend);
      expect(
        sampled,
        `${backend}: the eyedropper picked a colour`,
      ).not.toBeNull();
      const tolerance = backend === "gpu" ? 0 : 2;
      for (const ch of ["r", "g", "b"] as const) {
        expect(
          Math.abs(sampled![ch] - screen[ch]),
          `${backend}: ${ch} sampled ${sampled![ch]} vs screen ${screen[ch]}`,
        ).toBeLessThanOrEqual(tolerance);
      }
    }
  });
});
