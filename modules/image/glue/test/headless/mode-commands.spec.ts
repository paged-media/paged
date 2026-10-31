// Image ▸ Mode and Image ▸ Proof (image ADR 479) against the REAL canvas
// engine (the headless host): the integration twin of mode.spec.ts. A
// depth or colour-mode change is one step on the IMAGE's undo list and
// sends the document nothing until Commit, which carries the converted
// pixels in one document change; the proof view changes nothing at all.

import { describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { bundleOnHeadless, C, quiesce, sourcePixels } from "../command-kit";

async function ingested() {
  const k = await bundleOnHeadless();
  await k.ingest();
  return k;
}
type K = Awaited<ReturnType<typeof ingested>>;

async function run(k: K, id: string) {
  await k.run(`${C}.${id}`);
  await quiesce(k.session);
}

describe("[image.io.depth-color-modes] Image ▸ Mode on the headless host", () => {
  it("modeBits16 and modeBits8 are image undo steps; the document hears of them at Commit", async () => {
    covers("command:media.paged.image.command.modeBits16");
    covers("command:media.paged.image.command.modeBits8");
    const k = await ingested();
    await run(k, "modeBits16");
    expect(k.session.state().mode.bits).toBe(16);
    await run(k, "modeBits8");
    expect(k.session.state().mode.bits).toBe(8);
    expect(k.session.state().history?.undoSteps).toEqual([
      "16 Bits/Channel",
      "8 Bits/Channel",
    ]);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("modeGray, modeLab and modeRgb convert the image; Commit carries the grey pixels", async () => {
    covers("command:media.paged.image.command.modeGray");
    covers("command:media.paged.image.command.modeLab");
    covers("command:media.paged.image.command.modeRgb");
    const k = await ingested();
    await run(k, "modeGray");
    expect(k.session.state().mode.color).toBe("gray");
    const grey = await sourcePixels(k.session);
    for (let i = 0; i < grey.px.length; i += 4) {
      expect(Math.abs(grey.px[i]! - grey.px[i + 1]!)).toBeLessThanOrEqual(1);
      expect(Math.abs(grey.px[i + 1]! - grey.px[i + 2]!)).toBeLessThanOrEqual(
        1,
      );
    }
    expect(k.changes()).toBe(0);
    await k.commit();
    expect(k.changes()).toBe(1);
    await run(k, "modeLab");
    expect(k.session.state().mode.color).toBe("lab");
    await run(k, "modeRgb");
    expect(k.session.state().mode.color).toBe("rgb");
    expect(k.session.state().history?.undoSteps).toEqual([
      "Grayscale",
      "Lab Color",
      "RGB Color",
    ]);
    k.dispose();
  });

  it("modeBits32, modeIndexed and modeMultichannel are image undo steps; Commit carries them", async () => {
    covers("command:media.paged.image.command.modeBits32");
    covers("command:media.paged.image.command.modeIndexed");
    covers("command:media.paged.image.command.modeMultichannel");
    const k = await ingested();
    await run(k, "modeBits32");
    expect(k.session.state().mode.bits).toBe(32);
    await run(k, "modeBits8");
    await run(k, "modeMultichannel");
    expect(k.session.state().mode.color).toBe("multichannel");
    await run(k, "modeRgb");
    await run(k, "modeIndexed");
    expect(k.session.state().dialog?.kind).toBe("indexedColor");
    expect(await k.session.setIndexedColor("adaptive", 16)).toBe(true);
    expect(k.session.state().mode.color).toBe("indexed");
    expect(k.session.state().history?.undoSteps).toEqual([
      "32 Bits/Channel",
      "8 Bits/Channel",
      "Multichannel",
      "RGB Color",
      "Indexed Color",
    ]);
    expect(k.changes()).toBe(0);
    await k.commit();
    expect(k.changes()).toBe(1);
    k.dispose();
  });

  it("modeCmyk without a CMYK profile keeps every colour and says so", async () => {
    covers("command:media.paged.image.command.modeCmyk");
    const k = await ingested();
    const before = await sourcePixels(k.session);
    await run(k, "modeCmyk");
    expect(k.session.state().mode.color).toBe("cmyk");
    expect(k.session.state().status).toMatch(/without a CMYK profile/);
    expect(await sourcePixels(k.session)).toEqual(before);
    expect(k.changes()).toBe(0);
    k.dispose();
  });
});

describe("[image.io.depth-color-modes] Image ▸ Proof on the headless host", () => {
  it("proof colours and the gamut warning on grey change nothing in the image or the document", async () => {
    covers("command:media.paged.image.command.proofSetupGray");
    covers("command:media.paged.image.command.proofColors");
    covers("command:media.paged.image.command.gamutWarning");
    const k = await ingested();
    const before = await sourcePixels(k.session);
    await run(k, "proofSetupGray");
    await run(k, "proofColors");
    await run(k, "gamutWarning");
    expect(k.session.state().mode.proof).toEqual({
      target: "gray",
      colors: true,
      gamut: true,
    });
    expect(await sourcePixels(k.session)).toEqual(before);
    expect(k.session.state().history?.undoSteps ?? []).toEqual([]);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("proofSetupCmyk then proof colours without a profile is refused with the reason", async () => {
    covers("command:media.paged.image.command.proofSetupCmyk");
    const k = await ingested();
    await run(k, "proofSetupCmyk");
    expect(k.session.state().mode.proof.target).toBe("cmyk");
    await run(k, "proofColors");
    expect(k.session.state().status).toMatch(/needs a CMYK profile/);
    expect(k.changes()).toBe(0);
    k.dispose();
  });
});
