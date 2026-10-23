// @feat: image.editor.region-filter
//
// A filter on a region (plan G4; ADR 465), headless: the typed
// `filterRegion` on the REAL plugin in the SDK's headless host, where no
// GPU exists, so the engine runs the shipped CPU twins of the adjustment
// chain's kernels. The pixels inside the region change, the ones outside
// do not, the write is one undo step, and what the object model bakes is
// what the engine's own `filterRegion` computes.
//
// REQUIRE_REAL_WASM=1 turns a missing artifact into a failure (the
// wasm-exec convention).

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  createHeadlessHost,
  type HeadlessHost,
  silentConsole as silent,
} from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import { imageBundle } from "../src/index";
import { bootEngine, type ImageEngine } from "../src/engine";
import { defaultAdjust, writeAdjust } from "../src/object-model/adjust";
import { minimalIdml } from "./fixtures/minimal-idml";

const ENGINE_ANCHOR = fileURLToPath(new URL(".", import.meta.url));
const HERE = dirname(fileURLToPath(import.meta.url));
const built = existsSync(join(HERE, "..", "wasm", "image_js_bg.wasm"));
if (process.env.REQUIRE_REAL_WASM === "1" && !built) {
  throw new Error(
    "REQUIRE_REAL_WASM=1 but glue/wasm/image_js_bg.wasm is missing",
  );
}
const lane = built ? describe : describe.skip;

const P = "plugin:media.paged.image";
const FRAME = "urect";
const L = `${P}/layer/${FRAME}/1`;
const FILTER = "media.paged.image.command.filterRegion";
const W = 16;
const H = 12;

let engine: ImageEngine;
beforeAll(async () => {
  if (built) engine = await bootEngine();
});

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

/** Vertical stripes two pixels wide, so a blur changes every column. */
const stripes = () => {
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      px.set(
        x % 4 < 2 ? [200, 60, 20, 255] : [30, 90, 220, 255],
        (y * W + x) * 4,
      );
  return px;
};

const decode = (bytes: Uint8Array) => {
  const d = engine.decode(bytes);
  try {
    return engine.tile(d.handle, 0, 0, d.width, d.height);
  } finally {
    engine.freeImage(d.handle);
  }
};

async function imageDoc() {
  const h = (live = await createHeadlessHost({
    resolveFrom: ENGINE_ANCHOR,
    console: silent,
  }));
  await h.load(minimalIdml());
  h.loadBundle(imageBundle);
  const out = await h.host.document.mutate({
    op: "replaceImageBytes",
    args: {
      elementId: FRAME,
      bytes: Array.from(engine.encode(stripes(), W, H, "png")),
    },
  } as never);
  expect(out.applied).toBe(true);
  return h;
}

const shown = async (h: HeadlessHost) =>
  decode((await h.host.assets.getPlacedImage(FRAME))!.bytes);

/** Whether pixel (x, y) differs between two RGBA8 buffers. */
const differs = (a: Uint8Array, b: Uint8Array, x: number, y: number) => {
  const o = (y * W + x) * 4;
  return [0, 1, 2, 3].some((c) => a[o + c] !== b[o + c]);
};

lane("filterRegion, headless (the CPU twins)", () => {
  it("runs without a GPU: inside the region only, one undo step, the frame baked", async () => {
    covers(`command:${FILTER}`);
    const h = await imageDoc();
    expect(engine.gpuReady()).toBe(false);
    const before = await shown(h);
    // [top, left, bottom, right]: rows 2–7, columns 3–12.
    const region = [2, 3, 8, 13];
    const r = await h.objects.invoke(FILTER, {
      layer: L,
      params: { "gaussianBlur.sigma": 1.5, "unsharp.amount": 0.5 },
      region,
    });
    expect(r).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get(`${P}/image/${FRAME}`, "pending")).toEqual({
      kind: "value",
      value: false,
    });
    const after = await shown(h);
    let inside = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const isInside = y >= 2 && y < 8 && x >= 3 && x < 13;
        if (!isInside)
          expect(differs(before, after, x, y), `(${x}, ${y})`).toBe(false);
        else if (differs(before, after, x, y)) inside++;
      }
    expect(inside).toBeGreaterThan(40);

    // The object model baked what the engine computes for the same chain.
    const wire = defaultAdjust();
    writeAdjust(wire, "gaussianBlur.sigma", 1.5);
    writeAdjust(wire, "unsharp.amount", 0.5);
    const direct = await engine.filterRegion(stripes(), W, H, wire, {
      x: 3,
      y: 2,
      w: 10,
      h: 6,
    });
    expect(Buffer.from(after).equals(Buffer.from(direct))).toBe(true);

    await h.host.document.undo();
    expect(Buffer.from(await shown(h)).equals(Buffer.from(before))).toBe(true);
  });

  it("takes the adjustment kernels, and the whole canvas without a region", async () => {
    const h = await imageDoc();
    const r = await h.objects.invoke(FILTER, {
      layer: L,
      params: { "invert.enabled": true },
    });
    expect(r).toMatchObject({ applied: true });
    const px = await shown(h);
    expect(Array.from(px.subarray(0, 4))).toEqual([55, 195, 235, 255]);
    expect(Array.from(px.subarray(8, 12))).toEqual([225, 165, 35, 255]);
  });

  it("refuses with a reason: outside the canvas, no change, an adjustment layer", async () => {
    const h = await imageDoc();
    await expect(
      h.objects.invoke(FILTER, {
        layer: L,
        params: { "invert.enabled": true },
        region: [0, 0, 20, 4],
      }),
    ).rejects.toThrow(/the region must lie inside the 16×12 canvas/);
    await expect(
      h.objects.invoke(FILTER, { layer: L, params: {} }),
    ).rejects.toThrow(/changes nothing/);
    await h.objects.invoke("media.paged.image.command.applyAdjustment", {
      image: `${P}/image/${FRAME}`,
      params: { "exposure.ev": 0.5 },
    });
    await expect(
      h.objects.invoke(FILTER, {
        layer: `${P}/layer/${FRAME}/2`,
        params: { "invert.enabled": true },
      }),
    ).rejects.toThrow(/adjustment layer has no pixels/);
    await expect(
      h.objects.invoke(FILTER, {
        layer: L,
        params: { "noSuch.path": 1 },
      }),
    ).rejects.toThrow(/no adjustment parameter "noSuch.path"/);
  });
});
