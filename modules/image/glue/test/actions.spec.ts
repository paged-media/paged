/*
 * This file is part of paged (https://paged.media).
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

// The image module's actions (PM-0015; extensions ADR 344): the bundle
// registers them on a shared registry, ANOTHER bundle runs them, and every
// output is decoded again by the real engine — bytes in, bytes out, the
// right size, the right pixels. The engine is the built wasm (CPU lane:
// Node has no device, so the adjustment chain runs on the CPU twins).

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "bun:test";

import type { ActionAsset, PluginManifest } from "@paged-media/plugin-api";
import {
  createActionRegistry,
  createBundleHost,
  loadBundle,
} from "@paged-media/plugin-sdk";

import { imageBundle } from "../src";
import {
  cropRectFor,
  fitPlanFor,
  IMAGE_ACTION_IDS,
  resizeSizeFor,
} from "../src/actions";
import { bootEngine, type ImageEngine } from "../src/engine";
import { makeFakeEditor, mapBacking, silentConsole } from "./helpers";

const WASM = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "wasm",
  "image_js_bg.wasm",
);
const built = existsSync(WASM);

const RUNNER: PluginManifest = {
  id: "media.paged.data",
  name: "data",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { actions: { run: true } },
};

function hosts() {
  const registry = createActionRegistry();
  const fake = makeFakeEditor();
  const image = loadBundle(() => fake.editor, imageBundle, {
    console: silentConsole,
    storage: mapBacking(),
    actions: registry,
  });
  const runner = createBundleHost(() => fake.editor, RUNNER, {
    console: silentConsole,
    actions: registry,
    capabilityMode: "enforce",
  }).host;
  return { registry, image, runner };
}

const W = 20;
const H = 10;

/** A saturated left half (red) and a blue right half, opaque. */
function twoColours(): Uint8Array {
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      px.set(x < W / 2 ? [220, 30, 40, 255] : [20, 40, 200, 255], i);
    }
  return px;
}

let engine: ImageEngine;
let png: ActionAsset;
let jpeg: ActionAsset;

/** Decode an action's output with the real engine. */
function decoded(out: unknown): {
  width: number;
  height: number;
  rgba: Uint8Array;
} {
  const a = out as ActionAsset;
  expect(a.bytes).toBeInstanceOf(Uint8Array);
  const d = engine.decode(a.bytes);
  try {
    return {
      width: d.width,
      height: d.height,
      rgba: engine.tile(d.handle, 0, 0, d.width, d.height),
    };
  } finally {
    engine.freeImage(d.handle);
  }
}

const px = (r: { width: number; rgba: Uint8Array }, x: number, y: number) =>
  Array.from(r.rgba.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4));

describe("the crop rectangle of the parameters", () => {
  it("defaults to the whole picture, cuts a rectangle, centres an aspect, refuses outside", () => {
    expect(cropRectFor({}, 20, 10)).toEqual({ x: 0, y: 0, w: 20, h: 10 });
    expect(cropRectFor({ x: 2, y: 1, width: 5 }, 20, 10)).toEqual({
      x: 2,
      y: 1,
      w: 5,
      h: 9,
    });
    expect(cropRectFor({ aspect: 1 }, 20, 10)).toEqual({
      x: 5,
      y: 0,
      w: 10,
      h: 10,
    });
    expect(cropRectFor({ aspect: 4 }, 20, 10)).toEqual({
      x: 0,
      y: 2,
      w: 20,
      h: 5,
    });
    expect(() => cropRectFor({ x: 18, width: 5 }, 20, 10)).toThrow(
      /does not lie inside the 20×10 picture/,
    );
  });
});

describe("the sizes resize and fit name [image.actions.cpu-resample]", () => {
  it("resize: a width or height alone keeps the aspect, a scale scales, both or none refuse", () => {
    expect(resizeSizeFor({ width: 10 }, 20, 10)).toEqual({ w: 10, h: 5 });
    expect(resizeSizeFor({ height: 3 }, 20, 10)).toEqual({ w: 6, h: 3 });
    expect(resizeSizeFor({ width: 7, height: 3 }, 20, 10)).toEqual({
      w: 7,
      h: 3,
    });
    expect(resizeSizeFor({ scale: 0.25 }, 20, 10)).toEqual({ w: 5, h: 3 });
    // Never below one pixel.
    expect(resizeSizeFor({ scale: 0.01 }, 20, 10)).toEqual({ w: 1, h: 1 });
    expect(() => resizeSizeFor({}, 20, 10)).toThrow(
      /a width, a height or a scale/,
    );
    expect(() => resizeSizeFor({ scale: 2, width: 3 }, 20, 10)).toThrow(
      /not both/,
    );
    expect(() => resizeSizeFor({ width: 1.5 }, 20, 10)).toThrow(/whole number/);
    expect(() => resizeSizeFor({ scale: 1000 }, 20, 10)).toThrow(
      /exceeds 16384 pixels/,
    );
  });

  it("fit: contain scales the whole picture in, cover cuts the overflow centred, enlarge false never scales up", () => {
    const whole = { x: 0, y: 0, w: 20, h: 10 };
    expect(fitPlanFor({ width: 8, height: 8 }, 20, 10)).toEqual({
      keep: whole,
      w: 8,
      h: 4,
    });
    expect(fitPlanFor({ width: 8, height: 8, mode: "cover" }, 20, 10)).toEqual({
      keep: { x: 5, y: 0, w: 10, h: 10 },
      w: 8,
      h: 8,
    });
    expect(fitPlanFor({ width: 40, height: 40 }, 20, 10)).toEqual({
      keep: whole,
      w: 40,
      h: 20,
    });
    expect(
      fitPlanFor({ width: 40, height: 40, enlarge: false }, 20, 10),
    ).toEqual({ keep: whole, w: 20, h: 10 });
    // Not enlarging, cover cuts the box out at the picture's own scale.
    expect(
      fitPlanFor(
        { width: 6, height: 40, mode: "cover", enlarge: false },
        20,
        10,
      ),
    ).toEqual({ keep: { x: 7, y: 0, w: 6, h: 10 }, w: 6, h: 10 });
    expect(() => fitPlanFor({ width: 8 }, 20, 10)).toThrow(
      /needs a width and a height/,
    );
    expect(() =>
      fitPlanFor({ width: 8, height: 8, mode: "stretch" }, 20, 10),
    ).toThrow(/"contain" or "cover"/);
  });
});

describe.skipIf(!built)(
  "media.paged.image actions on a shared registry [plugin-platform.actions-door]",
  () => {
    beforeAll(async () => {
      engine = await bootEngine();
      png = {
        bytes: engine.encode(twoColours(), W, H, "png"),
        mediaType: "image/png",
      };
      jpeg = {
        bytes: engine.encode(twoColours(), W, H, "jpeg"),
        mediaType: "image/jpeg",
      };
    });

    it("registers eight actions, and none without a registry", () => {
      const { runner, image } = hosts();
      expect(runner.actions.list().map((a) => a.id)).toEqual([
        IMAGE_ACTION_IDS.info,
        IMAGE_ACTION_IDS.convert,
        IMAGE_ACTION_IDS.crop,
        IMAGE_ACTION_IDS.resize,
        IMAGE_ACTION_IDS.fit,
        IMAGE_ACTION_IDS.adjust,
        IMAGE_ACTION_IDS.greyscale,
        IMAGE_ACTION_IDS.sharpen,
      ]);
      expect(
        runner.actions.list("asset").find((a) => a.id === IMAGE_ACTION_IDS.info)
          ?.output,
      ).toBe("value");
      image.dispose();
      expect(runner.actions.list()).toEqual([]);

      const fake = makeFakeEditor();
      // Without a registry activate registers nothing and does not throw.
      loadBundle(() => fake.editor, imageBundle, {
        console: silentConsole,
        storage: mapBacking(),
      }).dispose();
    });

    it("info reads the size and the colour treatment [image.codec.core-codecs]", async () => {
      const { runner } = hosts();
      const r = await runner.actions.run(IMAGE_ACTION_IDS.info, png);
      expect(r.output).toMatchObject({
        width: W,
        height: H,
        format: "png",
        colour: "assumed-srgb",
        depthReduced: false,
      });
    });

    it("convert writes JPEG from PNG and PNG from JPEG, decodable at the same size [image.codec.core-codecs]", async () => {
      const { runner } = hosts();
      const toJpeg = await runner.actions.run(IMAGE_ACTION_IDS.convert, png, {
        format: "jpeg",
        quality: 80,
      });
      const j = toJpeg.output as ActionAsset;
      expect(j.mediaType).toBe("image/jpeg");
      expect(Array.from(j.bytes.subarray(0, 3))).toEqual([0xff, 0xd8, 0xff]);
      const jd = decoded(j);
      expect([jd.width, jd.height]).toEqual([W, H]);
      // Lossy, but the two halves stay the colours they were.
      const [r, g, b] = px(jd, 2, 5);
      expect(r).toBeGreaterThan(180);
      expect(g).toBeLessThan(80);
      expect(b).toBeLessThan(80);

      const toPng = await runner.actions.run(IMAGE_ACTION_IDS.convert, jpeg);
      const p = toPng.output as ActionAsset;
      expect(p.mediaType).toBe("image/png");
      expect(Array.from(p.bytes.subarray(0, 4))).toEqual([
        0x89, 0x50, 0x4e, 0x47,
      ]);
      expect(decoded(p).width).toBe(W);

      // PNG → PNG is lossless.
      const same = await runner.actions.run(IMAGE_ACTION_IDS.convert, png);
      expect(decoded(same.output).rgba).toEqual(twoColours());
    });

    it("crop cuts a rectangle and an aspect, keeping the format [image.editor.crop]", async () => {
      const { runner } = hosts();
      const r = await runner.actions.run(IMAGE_ACTION_IDS.crop, png, {
        x: 8,
        y: 2,
        width: 4,
        height: 3,
      });
      expect((r.output as ActionAsset).mediaType).toBe("image/png");
      const d = decoded(r.output);
      expect([d.width, d.height]).toEqual([4, 3]);
      expect(px(d, 0, 0)).toEqual([220, 30, 40, 255]);
      expect(px(d, 3, 2)).toEqual([20, 40, 200, 255]);

      const square = await runner.actions.run(IMAGE_ACTION_IDS.crop, jpeg, {
        aspect: 1,
      });
      expect((square.output as ActionAsset).mediaType).toBe("image/jpeg");
      const s = decoded(square.output);
      expect([s.width, s.height]).toEqual([10, 10]);

      await expect(
        runner.actions.run(IMAGE_ACTION_IDS.crop, png, { x: 30 }),
      ).rejects.toThrow(/does not lie inside/);
    });

    it("crop with an angle straightens on the CPU: a quarter turn moves pixels unchanged [image.actions.cpu-resample]", async () => {
      const { runner } = hosts();
      // The centred square (red on its left half, blue on its right), the
      // frame turned a quarter clockwise: the content turns back, so the
      // left half lands at the bottom.
      const r = await runner.actions.run(IMAGE_ACTION_IDS.crop, png, {
        aspect: 1,
        angle: 90,
      });
      const d = decoded(r.output);
      expect([d.width, d.height]).toEqual([10, 10]);
      for (let x = 0; x < 10; x++) {
        expect(px(d, x, 0)).toEqual([20, 40, 200, 255]);
        expect(px(d, x, 9)).toEqual([220, 30, 40, 255]);
      }

      // A small angle resamples; the centre keeps its side's colour and
      // the corners the turn swings past repeat the picture's edge.
      const small = await runner.actions.run(IMAGE_ACTION_IDS.crop, png, {
        x: 2,
        y: 1,
        width: 16,
        height: 8,
        angle: 4,
      });
      const s = decoded(small.output);
      expect([s.width, s.height]).toEqual([16, 8]);
      expect(px(s, 2, 4)).toEqual([220, 30, 40, 255]);
      expect(px(s, 13, 4)).toEqual([20, 40, 200, 255]);
      expect(s.rgba.every((v, i) => i % 4 !== 3 || v === 255)).toBe(true);

      await expect(
        runner.actions.run(IMAGE_ACTION_IDS.crop, png, { angle: "x" }),
      ).rejects.toThrow(/angle is degrees/);
    });

    it("resize resamples on the CPU to a size, an aspect or a scale, either filter [image.actions.cpu-resample]", async () => {
      const { runner } = hosts();
      const r = await runner.actions.run(IMAGE_ACTION_IDS.resize, png, {
        width: 10,
      });
      expect((r.output as ActionAsset).mediaType).toBe("image/png");
      const d = decoded(r.output);
      expect([d.width, d.height]).toEqual([10, 5]);
      // Away from the edge between the halves the colours are kept
      // exactly (a constant area resamples to itself).
      expect(px(d, 1, 2)).toEqual([220, 30, 40, 255]);
      expect(px(d, 8, 2)).toEqual([20, 40, 200, 255]);
      // At the edge the halves blend.
      const [er, , eb] = px(d, 5, 2);
      expect(er).toBeLessThan(220);
      expect(eb).toBeGreaterThan(40);

      const up = await runner.actions.run(IMAGE_ACTION_IDS.resize, jpeg, {
        scale: 2.5,
        filter: "bilinear",
      });
      expect((up.output as ActionAsset).mediaType).toBe("image/jpeg");
      const u = decoded(up.output);
      expect([u.width, u.height]).toEqual([50, 25]);

      // The same input gives the same bytes.
      const again = await runner.actions.run(IMAGE_ACTION_IDS.resize, png, {
        width: 10,
      });
      expect((again.output as ActionAsset).bytes).toEqual(
        (r.output as ActionAsset).bytes,
      );

      await expect(
        runner.actions.run(IMAGE_ACTION_IDS.resize, png),
      ).rejects.toThrow(/a width, a height or a scale/);
      await expect(
        runner.actions.run(IMAGE_ACTION_IDS.resize, png, {
          width: 4,
          filter: "mitchell",
        }),
      ).rejects.toThrow(/filter is "lanczos3" or "bilinear"/);
    });

    it("fit contains or covers a box [image.actions.cpu-resample]", async () => {
      const { runner } = hosts();
      const c = decoded(
        (
          await runner.actions.run(IMAGE_ACTION_IDS.fit, png, {
            width: 8,
            height: 8,
          })
        ).output,
      );
      expect([c.width, c.height]).toEqual([8, 4]);

      const cover = decoded(
        (
          await runner.actions.run(IMAGE_ACTION_IDS.fit, png, {
            width: 8,
            height: 8,
            mode: "cover",
          })
        ).output,
      );
      // The centred 10 × 10 square, scaled to the box: red left, blue
      // right.
      expect([cover.width, cover.height]).toEqual([8, 8]);
      expect(px(cover, 0, 4)).toEqual([220, 30, 40, 255]);
      expect(px(cover, 7, 4)).toEqual([20, 40, 200, 255]);

      // Not enlarging, a picture that fits stays as it is.
      const kept = await runner.actions.run(IMAGE_ACTION_IDS.fit, png, {
        width: 400,
        height: 400,
        enlarge: false,
      });
      expect(decoded(kept.output).rgba).toEqual(twoColours());
    });

    it("greyscale makes every pixel grey, on the CPU twins here [image.editor.region-filter]", async () => {
      const { runner } = hosts();
      const r = await runner.actions.run(IMAGE_ACTION_IDS.greyscale, png);
      const d = decoded(r.output);
      expect([d.width, d.height]).toEqual([W, H]);
      for (let i = 0; i < d.rgba.length; i += 4) {
        expect(d.rgba[i]).toBe(d.rgba[i + 1]!);
        expect(d.rgba[i + 1]).toBe(d.rgba[i + 2]!);
      }
      // Red and blue are different greys.
      expect(px(d, 2, 5)[0]).not.toBe(px(d, 17, 5)[0]);
    });

    it("adjust runs the chain by path; identity re-encodes; a bad path refuses [image.editor.region-filter]", async () => {
      const { runner } = hosts();
      const inv = await runner.actions.run(IMAGE_ACTION_IDS.adjust, png, {
        adjust: { "invert.enabled": true },
      });
      const d = decoded(inv.output);
      expect(px(d, 2, 5)).toEqual([35, 225, 215, 255]);

      const id = await runner.actions.run(IMAGE_ACTION_IDS.adjust, png);
      expect(decoded(id.output).rgba).toEqual(twoColours());

      await expect(
        runner.actions.run(IMAGE_ACTION_IDS.adjust, png, {
          adjust: { "no.such": 1 },
        }),
      ).rejects.toThrow(/no adjustment parameter "no.such"/);
    });

    it("sharpen raises the contrast at the edge and leaves flat areas [image.editor.region-filter]", async () => {
      const { runner } = hosts();
      const r = await runner.actions.run(IMAGE_ACTION_IDS.sharpen, png, {
        amount: 1,
      });
      const d = decoded(r.output);
      expect([d.width, d.height]).toEqual([W, H]);
      // Far from the edge nothing changes.
      expect(px(d, 1, 5)).toEqual([220, 30, 40, 255]);
      // Beside it the red side overshoots: more red than the flat red.
      expect(px(d, 9, 5)[0]).toBeGreaterThan(220);
    });

    it("chains decode → crop → greyscale → JPEG, cached on the second run", async () => {
      const { runner } = hosts();
      const steps = [
        { action: IMAGE_ACTION_IDS.crop, params: { aspect: 1 } },
        { action: IMAGE_ACTION_IDS.greyscale, params: { format: "jpeg" } },
      ];
      const first = await runner.actions.runChain(steps, png);
      expect(first.cached).toBe(false);
      expect((first.output as ActionAsset).mediaType).toBe("image/jpeg");
      expect(decoded(first.output).width).toBe(10);
      const again = await runner.actions.runChain(steps, {
        bytes: png.bytes.slice(),
        mediaType: "image/png",
      });
      expect(again).toMatchObject({ cached: true, key: first.key });
    });

    it("chains fit → greyscale → JPEG thumbnails, headless [image.actions.cpu-resample]", async () => {
      const { runner } = hosts();
      const r = await runner.actions.runChain(
        [
          {
            action: IMAGE_ACTION_IDS.fit,
            params: { width: 6, height: 6, mode: "cover" },
          },
          { action: IMAGE_ACTION_IDS.greyscale, params: { format: "jpeg" } },
        ],
        png,
      );
      expect((r.output as ActionAsset).mediaType).toBe("image/jpeg");
      const d = decoded(r.output);
      expect([d.width, d.height]).toEqual([6, 6]);
    });

    it("refuses what is not a picture it decodes", async () => {
      const { runner } = hosts();
      await expect(
        runner.actions.run(IMAGE_ACTION_IDS.convert, {
          bytes: new TextEncoder().encode("RIFF....WEBP"),
          mediaType: "image/webp",
        }),
      ).rejects.toThrow(/not a picture this engine decodes/);
      await expect(
        runner.actions.run(IMAGE_ACTION_IDS.convert, "x"),
      ).rejects.toThrow(/not an asset/);
    });
  },
);
