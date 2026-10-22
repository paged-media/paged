// @feat: image.object-model
//
// The targeted canvas commands (plan G4): rotate, flip, crop and Canvas
// Size on a NAMED image, and a typed applyAdjustment, headless through
// `host.objects` — one undo step each. An interactive twin with no image
// open in the editor refuses with a code instead of doing nothing.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  createHeadlessHost,
  type HeadlessHost,
  silentConsole as silent,
} from "@paged-media/plugin-sdk";

import { imageBundle } from "../src/index";
import { bootEngine, type ImageEngine } from "../src/engine";
import { applyCanvasOp, canvasOpProblem } from "../src/object-model/canvas-ops";
import { stackFromImage } from "../src/object-model/pgil";
import { minimalIdml } from "./fixtures/minimal-idml";

const ENGINE_ANCHOR = fileURLToPath(new URL(".", import.meta.url));
const HERE = dirname(fileURLToPath(import.meta.url));
const built = existsSync(join(HERE, "..", "wasm", "image_js_bg.wasm"));
const lane = built ? describe : describe.skip;

const C = "media.paged.image.command";
const P = "plugin:media.paged.image";
const IMAGE = `${P}/image/urect`;
const LAYER = `${P}/layer/urect/1`;

/** A 3×2 image whose pixel (x, y) has red = 10·x + y + 1. */
const W = 3;
const H = 2;
const pixels = () => {
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      px.set([10 * x + y + 1, 0, 0, 255], (y * W + x) * 4);
  return px;
};
/** The red channel, row by row. */
const reds = (px: Uint8Array, w: number, h: number) =>
  Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => px[(y * w + x) * 4]!),
  );

describe("canvas operations on a stored stack (pure)", () => {
  const stack = () => stackFromImage(W, H, pixels());

  it("a quarter turn clockwise, and back", () => {
    const s = stack();
    applyCanvasOp(s, { kind: "rotateCw" });
    expect([s.width, s.height]).toEqual([2, 3]);
    expect(reds(s.layers[0]!.pixels, 2, 3)).toEqual([
      [2, 1],
      [12, 11],
      [22, 21],
    ]);
    applyCanvasOp(s, { kind: "rotateCcw" });
    expect(reds(s.layers[0]!.pixels, W, H)).toEqual(reds(pixels(), W, H));
  });

  it("flips, crops and resizes the canvas", () => {
    const f = stack();
    applyCanvasOp(f, { kind: "flipHorizontal" });
    expect(reds(f.layers[0]!.pixels, W, H)).toEqual([
      [21, 11, 1],
      [22, 12, 2],
    ]);
    const c = stack();
    applyCanvasOp(c, { kind: "crop", x: 1, y: 1, width: 2, height: 1 });
    expect(reds(c.layers[0]!.pixels, 2, 1)).toEqual([[12, 22]]);
    const r = stack();
    r.layers[0]!.mask = new Uint8Array(W * H).fill(0);
    applyCanvasOp(r, { kind: "canvas", width: 5, height: 2, anchor: "right" });
    expect(reds(r.layers[0]!.pixels, 5, 2)).toEqual([
      [0, 0, 1, 11, 21],
      [0, 0, 2, 12, 22],
    ]);
    // A layer mask's new area reveals.
    expect(Array.from(r.layers[0]!.mask!.subarray(0, 5))).toEqual([
      255, 255, 0, 0, 0,
    ]);
  });

  it("names what it refuses", () => {
    const s = stack();
    expect(
      canvasOpProblem(s, { kind: "crop", x: 2, y: 0, width: 2, height: 1 }),
    ).toBe("the crop must lie inside the 3×2 canvas");
    s.layers[0]!.kind = "smart";
    expect(canvasOpProblem(s, { kind: "rotate180" })).toMatch(/smart object/);
  });
});

lane("the targeted commands, headless", () => {
  let engine: ImageEngine;
  let live: HeadlessHost | null = null;
  beforeAll(async () => {
    engine = await bootEngine();
  });
  afterEach(() => {
    live?.dispose();
    live = null;
  });

  async function doc() {
    const h = (live = await createHeadlessHost({
      resolveFrom: ENGINE_ANCHOR,
      console: silent,
    }));
    await h.load(minimalIdml());
    h.loadBundle(imageBundle);
    const out = await h.host.document.mutate({
      op: "replaceImageBytes",
      args: {
        elementId: "urect",
        bytes: Array.from(engine.encode(pixels(), W, H, "png")),
      },
    } as never);
    expect(out.applied).toBe(true);
    return h;
  }
  const placed = async (h: HeadlessHost) => {
    const d = engine.decode(
      (await h.host.assets.getPlacedImage("urect"))!.bytes,
    );
    try {
      return {
        w: d.width,
        h: d.height,
        px: engine.tile(d.handle, 0, 0, d.width, d.height),
      };
    } finally {
      engine.freeImage(d.handle);
    }
  };

  it("rotateCw on a named image: one undo step, and the frame shows it", async () => {
    const h = await doc();
    const r = (await h.objects.invoke(`${C}.rotateCw`, { image: IMAGE })) as {
      undoSteps: number;
    };
    expect(r.undoSteps).toBe(1);
    expect(await h.objects.get(IMAGE, "canvasSize")).toEqual({
      kind: "value",
      value: { width: 2, height: 3, anchor: "center" },
    });
    const p = await placed(h);
    expect([p.w, p.h]).toEqual([2, 3]);
    expect(reds(p.px, 2, 3)).toEqual([
      [2, 1],
      [12, 11],
      [22, 21],
    ]);
    await h.host.document.undo();
    expect((await placed(h)).w).toBe(W);
  });

  it("cropImage and canvasSize", async () => {
    const h = await doc();
    await h.objects.invoke(`${C}.cropImage`, {
      image: IMAGE,
      bounds: [0, 1, 2, 3],
    });
    expect(reds((await placed(h)).px, 2, 2)).toEqual([
      [11, 21],
      [12, 22],
    ]);
    await h.objects.invoke(`${C}.canvasSize`, {
      image: IMAGE,
      width: 4,
      height: 2,
    });
    expect(await h.objects.get(IMAGE, "canvasSize")).toEqual({
      kind: "value",
      value: { width: 4, height: 2, anchor: "center" },
    });
    await expect(
      h.objects.invoke(`${C}.cropImage`, {
        image: IMAGE,
        bounds: [0, 0, 9, 9],
      }),
    ).rejects.toThrow(/inside the 4×2 canvas/);
  });

  it("applyAdjustment: one named adjustment layer, stored pending", async () => {
    const h = await doc();
    const r = (await h.objects.invoke(`${C}.applyAdjustment`, {
      image: IMAGE,
      name: "Warm",
      params: { "whiteBalance.temp": 0.25, "exposure.ev": 0.5 },
    })) as { undoSteps: number };
    expect(r.undoSteps).toBe(1);
    const [adj] = await h.objects.query(`${P}/adjustment`);
    expect(await h.objects.get(adj!, "exposure.ev")).toEqual({
      kind: "value",
      value: 0.5,
    });
    const layer = adj!.replace("/adjustment/", "/layer/");
    expect(await h.objects.get(layer, "name")).toEqual({
      kind: "value",
      value: "Warm",
    });
    expect(await h.objects.get(IMAGE, "pending")).toEqual({
      kind: "value",
      value: true,
    });
    await expect(
      h.objects.invoke(`${C}.applyAdjustment`, {
        image: IMAGE,
        params: { "no.such": 1 },
      }),
    ).rejects.toThrow(/unknownPath: .*no path "no.such"/);
  });

  it("a smart object is refused by name", async () => {
    const h = await doc();
    await h.objects.invoke(`${C}.convertLayerToSmart`, { layer: LAYER });
    await expect(
      h.objects.invoke(`${C}.flipVertical`, { image: IMAGE }),
    ).rejects.toThrow(/smart object/);
  });

  it("an interactive twin refuses headless with a code", async () => {
    const h = await doc();
    await expect(h.objects.invoke(`${C}.rotateCw`, {})).rejects.toThrow(
      /^unmapped: .*rotateCw .*none is open; name the image/,
    );
    await expect(h.objects.invoke(`${C}.median`, {})).rejects.toThrow(
      /^unmapped: /,
    );
  });
});
