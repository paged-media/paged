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

// paged.slide's files and output (slide ADR 720, editor ADR 308): File ▸
// Export… shows the Export view in place of the canvas; its PDF handouts
// (six a page) of the ten-slide fixture deck save a two-page PDF; the
// video runner draws three slides offline through the show's frames and
// WGSL transitions, encodes them with WebCodecs and muxes an MP4 that the
// browser's own <video> element opens with the duration the runner
// reported.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import {
  clickEntry,
  closeMenus,
  installMenuProbe,
} from "../../plugin-surface/menu-driver";
import { focusEditor, openDeck } from "./slide-show-helpers";

type Invoker = {
  objects: {
    invoke(id: string, args: unknown): Promise<unknown>;
    query(selector: string): Promise<string[]>;
    set(
      address: string,
      path: string,
      value: unknown,
    ): Promise<{ applied?: boolean }>;
  };
};
type G = { __slideOutputProbe?: Invoker };

/** A probe bundle that runs the deck's typed commands, as a script does. */
async function installInvoker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const g = globalThis as unknown as G & {
      __loadTestBundle: (b: unknown) => unknown;
    };
    await new Promise<void>((resolve) => {
      g.__loadTestBundle({
        manifest: {
          id: "media.paged.journey.slideoutput",
          name: "slide output probe",
          version: "0.0.0",
          apiVersion: "^0.2",
          capabilities: { document: { read: "broad", write: "broad" } },
        },
        activate(host: Invoker) {
          g.__slideOutputProbe = host;
          resolve();
          return { dispose() {} };
        },
      });
    });
  });
}

test.describe("journey · paged.slide files and output", () => {
  test("File ▸ Export… saves PDF handouts of the deck, six slides a page @feat:plugin-slide.output @level:happy", async ({
    page,
  }) => {
    covers("command:media.paged.slide.command.export", "menu:File/Export…");
    await openDeck(page);
    await focusEditor(page);
    await installMenuProbe(page);
    await clickEntry(page, "File/Export…", "media.paged.slide.command.export");
    await closeMenus(page);
    const view = page.locator('[data-slide-export="ready"]');
    await expect(view).toBeVisible({ timeout: 15_000 });
    await view.locator('[data-export="pdf-layout"]').selectOption("handouts");
    await view.locator('[data-export="pdf-per-page"]').selectOption("6");
    const download = page.waitForEvent("download", { timeout: 60_000 });
    await view.locator('[data-export="pdf"]').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\(handouts\)\.pdf$/);
    const bytes = await (
      await import("node:fs/promises")
    ).readFile((await file.path())!);
    const text = bytes.toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);
    // Ten slides at six a page: two pages.
    expect(text.match(/\/Type \/Page\b/g)?.length).toBe(2);
    await expect(view.locator('[data-export-state="done"]')).toBeVisible();
    // Back to the slide.
    await view.locator('[data-export="close"]').click();
    await expect(view).toBeHidden();
  });

  test("a three-slide video plays in the browser with the duration the runner made @feat:plugin-slide.output @level:happy", async ({
    page,
  }) => {
    covers("command:media.paged.slide.exportVideo");
    test.setTimeout(180_000);
    await openDeck(page);
    await installInvoker(page);
    const out = await page.evaluate(async () => {
      const g = globalThis as unknown as G;
      // Slide 2 comes in with a fade (PowerPoint's default 0.7 s).
      const slides = await g.__slideOutputProbe!.objects.query(
        "plugin:media.paged.slide/slide",
      );
      await g.__slideOutputProbe!.objects.set(
        slides[1]!,
        "transitionKind",
        "fade",
      );
      const r = (await g.__slideOutputProbe!.objects.invoke(
        "media.paged.slide.exportVideo",
        {
          height: 720,
          fps: 24,
          secondsPerSlide: 1,
          useTimings: false,
          slides: [1, 2, 3],
        },
      )) as {
        bytes: Uint8Array;
        codec: string;
        width: number;
        height: number;
        frames: number;
        durationMs: number;
        gpu: boolean;
      };
      // Play it back in the page's own <video>.
      const url = URL.createObjectURL(
        new Blob([r.bytes as BlobPart], { type: "video/mp4" }),
      );
      const video = document.createElement("video");
      video.muted = true;
      const meta = await new Promise<
        { duration: number; w: number; h: number } | string
      >((resolve) => {
        video.onloadedmetadata = () =>
          resolve({
            duration: video.duration,
            w: video.videoWidth,
            h: video.videoHeight,
          });
        video.onerror = () =>
          resolve(`error ${video.error?.code}: ${video.error?.message}`);
        video.src = url;
      });
      // A frame decodes: seek into the second slide.
      let decoded = false;
      if (typeof meta !== "string") {
        await new Promise<void>((resolve) => {
          video.onseeked = () => {
            decoded = video.readyState >= 2;
            resolve();
          };
          video.currentTime = Math.min(1.5, meta.duration / 2);
          setTimeout(resolve, 5000);
        });
      }
      URL.revokeObjectURL(url);
      return {
        codec: r.codec,
        width: r.width,
        height: r.height,
        frames: r.frames,
        durationMs: r.durationMs,
        gpu: r.gpu,
        size: r.bytes.length,
        meta,
        decoded,
        canPlay: video.canPlayType(`video/mp4; codecs="${r.codec}"`),
      };
    });
    test.info().annotations.push({
      type: "video",
      description: `${out.codec} ${out.width}×${out.height}, ${out.frames} frames, ${out.size} bytes, gpu ${out.gpu}`,
    });
    expect(out.height).toBe(720);
    // Three slides of a second, and the fade into slide 2 (0.7 s at 24 fps:
    // 17 frames).
    expect(out.frames).toBe(72 + 17);
    expect(out.durationMs).toBeCloseTo((89 * 1000) / 24, 3);
    expect(typeof out.meta, JSON.stringify(out.meta)).toBe("object");
    const meta = out.meta as { duration: number; w: number; h: number };
    expect(meta.w).toBe(out.width);
    expect(meta.h).toBe(720);
    expect(Math.abs(meta.duration * 1000 - out.durationMs)).toBeLessThan(100);
    expect(out.decoded).toBe(true);
  });

  test("Save as template, Custom Shows… and Add Section from the menus; a custom show plays in its order @feat:plugin-slide.output @level:happy", async ({
    page,
  }) => {
    covers(
      "menu:File/Save as template…",
      "menu:Slide Show/Custom Shows…",
      "menu:Slide/Add Section",
      "command:media.paged.slide.playCustomShow",
    );
    await openDeck(page);
    await installInvoker(page);
    await focusEditor(page);
    await installMenuProbe(page);

    // File ▸ Save as template… saves a .potx.
    const download = page.waitForEvent("download", { timeout: 60_000 });
    await clickEntry(
      page,
      "File/Save as template…",
      "media.paged.slide.command.saveAsTemplate",
    );
    await closeMenus(page);
    expect((await download).suggestedFilename()).toMatch(/\.potx$/);

    // Slide ▸ Add Section starts a section at the slide the editor is on.
    await clickEntry(
      page,
      "Slide/Add Section",
      "media.paged.slide.command.addSection",
    );
    await closeMenus(page);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const r = (await (
            globalThis as unknown as G
          ).__slideOutputProbe!.objects.invoke(
            "media.paged.slide.sections",
            {},
          )) as { sections: { name: string; slides: number[] }[] };
          return r.sections.map((s) => [s.name, s.slides.length]);
        }),
      )
      .toEqual([["Untitled Section", 10]]);

    // Slide Show ▸ Custom Shows… opens the panel; a show set by a script
    // is listed there.
    await page.evaluate(() =>
      (globalThis as unknown as G).__slideOutputProbe!.objects.invoke(
        "media.paged.slide.setCustomShow",
        { name: "Kurz", slides: [3, 1] },
      ),
    );
    await clickEntry(
      page,
      "Slide Show/Custom Shows…",
      "media.paged.slide.command.customShows",
    );
    await closeMenus(page);
    const panel = page.locator('[data-custom-shows="ready"]');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.locator('[data-custom-show="Kurz"]')).toBeVisible();

    // Show plays slide 3, then slide 1, then the end.
    await panel.locator('[data-custom-show-play="Kurz"]').click();
    const stage = page.locator(
      '[data-paged-presentation="show"] [data-show-stage]',
    );
    await expect(stage).toHaveAttribute("data-slide-number", "3", {
      timeout: 15_000,
    });
    await page.keyboard.press("n");
    await expect(stage).toHaveAttribute("data-slide-number", "1");
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-paged-presentation="show"]')).toHaveCount(
      0,
      {
        timeout: 10_000,
      },
    );
  });
});
