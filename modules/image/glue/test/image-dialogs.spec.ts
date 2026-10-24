// Image ▸ Trim, Image Rotation ▸ Arbitrary and Image Size's resolution
// (WP5.1), and the Curves tools — Auto and the eyedroppers (I-55) — over
// the real image-js wasm in Node. Trim and quarter turns are exact CPU
// ops, so they run here and keep the layers as one undo step; an
// arbitrary angle resamples on the GPU and declines honestly, recording
// nothing (its pixels are pinned by the Rust GPU tests of
// `CanvasOp::RotateArbitrary`).

import { describe, expect, it } from "bun:test";

import {
  at,
  BLUE,
  bundleOnFake,
  imageEngine,
  RED,
  sourcePixels,
  twoColourRgba,
} from "./command-kit";

async function ingested(placed?: Uint8Array) {
  const k = await bundleOnFake();
  if (placed) k.fake.placed.set("u1", placed);
  await k.ingest();
  return k;
}
type K = Awaited<ReturnType<typeof ingested>>;
/** Curve points equal to `want` within f32 rounding. */
function near(got: Array<[number, number]>, want: Array<[number, number]>) {
  expect(got).toHaveLength(want.length);
  got.forEach(([x, y], i) => {
    expect(x).toBeCloseTo(want[i]![0], 5);
    expect(y).toBeCloseTo(want[i]![1], 5);
  });
}
const steps = (k: K) => k.session.state().history?.undoSteps ?? [];

describe("Image ▸ Trim", () => {
  it("trims the top-left colour from every side over every layer, as one undo step", async () => {
    const k = await ingested();
    expect(await k.session.addLayer("top")).toBe(true);
    const before = steps(k).length;
    expect(await k.session.trim("top-left")).toBe(true);
    const img = await sourcePixels(k.session);
    expect([img.w, img.h]).toEqual([2, 2]);
    expect(at(img, 0, 0)).toEqual([...BLUE]);
    expect(k.session.state().layers.layers).toHaveLength(2);
    expect(steps(k)).toHaveLength(before + 1);
    expect(steps(k).at(-1)).toBe("Crop");
    expect(k.session.state().status).toMatch(/Trimmed to 2×2/);
    await k.session.undo();
    const back = await sourcePixels(k.session);
    expect([back.w, back.h]).toEqual([4, 2]);
    expect(at(back, 0, 0)).toEqual([...RED]);
    expect(k.session.state().layers.layers).toHaveLength(2);
    k.dispose();
  });

  it("trims transparent pixels; an image with none says so and records nothing", async () => {
    const e = await imageEngine();
    // A 4×4 transparent canvas with a 2×1 opaque run at (1, 2).
    const rgba = new Uint8Array(4 * 4 * 4);
    rgba.set([10, 20, 30, 255, 10, 20, 30, 255], (2 * 4 + 1) * 4);
    const k = await ingested(e.encode(rgba, 4, 4, "png"));
    expect(await k.session.trim("transparent")).toBe(true);
    const img = await sourcePixels(k.session);
    expect([img.w, img.h]).toEqual([2, 1]);
    k.dispose();

    const o = await ingested();
    expect(await o.session.trim("transparent")).toBe(false);
    expect(o.session.state().status).toMatch(/Nothing to trim/);
    expect(steps(o)).toEqual([]);
    o.dispose();
  });
});

describe("Image ▸ Image Rotation ▸ Arbitrary", () => {
  it("a quarter turn is exact and keeps the layers; another angle is GPU-only and records nothing", async () => {
    const k = await ingested();
    expect(await k.session.addLayer("top")).toBe(true);
    const before = steps(k).length;
    expect(await k.session.rotateCanvas(90)).toBe(true);
    const img = await sourcePixels(k.session);
    expect([img.w, img.h]).toEqual([2, 4]);
    expect(k.session.state().layers.layers).toHaveLength(2);
    expect(steps(k).at(-1)).toBe("Rotate 90° clockwise");
    expect(await k.session.rotateCanvas(17.5)).toBe(false);
    expect(k.session.state().status).toMatch(/GPU-only/);
    expect(steps(k)).toHaveLength(before + 1);
    expect(await k.session.rotateCanvas(360)).toBe(false);
    expect(k.session.state().status).toMatch(/whole turn/);
    k.dispose();
  });
});

describe("Image ▸ Image Size — resolution", () => {
  it("reads the ppi a PNG declares and writes Image Size's into the exports", async () => {
    const e = await imageEngine();
    const png = e.stampPpi(e.encode(twoColourRgba(), 4, 2, "png"), 300);
    const k = await ingested(png);
    expect(k.session.state().ppi).toBeCloseTo(300, 0);
    const out = await k.session.rasterExportBytes("png");
    expect(e.readPpi(out!.bytes)).toBeCloseTo(300, 0);
    k.session.setResolution(150);
    expect(k.session.state().status).toMatch(/150 ppi/);
    const jpg = await k.session.rasterExportBytes("jpeg");
    expect(e.readPpi(jpg!.bytes)).toBe(150);
    // The pixels never changed.
    expect((await sourcePixels(k.session)).w).toBe(4);
    k.dispose();

    const plain = await ingested();
    expect(plain.session.state().ppi).toBeNull();
    const bytes = (await plain.session.rasterExportBytes("png"))!.bytes;
    expect(e.readPpi(bytes)).toBeNull();
    plain.dispose();
  });
});

describe("Curves ▸ Auto and the eyedroppers", () => {
  it("Auto stretches each channel to its own range; a flat channel is left alone", async () => {
    // Red (200, 0, 0) | blue (0, 0, 200).
    const k = await ingested();
    const curves = k.session.autoCurves()!;
    near(curves.r, [
      [0, 0],
      [200 / 255, 1],
    ]);
    expect(curves.g).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(curves.b).toEqual(curves.r);
    const luts = k.session.state().params.curveLutRgb;
    expect(luts[0]).not.toBeNull();
    expect(luts[1]).toBeNull();
    expect(k.session.state().channelCurves).toEqual(curves);
    k.dispose();
  });

  it("an armed eyedropper takes the next image click and sets that point", async () => {
    const k = await ingested();
    k.session.armCurvesPicker("white");
    expect(k.session.state().curvesPicker).toBe("white");
    expect(k.session.state().status).toMatch(/white point/);
    // A click on the red half: red 200 becomes the red channel's white.
    expect(k.session.takeCurvesPick([0.5, 0.5])).toBe(true);
    expect(k.session.state().curvesPicker).toBeNull();
    const c = k.session.state().channelCurves!;
    near(c.r, [
      [0, 0],
      [200 / 255, 1],
    ]);
    // Disarmed: the next click is the tool's again.
    expect(k.session.takeCurvesPick([0.5, 0.5])).toBe(false);
    // Black at the blue pixel: blue 200 would be black and white 0 —
    // that channel keeps the identity rather than invert.
    expect(k.session.curvesPick("black", [3.5, 0.5])).not.toBeNull();
    expect(k.session.state().channelCurves!.b).toEqual([
      [0, 0],
      [1, 1],
    ]);
    // Outside the image it samples nothing.
    expect(k.session.curvesPick("grey", [99, 99])).toBeNull();
    k.dispose();
  });
});
