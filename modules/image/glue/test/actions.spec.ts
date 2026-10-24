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
import { cropRectFor, IMAGE_ACTION_IDS } from "../src/actions";
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

    it("registers six actions, and none without a registry", () => {
      const { runner, image } = hosts();
      expect(runner.actions.list().map((a) => a.id)).toEqual([
        IMAGE_ACTION_IDS.info,
        IMAGE_ACTION_IDS.convert,
        IMAGE_ACTION_IDS.crop,
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
