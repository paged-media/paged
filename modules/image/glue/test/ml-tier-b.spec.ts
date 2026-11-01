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

// WP8.2 Tier B and the neural filters (image ADR 485) over the REAL image
// wasm, the SDK's fake provider and a scripted segmenter. The fake computes
// (an inversion, a gradient, a nearest-neighbour enlargement); it is not a
// model and nothing is downloaded.

import { describe, expect, it } from "bun:test";

import { createMlRegistry, fakeMlProvider } from "@paged-media/plugin-sdk";

import { crop, maskBox, paddedBox, paste, workSize } from "../src/ml-features";
import { covers } from "@paged-media/test-kit";

import { bundleOnFake, C } from "./command-kit";
import { scripted } from "./ml-kit";

async function ingested(opts: { fake?: boolean; script?: boolean } = {}) {
  const ml = createMlRegistry();
  // With the scripted segmenter present the fake leaves segmentation and
  // matting to it (the fake's brightness mask is empty on the dark image).
  const fake = fakeMlProvider(
    opts.script
      ? {
          capabilities: [
            "inpaint",
            "superres",
            "landmarks",
            "generate",
            "edit",
          ],
        }
      : {},
  );
  if (opts.fake !== false) fake.attach(ml.register(fake));
  const s = scripted();
  if (opts.script) ml.register(s.provider);
  const k = await bundleOnFake({ ml });
  await k.ingest();
  return { k, ml, fake, ...s };
}
type K = Awaited<ReturnType<typeof ingested>>["k"];
const depth = (k: K) => k.session.state().history?.depth ?? 0;
const layers = (k: K) => k.session.state().layers.layers;
const selectLeft = (k: K) => {
  const m = k.session.selectionMachine()!;
  m.begin("rect", [0, 0], "replace");
  m.update([2, 2]);
  m.end();
  k.session.refreshSelection();
};

describe("[image.ml.generative-fill] Generative Fill", () => {
  it("lands a layer masked by the selection, one undo step", async () => {
    const { k, fake } = await ingested();
    selectLeft(k);
    const d0 = depth(k);
    expect(await k.session.ml().generativeFill("a red door")).toBe(true);
    expect(layers(k)).toHaveLength(2);
    expect(layers(k)[1]!.hasMask).toBe(true);
    expect(depth(k)).toBe(d0 + 1);
    const call = fake.calls.find((c) => c.capability === "edit")!;
    const req = call.request as { prompt: string; image: { width: number } };
    expect(req.prompt).toBe("a red door");
    expect(req.image.width % 8).toBe(0);
    await k.session.undo();
    expect(layers(k)).toHaveLength(1);
    k.dispose();
  });

  it("needs a prompt and a selection and changes nothing without them", async () => {
    const { k } = await ingested();
    expect(await k.session.ml().generativeFill("x")).toBe(false);
    expect(k.session.state().status).toMatch(/needs a selection/);
    selectLeft(k);
    expect(await k.session.ml().generativeFill("  ")).toBe(false);
    expect(k.session.state().status).toMatch(/needs a prompt/);
    expect(layers(k)).toHaveLength(1);
    k.dispose();
  });

  it("without a model it reports the registry's message", async () => {
    const { k } = await ingested({ fake: false });
    selectLeft(k);
    expect(await k.session.ml().generativeFill("x")).toBe(false);
    expect(k.session.state().status).toMatch(/Generative Fill failed/);
    expect(layers(k)).toHaveLength(1);
    expect(k.session.state().ml.busy).toBe(false);
    k.dispose();
  });
});

describe("[image.ml.generative-expand] Generative Expand", () => {
  it("grows the canvas and adds the masked border layer in one step", async () => {
    const { k } = await ingested();
    const d0 = depth(k);
    expect(
      await k.session.ml().generativeExpand("more sky", {
        width: 8,
        height: 4,
        anchorX: 1,
        anchorY: 1,
      }),
    ).toBe(true);
    const src = k.session.state().source!;
    expect([src.width, src.height]).toEqual([8, 4]);
    expect(layers(k)).toHaveLength(2);
    expect(layers(k)[1]!.hasMask).toBe(true);
    expect(depth(k)).toBe(d0 + 1);
    await k.session.undo();
    const back = k.session.state().source!;
    expect([back.width, back.height]).toEqual([4, 2]);
    expect(layers(k)).toHaveLength(1);
    k.dispose();
  });

  it("refuses a canvas that does not grow", async () => {
    const { k } = await ingested();
    expect(
      await k.session
        .ml()
        .generativeExpand("x", { width: 4, height: 2, anchorX: 1, anchorY: 1 }),
    ).toBe(false);
    expect(k.session.state().status).toMatch(/must grow/);
    k.dispose();
  });
});

describe("[image.ml.remove-hq] Remove (high quality) and Remove Background", () => {
  it("fills the selection through the model, one undo step", async () => {
    const { k, fake } = await ingested();
    selectLeft(k);
    const d0 = depth(k);
    expect(await k.session.ml().removeSelection()).toBe(true);
    // The fake is Tier A: the Tier B edit is refused, the inpaint answers.
    expect(fake.calls.map((c) => c.capability)).toContain("inpaint");
    expect(depth(k)).toBe(d0 + 1);
    expect(layers(k)).toHaveLength(1);
    await k.session.undo();
    expect(depth(k)).toBe(d0);
    k.dispose();
  });

  it("falls back to the classical fill when no model answers", async () => {
    const { k } = await ingested({ fake: false });
    selectLeft(k);
    await k.session.ml().removeSelection();
    expect(k.session.state().ml.busy).toBe(false);
    // No model answered: the classical content-aware fill ran (a 4×2
    // image has no room for a patch, which it reports by name).
    expect(k.session.state().status).toMatch(/Fill/);
    k.dispose();
  });

  it("Remove Background masks the active layer from the matte", async () => {
    const { k } = await ingested({ script: true });
    expect(layers(k)[0]!.hasMask).toBe(false);
    const d0 = depth(k);
    expect(await k.session.ml().removeBackground()).toBe(true);
    expect(layers(k)[0]!.hasMask).toBe(true);
    expect(depth(k)).toBe(d0 + 1);
    await k.session.undo();
    expect(layers(k)[0]!.hasMask).toBe(false);
    k.dispose();
  });
});

describe("[image.ml.generate-image] Generate Image", () => {
  it("one variation lands as a layer", async () => {
    const { k, fake } = await ingested();
    expect(await k.session.ml().generateImage("a lake", { seed: 3 })).toBe(
      true,
    );
    expect(layers(k)).toHaveLength(2);
    expect(layers(k)[1]!.hasMask).toBe(false);
    const req = fake.calls.find((c) => c.capability === "generate")!
      .request as { width: number; seed: number };
    expect(req.width % 8).toBe(0);
    expect(req.seed).toBe(3);
    k.dispose();
  });

  it("several variations wait in the strip until one is placed", async () => {
    const { k, fake } = await ingested();
    const d0 = depth(k);
    expect(
      await k.session.ml().generateImage("a lake", { variations: 3, seed: 10 }),
    ).toBe(true);
    expect(layers(k)).toHaveLength(1);
    expect(depth(k)).toBe(d0);
    const strip = k.session.state().ml.candidates;
    expect(strip).toHaveLength(3);
    expect(
      fake.calls
        .filter((c) => c.capability === "generate")
        .map((c) => (c.request as { seed: number }).seed),
    ).toEqual([10, 11, 12]);
    expect(await k.session.ml().placeCandidate(strip[1]!.id, "a lake")).toBe(
      true,
    );
    expect(layers(k)).toHaveLength(2);
    expect(depth(k)).toBe(d0 + 1);
    expect(k.session.state().ml.candidates).toHaveLength(0);
    k.dispose();
  });

  it("needs a prompt", async () => {
    const { k } = await ingested();
    expect(await k.session.ml().generateImage("")).toBe(false);
    expect(k.session.state().status).toMatch(/needs a prompt/);
    k.dispose();
  });
});

describe("[image.ml.presets] presets and neural filters", () => {
  it("Sky Replacement selects the sky first, then fills it", async () => {
    const { k, fake } = await ingested({ script: true });
    expect(await k.session.ml().skyReplacement("a sunset")).toBe(true);
    expect(layers(k)).toHaveLength(2);
    const edit = fake.calls.find((c) => c.capability === "edit")!.request as {
      prompt: string;
    };
    expect(edit.prompt).toMatch(/sunset/);
    k.dispose();
  });

  it("Colorize works on the whole image without a selection", async () => {
    const { k } = await ingested();
    expect(await k.session.ml().colorize()).toBe(true);
    expect(layers(k)).toHaveLength(2);
    k.dispose();
  });

  it("Skin Smoothing masks the faces landmarks found, at a low strength", async () => {
    const { k, fake } = await ingested();
    expect(await k.session.ml().skinSmoothing()).toBe(true);
    const edit = fake.calls.find((c) => c.capability === "edit")!.request as {
      strength: number;
    };
    expect(edit.strength).toBeCloseTo(0.35);
    expect(layers(k)).toHaveLength(2);
    k.dispose();
  });

  it("Super Zoom and JPEG Artifact Removal add a layer each", async () => {
    const { k, fake } = await ingested();
    expect(await k.session.ml().superZoom(2)).toBe(true);
    expect(layers(k)).toHaveLength(2);
    expect(await k.session.ml().removeJpegArtifacts()).toBe(true);
    expect(layers(k)).toHaveLength(3);
    expect(fake.calls.filter((c) => c.capability === "superres")).toHaveLength(
      2,
    );
    k.dispose();
  });
});

describe("the pure geometry of the Tier B regions", () => {
  it("workSize shrinks to 1024 and snaps to multiples of 8, 64 at the least", () => {
    expect(workSize(4, 2)).toEqual({ width: 64, height: 64 });
    expect(workSize(2000, 1000)).toEqual({ width: 1024, height: 512 });
    const w = workSize(333, 777);
    expect(w.width % 8).toBe(0);
    expect(w.height % 8).toBe(0);
  });

  it("maskBox, paddedBox, crop and paste", () => {
    const mask = new Uint8Array(6 * 4);
    mask[1 * 6 + 2] = 255;
    mask[2 * 6 + 3] = 255;
    expect(maskBox(mask, 6, 4)).toEqual({ x: 2, y: 1, width: 2, height: 2 });
    expect(maskBox(new Uint8Array(24), 6, 4)).toBeNull();
    const box = paddedBox({ x: 2, y: 1, width: 2, height: 2 }, 6, 4);
    expect(box).toEqual({ x: 0, y: 0, width: 6, height: 4 });
    const img = Uint8Array.from({ length: 6 * 4 }, (_, i) => i);
    const piece = crop(img, 6, { x: 1, y: 1, width: 2, height: 2 }, 1);
    expect(Array.from(piece)).toEqual([7, 8, 13, 14]);
    const into = new Uint8Array(24);
    paste(into, 6, { x: 4, y: 2, width: 2, height: 2 }, piece, 1);
    expect(into[2 * 6 + 4]).toBe(7);
    expect(into[3 * 6 + 5]).toBe(14);
  });
});

describe("[image.ml.generate-image] the Tier B commands (payload carries the prompt)", () => {
  it("generateImage, generativeFill, generativeExpand", async () => {
    covers("command:media.paged.image.command.generateImage");
    covers("command:media.paged.image.command.generativeFill");
    covers("command:media.paged.image.command.generativeExpand");
    const { k } = await ingested();
    await k.run(`${C}.generateImage`, { prompt: "a lake", variations: 2 });
    expect(k.session.state().ml.candidates).toHaveLength(2);
    k.session.ml().clearCandidates();
    selectLeft(k);
    await k.run(`${C}.generativeFill`, { prompt: "a door", seed: 4, steps: 5 });
    expect(layers(k)).toHaveLength(2);
    await k.run(`${C}.generativeExpand`, {
      prompt: "more",
      width: 8,
      height: 4,
    });
    expect(k.session.state().source!.width).toBe(8);
    k.dispose();
  });

  it("without a prompt the prompted commands raise the panel and do nothing else", async () => {
    const { k } = await ingested();
    const before = k.opened.length;
    for (const id of ["generateImage", "generativeFill", "generativeExpand"])
      await k.run(`${C}.${id}`);
    expect(k.opened.slice(before)).toEqual(
      Array(3).fill("media.paged.image.panel.adjustments"),
    );
    expect(layers(k)).toHaveLength(1);
    k.dispose();
  });

  it("removeHq, removeBackground and the presets", async () => {
    covers("command:media.paged.image.command.removeHq");
    covers("command:media.paged.image.command.removeBackground");
    covers("command:media.paged.image.command.skyReplacement");
    covers("command:media.paged.image.command.colorize");
    covers("command:media.paged.image.command.skinSmoothing");
    const { k } = await ingested({ script: true });
    selectLeft(k);
    const d0 = depth(k);
    await k.run(`${C}.removeHq`);
    expect(depth(k)).toBe(d0 + 1);
    await k.run(`${C}.removeBackground`);
    expect(layers(k)[0]!.hasMask).toBe(true);
    await k.run(`${C}.skyReplacement`, { prompt: "dusk" });
    await k.run(`${C}.colorize`);
    await k.run(`${C}.skinSmoothing`);
    expect(layers(k)).toHaveLength(4);
    k.dispose();
  });

  it("superZoom and jpegArtifacts", async () => {
    covers("command:media.paged.image.command.superZoom");
    covers("command:media.paged.image.command.jpegArtifacts");
    const { k } = await ingested();
    await k.run(`${C}.superZoom`, { scale: 4 });
    await k.run(`${C}.jpegArtifacts`);
    expect(layers(k)).toHaveLength(3);
    k.dispose();
  });
});
