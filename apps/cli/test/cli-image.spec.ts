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

// `paged-node invoke` over paged.image (plan G4): a filter on a region of
// an image, run by the typed `filterRegion` with the image bundle loaded
// from the workspace. Node has no GPU, so the engine runs the CPU twins
// of the kernels (image ADR 465); the document is written back with the
// filtered image in its frame. A mask given as data narrows the region:
// polygons in the JSON argument, an alpha coverage read from a file with
// the `bytes` argument form "@path"; `selection: true` is refused, as
// there is no editor session to hold one.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { createHeadlessHost } from "@paged-media/plugin-sdk";

import { minimalIdml } from "../../../platform/extensions/packages/plugin-sdk/test/fixtures/minimal-idml";
import { bootEngine } from "../../../modules/image/glue/src/engine";
import { cli, engineOptions, silent, tempDir } from "./helpers";

const IMAGE_ENTRY = fileURLToPath(
  new URL("../../../modules/image/glue/src/index.ts", import.meta.url),
);
const IMAGE = `--plugins=${IMAGE_ENTRY}`;
const FILTER = "media.paged.image.command.filterRegion";
const LAYER = "plugin:media.paged.image/layer/urect/1";
const W = 8;
const H = 6;

/** Vertical stripes, two pixels wide. */
const stripes = () => {
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      px.set(
        x % 4 < 2 ? [240, 40, 40, 255] : [20, 20, 200, 255],
        (y * W + x) * 4,
      );
  return px;
};

let tmp: ReturnType<typeof tempDir>;
let docPath = "";

/** The minimal document with the striped image placed in `urect`. */
async function writeDocument(dir: string): Promise<string> {
  const engine = await bootEngine();
  const h = await createHeadlessHost({
    console: silent,
    ...(await engineOptions()),
  });
  try {
    await h.load(minimalIdml());
    const placed = await h.host.document.mutate({
      op: "replaceImageBytes",
      args: {
        elementId: "urect",
        bytes: Array.from(engine.encode(stripes(), W, H, "png")),
      },
    } as never);
    if (!placed.applied) throw new Error("image refused");
    const { bytes } = await h.exportDocument("paged");
    const path = join(dir, "photo.paged");
    writeFileSync(path, bytes);
    return path;
  } finally {
    h.dispose();
  }
}

/** The straight RGBA8 pixels of the image a .paged document places in
 *  `urect`. */
async function placedPixels(path: string): Promise<Uint8Array> {
  const engine = await bootEngine();
  const h = await createHeadlessHost({
    console: silent,
    ...(await engineOptions()),
  });
  try {
    await h.load(new Uint8Array(readFileSync(path)));
    const d = engine.decode(
      (await h.host.assets.getPlacedImage("urect"))!.bytes,
    );
    try {
      return engine.tile(d.handle, 0, 0, d.width, d.height);
    } finally {
      engine.freeImage(d.handle);
    }
  } finally {
    h.dispose();
  }
}

beforeAll(async () => {
  tmp = tempDir();
  docPath = await writeDocument(tmp.dir);
});
afterAll(() => tmp.done());

describe("paged-node invoke — paged.image", () => {
  it("filterRegion inverts a region of the image without a GPU, and saves", async () => {
    const out = join(tmp.dir, "filtered.paged");
    const r = await cli([
      "invoke",
      docPath,
      FILTER,
      JSON.stringify({
        layer: LAYER,
        params: { "invert.enabled": true },
        region: [1, 2, 4, 6],
      }),
      "-o",
      out,
      IMAGE,
    ]);
    expect(r.code, JSON.stringify(r.json) + r.err).toBe(0);
    expect(r.json.applied).toBe(true);
    const before = stripes();
    const after = await placedPixels(out);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const inside = y >= 1 && y < 4 && x >= 2 && x < 6;
        const want = inside
          ? [255 - before[o]!, 255 - before[o + 1]!, 255 - before[o + 2]!, 255]
          : Array.from(before.subarray(o, o + 4));
        expect(Array.from(after.subarray(o, o + 4)), `(${x}, ${y})`).toEqual(
          want,
        );
      }
  });

  it("filterRegion within a polygon mask changes only the polygon's pixels", async () => {
    const out = join(tmp.dir, "polygon.paged");
    const r = await cli([
      "invoke",
      docPath,
      FILTER,
      JSON.stringify({
        layer: LAYER,
        params: { "invert.enabled": true },
        // A rectangle as a polygon: columns 0–3, rows 0–2.
        mask: {
          polygons: [
            [
              [0, 0],
              [4, 0],
              [4, 3],
              [0, 3],
            ],
          ],
        },
      }),
      "-o",
      out,
      IMAGE,
    ]);
    expect(r.code, JSON.stringify(r.json) + r.err).toBe(0);
    const before = stripes();
    const after = await placedPixels(out);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const inside = x < 4 && y < 3;
        const want = inside
          ? [255 - before[o]!, 255 - before[o + 1]!, 255 - before[o + 2]!, 255]
          : Array.from(before.subarray(o, o + 4));
        expect(Array.from(after.subarray(o, o + 4)), `(${x}, ${y})`).toEqual(
          want,
        );
      }
  });

  it("filterRegion within an alpha mask read from a file (@path): 0 untouched, 255 inverted, 128 half way", async () => {
    // One coverage byte per pixel: row 0 full, row 1 half, the rest none.
    const alpha = new Uint8Array(W * H);
    alpha.fill(255, 0, W);
    alpha.fill(128, W, 2 * W);
    const maskPath = join(tmp.dir, "mask.bin");
    writeFileSync(maskPath, alpha);
    const out = join(tmp.dir, "alpha.paged");
    const r = await cli([
      "invoke",
      docPath,
      FILTER,
      JSON.stringify({
        layer: LAYER,
        params: { "invert.enabled": true },
        mask: { alpha: `@${maskPath}` },
      }),
      "-o",
      out,
      IMAGE,
    ]);
    expect(r.code, JSON.stringify(r.json) + r.err).toBe(0);
    const before = stripes();
    const after = await placedPixels(out);
    for (let x = 0; x < W; x++) {
      const o = x * 4;
      expect(Array.from(after.subarray(o, o + 3))).toEqual([
        255 - before[o]!,
        255 - before[o + 1]!,
        255 - before[o + 2]!,
      ]);
      const h = (W + x) * 4;
      for (let c = 0; c < 3; c++)
        expect(Math.abs(after[h + c]! - 127.5)).toBeLessThanOrEqual(1.5);
    }
    expect(Array.from(after.subarray(2 * W * 4))).toEqual(
      Array.from(before.subarray(2 * W * 4)),
    );
  });

  it("filterRegion with selection: true is refused headless, with the reason", async () => {
    const r = await cli([
      "invoke",
      docPath,
      FILTER,
      JSON.stringify({
        layer: LAYER,
        params: { "invert.enabled": true },
        selection: true,
      }),
      "--no-save",
      IMAGE,
    ]);
    expect(r.code).toBe(1);
    expect(JSON.stringify(r.json) + r.err).toMatch(
      /no image is open in the editor/,
    );
  });

  it("filterRegion outside the canvas fails with the reason, and writes nothing", async () => {
    const r = await cli([
      "invoke",
      docPath,
      FILTER,
      JSON.stringify({
        layer: LAYER,
        params: { "gaussianBlur.sigma": 2 },
        region: [0, 0, 7, 8],
      }),
      "--no-save",
      IMAGE,
    ]);
    expect(r.code).toBe(1);
    expect(JSON.stringify(r.json) + r.err).toMatch(/inside the 8×6 canvas/);
  });
});
