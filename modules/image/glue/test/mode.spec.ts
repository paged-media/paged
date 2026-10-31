// Image ▸ Mode (image ADR 479): the depth and colour-mode commands and the
// proof view, through the registered handlers over the fake editor and the
// real image-js wasm in Node (command-kit.ts). Each mode change is one undo
// step on the image's own journal; the proof view is a display transform
// and changes nothing.

import { describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import {
  at,
  bundleOnFake,
  C,
  imageEngine,
  imageShape,
  quiesce,
  sourcePixels,
} from "./command-kit";
import { png16 } from "./fixtures/png16";

const NOTHING = /Nothing ingested|ingest a placed image first/;

async function ingested() {
  const k = await bundleOnFake();
  await k.ingest();
  return k;
}

async function run(k: Awaited<ReturnType<typeof ingested>>, id: string) {
  await k.run(`${C}.${id}`);
  await quiesce(k.session);
}

describe("Image ▸ Mode ▸ bits per channel [image.io.depth-color-modes]", () => {
  it("modeBits16 widens every layer as one undo step; modeBits8 rounds back", async () => {
    covers("command:media.paged.image.command.modeBits16");
    covers("command:media.paged.image.command.modeBits8");
    const none = await bundleOnFake({ select: false });
    await none.run(`${C}.modeBits16`);
    expect(none.session.state().status).toMatch(NOTHING);
    none.dispose();

    const k = await ingested();
    const before = await sourcePixels(k.session);
    expect(k.session.state().mode.bits).toBe(8);
    await run(k, "modeBits16");
    expect(k.session.state().mode.bits).toBe(16);
    const e = await imageEngine();
    expect(e.imageBits(k.session.state().source!.handle)).toBe(16);
    expect(k.session.state().history?.undoSteps).toEqual(["16 Bits/Channel"]);
    // Widening is exact: the 8-bit view is the image it was.
    expect(await sourcePixels(k.session)).toEqual(before);
    const s16 = e.imageSamples16(k.session.state().source!.handle);
    expect(s16[0]).toBe(200 * 257);
    // The same depth again changes nothing and records nothing.
    await run(k, "modeBits16");
    expect(k.session.state().history?.undoSteps).toEqual(["16 Bits/Channel"]);
    expect(k.session.state().status).toMatch(/already has 16 bits/);
    await run(k, "modeBits8");
    expect(k.session.state().mode.bits).toBe(8);
    expect(k.session.state().history?.undoSteps).toEqual([
      "16 Bits/Channel",
      "8 Bits/Channel",
    ]);
    await run(k, "undo");
    expect(k.session.state().mode.bits).toBe(16);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });
});

describe("Image ▸ Mode ▸ colour modes [image.io.depth-color-modes]", () => {
  it("modeGray turns the image grey as one undo step, and undo brings the colour back", async () => {
    covers("command:media.paged.image.command.modeGray");
    const k = await ingested();
    const before = await sourcePixels(k.session);
    await run(k, "modeGray");
    expect(k.session.state().mode.color).toBe("gray");
    expect(k.session.state().history?.undoSteps).toEqual(["Grayscale"]);
    const grey = await sourcePixels(k.session);
    const [r, g, b, a] = at(grey, 0, 0);
    expect(Math.abs(r - g)).toBeLessThanOrEqual(1);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(1);
    expect(a).toBe(255);
    // Red is darker than its own red channel once it is grey.
    expect(r).toBeLessThan(200);
    await run(k, "undo");
    expect(k.session.state().mode.color).toBe("rgb");
    expect(await sourcePixels(k.session)).toEqual(before);
    k.dispose();
  });

  it("modeRgb and modeLab record their step; Lab keeps the colours", async () => {
    covers("command:media.paged.image.command.modeRgb");
    covers("command:media.paged.image.command.modeLab");
    const k = await ingested();
    const before = await sourcePixels(k.session);
    await run(k, "modeRgb");
    // Already RGB: nothing to do.
    expect(k.session.state().history?.undoSteps ?? []).toEqual([]);
    await run(k, "modeLab");
    expect(k.session.state().mode.color).toBe("lab");
    expect(k.session.state().history?.undoSteps).toEqual(["Lab Color"]);
    // An 8-bit Lab round trip moves a saturated primary's near-zero
    // channels by a few levels (as Photoshop's does; the Rust replay holds
    // it to Photoshop by ΔE).
    const lab = await sourcePixels(k.session);
    for (let i = 0; i < before.px.length; i++)
      expect(Math.abs(lab.px[i] - before.px[i])).toBeLessThanOrEqual(8);
    await run(k, "modeRgb");
    expect(k.session.state().mode.color).toBe("rgb");
    k.dispose();
  });

  it("modeCmyk without a CMYK profile says the ink formula changes no colour", async () => {
    covers("command:media.paged.image.command.modeCmyk");
    const k = await ingested();
    const before = await sourcePixels(k.session);
    await run(k, "modeCmyk");
    expect(k.session.state().mode.color).toBe("cmyk");
    expect(k.session.state().status).toMatch(/without a CMYK profile/);
    expect(await sourcePixels(k.session)).toEqual(before);
    k.dispose();
  });
});

describe("Image ▸ Mode ▸ 32 bits, Indexed and Multichannel [image.io.depth-color-modes]", () => {
  it("modeBits32 holds linear light as one undo step and shows the same colours", async () => {
    covers("command:media.paged.image.command.modeBits32");
    const k = await ingested();
    const before = await sourcePixels(k.session);
    await run(k, "modeBits32");
    expect(k.session.state().mode.bits).toBe(32);
    const e = await imageEngine();
    expect(e.imageBits(k.session.state().source!.handle)).toBe(32);
    expect(k.session.state().history?.undoSteps).toEqual(["32 Bits/Channel"]);
    // 8 → 32 decodes the sRGB transfer exactly: the view is the image.
    expect(await sourcePixels(k.session)).toEqual(before);
    await run(k, "modeBits8");
    expect(k.session.state().mode.bits).toBe(8);
    expect(await sourcePixels(k.session)).toEqual(before);
    k.dispose();
  });

  it("modeIndexed opens Indexed Color…; the Web palette flattens into its 216 colours", async () => {
    covers("command:media.paged.image.command.modeIndexed");
    const k = await ingested();
    await run(k, "modeIndexed");
    expect(k.session.state().dialog).toEqual({ kind: "indexedColor" });
    expect(await k.session.setIndexedColor("web")).toBe(true);
    expect(k.session.state().dialog).toBeNull();
    expect(k.session.state().mode.color).toBe("indexed");
    expect(k.session.state().history?.undoSteps).toEqual(["Indexed Color"]);
    expect(k.session.state().status).toMatch(/216 colours/);
    const px = await sourcePixels(k.session);
    for (let i = 0; i < px.px.length; i += 4)
      for (let c = 0; c < 3; c++) expect(px.px[i + c]! % 51).toBe(0);
    await run(k, "undo");
    expect(k.session.state().mode.color).toBe("rgb");
    k.dispose();
  });

  it("modeMultichannel keeps every colour in its three inks, one undo step", async () => {
    covers("command:media.paged.image.command.modeMultichannel");
    const k = await ingested();
    const before = await sourcePixels(k.session);
    await run(k, "modeMultichannel");
    expect(k.session.state().mode.color).toBe("multichannel");
    expect(k.session.state().history?.undoSteps).toEqual(["Multichannel"]);
    // Opaque source: the flatten over white and the inks change nothing.
    expect(await sourcePixels(k.session)).toEqual(before);
    k.dispose();
  });
});

describe("the proof view [image.io.depth-color-modes]", () => {
  it("proofSetupGray + proofColors simulates grey without touching the document", async () => {
    covers("command:media.paged.image.command.proofSetupGray");
    covers("command:media.paged.image.command.proofColors");
    const k = await ingested();
    const before = imageShape(k.session);
    const px = await sourcePixels(k.session);
    await run(k, "proofSetupGray");
    expect(k.session.state().mode.proof.target).toBe("gray");
    await run(k, "proofColors");
    expect(k.session.state().mode.proof.colors).toBe(true);
    expect(k.session.state().status).toMatch(/Proof view on/);
    const e = await imageEngine();
    expect(e.viewActive()).toBe(true);
    const shown = e.viewApply(Uint8Array.from(px.px), px.w, px.h);
    expect(Math.abs(shown[0] - shown[1])).toBeLessThanOrEqual(1);
    // The document is untouched.
    expect(imageShape(k.session)).toEqual(before);
    expect(await sourcePixels(k.session)).toEqual(px);
    await run(k, "proofColors");
    expect(k.session.state().mode.proof.colors).toBe(false);
    expect(e.viewActive()).toBe(false);
    k.dispose();
  });

  it("gamutWarning paints what grey cannot show grey", async () => {
    covers("command:media.paged.image.command.gamutWarning");
    const k = await ingested();
    const px = await sourcePixels(k.session);
    await run(k, "gamutWarning");
    expect(k.session.state().mode.proof).toMatchObject({
      target: "gray",
      gamut: true,
    });
    const e = await imageEngine();
    const shown = e.viewApply(Uint8Array.from(px.px), px.w, px.h);
    expect(Array.from(shown.slice(0, 4))).toEqual([128, 128, 128, 255]);
    await run(k, "gamutWarning");
    expect(e.viewActive()).toBe(false);
    k.dispose();
  });

  it("proofSetupCmyk without a CMYK profile refuses the proof and says why", async () => {
    covers("command:media.paged.image.command.proofSetupCmyk");
    const k = await ingested();
    await run(k, "proofSetupCmyk");
    expect(k.session.state().mode.proof.target).toBe("cmyk");
    await run(k, "proofColors");
    expect(k.session.state().status).toMatch(/needs a CMYK profile/);
    expect(k.session.state().mode.proof.colors).toBe(false);
    k.dispose();
  });
});

describe("a 16-bit source [image.io.depth-color-modes]", () => {
  it("ingests at 16 bits and opens a 16-bit layer stack", async () => {
    const e = await imageEngine();
    const info = e.decode(png16(4, 1, [0x1234, 0x5678, 0x9abc, 0xffff]));
    try {
      expect(e.imageBits(info.handle)).toBe(16);
      const s = e.imageSamples16(info.handle);
      expect(Array.from(s.slice(0, 3))).toEqual([0x1234, 0x5678, 0x9abc]);
      // The stack opens at the image's depth (it used to refuse a
      // 16-bit image: "layer stack: … bytes").
      e.layersOpen(info.handle);
      expect(e.imageBits(info.handle)).toBe(16);
      // A round trip through ingestRgba16 keeps every bit.
      const again = e.ingestRgba16(info.width, info.height, s);
      expect(Array.from(e.imageSamples16(again.handle))).toEqual(Array.from(s));
      e.freeImage(again.handle);
    } finally {
      e.layersClose();
      e.freeImage(info.handle);
    }
  });
});
