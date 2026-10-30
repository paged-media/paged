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

// paged.slide's video and audio (slide ADR 718, engine ADR 1027,
// extensions ADR 345, amendment 1): Insert ▸ Video (its typed twin, as a script runs it)
// places a self-made clip on the first slide, playing automatically; F5
// plays it in a <video> laid over its frame on the show's stage, and its
// time runs; Esc stops it; the PowerPoint export carries the clip byte for
// byte, as PowerPoint holds a video.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";
import { readFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

import { focusEditor, openDeck } from "./slide-show-helpers";

/** The clip of the slide module's `media` fixture (self-made: a 2 s test
 *  pattern with a tone). */
function clip(): Buffer {
  const b = readFileSync(
    pathResolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../../../../modules/slide/slide-conformance/fixtures/media.pptx",
    ),
  );
  return zipParts(b).get("ppt/media/media1.mp4")!;
}

function zipParts(b: Buffer): Map<string, Buffer> {
  let eocd = b.length - 22;
  while (eocd >= 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = b.readUInt32LE(eocd + 16);
  const n = b.readUInt16LE(eocd + 10);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < n; i++) {
    const method = b.readUInt16LE(p + 10);
    const size = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extra = b.readUInt16LE(p + 30);
    const comment = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.toString("utf8", p + 46, p + 46 + nameLen);
    const start =
      local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const data = b.subarray(start, start + size);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

type Invoker = {
  objects: {
    invoke(id: string, args: unknown): Promise<unknown>;
    query(selector: string): Promise<string[]>;
  };
};
type G = { __slideMediaProbe?: Invoker };

async function installInvoker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const g = globalThis as unknown as G & {
      __loadTestBundle: (b: unknown) => unknown;
    };
    await new Promise<void>((resolve) => {
      g.__loadTestBundle({
        manifest: {
          id: "media.paged.journey.slidemedia",
          name: "slide media probe",
          version: "0.0.0",
          apiVersion: "^0.2",
          capabilities: { document: { read: "broad", write: "broad" } },
        },
        activate(host: Invoker) {
          g.__slideMediaProbe = host;
          resolve();
          return { dispose() {} };
        },
      });
    });
  });
}

const stage = (page: Page) =>
  page.locator('[data-paged-presentation="show"] [data-show-stage]');

test.describe("journey · paged.slide video and audio", () => {
  test("a video inserted on a slide plays in the show and is exported as PowerPoint holds it @feat:plugin-slide.slideshow @level:happy", async ({
    page,
  }) => {
    covers("command:media.paged.slide.command.insertVideo");
    test.setTimeout(120_000);
    await openDeck(page);
    await installInvoker(page);
    const data = clip().toString("base64");
    const placed = (await page.evaluate(async (data) => {
      const g = globalThis as unknown as G;
      const slides = await g.__slideMediaProbe!.objects.query(
        "plugin:media.paged.slide/slide",
      );
      return g.__slideMediaProbe!.objects.invoke(
        "media.paged.slide.command.insertVideo",
        {
          data,
          name: "clip.mp4",
          slide: slides[0],
          x: 480,
          y: 270,
          w: 320,
          h: 180,
          play: "auto",
        },
      );
    }, data)) as { media: string };
    expect(placed.media).toMatch(/rectangle/);

    // The show plays it over its frame.
    await focusEditor(page);
    await page.keyboard.press("F5");
    await expect(stage(page)).toHaveAttribute("data-slide-number", "1", {
      timeout: 15_000,
    });
    const video = stage(page).locator("video[data-show-media-item]");
    await expect(video).toHaveCount(1, { timeout: 15_000 });
    await expect(video).toHaveAttribute(
      "data-media-state",
      /^(playing|ended)$/,
      { timeout: 15_000 },
    );
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), {
        timeout: 10_000,
      })
      .toBeGreaterThan(0.2);
    const box = await video.boundingBox();
    expect(box!.width).toBeGreaterThan(50);
    // The next slide stops it: its element goes.
    await page.keyboard.press("n");
    await expect(stage(page)).toHaveAttribute("data-slide-number", "2");
    await expect(stage(page).locator("video[data-show-media-item]")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // The PowerPoint export carries the clip as it is.
    const exported = await page.evaluate(async () => {
      const reg = (
        globalThis as unknown as {
          __canvas: {
            registries: {
              exporters: {
                list(): Array<{
                  id: string;
                  export(): Promise<{ bytes: Uint8Array } | null>;
                }>;
              };
            };
          };
        }
      ).__canvas.registries.exporters;
      const exp = reg
        .list()
        .find((e) => e.id === "media.paged.slide.exporter.pptx");
      const out = await exp!.export();
      return out ? Array.from(out.bytes) : null;
    });
    expect(exported).not.toBeNull();
    const parts = zipParts(Buffer.from(exported!));
    const slide1 = parts.get("ppt/slides/slide1.xml")!.toString("utf8");
    expect(slide1).toContain('action="ppaction://media"');
    expect(slide1).toContain("<a:videoFile ");
    const media = [...parts.keys()].filter((k) => /^ppt\/media\/media\d+\.mp4$/.test(k));
    expect(media).toHaveLength(1);
    expect(parts.get(media[0]!)!.equals(clip())).toBe(true);
  });
});
