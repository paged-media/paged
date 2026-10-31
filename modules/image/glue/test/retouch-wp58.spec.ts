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

// WP5.8 — RETOUCHING through the bundle: the Content-Aware Fill workspace,
// Content-Aware Move, Remove (with its `ml.inpaint` hook), the Clone Source
// panel's sources and the healing options.
//
// These run on the REAL image-js wasm in Node: the PatchMatch search is
// CPU and its vote has a CPU twin, so a one-layer image retouches with no
// GPU. The image is a 64×32 two-colour PNG (red left, blue right) in the
// fake editor's 200×100 pt frame — 3.125 pt per pixel.

import { describe, expect, it } from "bun:test";

import { covers, gestures } from "@paged-media/test-kit";

import {
  at,
  BLUE,
  bundleOnFake,
  C,
  quiesce,
  RED,
  sourcePixels,
  twoColourPng,
} from "./command-kit";
import { movedBox, flatPoints } from "../src/retouch-tools";
import { wrapRetouch, type RetouchWasm } from "../src/retouch-engine";
import { applyRetouchSettings } from "../src/retouch-options";
import { hostInpaintProvider } from "../src/ml-inpaint";

const T = "media.paged.image.tool";
const PT = 200 / 64;

async function bigImage() {
  const k = await bundleOnFake();
  k.fake.placed.set("u1", await twoColourPng(64, 32));
  await k.ingest();
  return k;
}
type K = Awaited<ReturnType<typeof bigImage>>;

/** Marquee-select image pixels [x0, x1) × [y0, y1). */
async function select(k: K, x0: number, y0: number, x1: number, y1: number) {
  await gestures(k.toolTarget)
    .tool(`${T}.marqueeRect`)
    .settle()
    .drag({ from: [x0 * PT, y0 * PT], to: [x1 * PT, y1 * PT] })
    .settle();
  expect(k.session.state().selection).not.toBeNull();
}

const depth = (k: K) => k.session.state().history?.depth ?? 0;

describe("Content-Aware Fill workspace", () => {
  it("Edit ▸ Content-Aware Fill… opens the workspace: sampling area, overlay, preview; OK fills as one undo step", async () => {
    covers("command:media.paged.image.command.contentAwareFillWorkspace");
    const k = await bigImage();
    // A box inside the red half: the fill must come back red from its
    // surroundings, and the blue half must not change.
    await select(k, 6, 10, 14, 20);
    await k.run(`${C}.contentAwareFillWorkspace`);
    const s = k.session.state();
    expect(s.dialog?.kind).toBe("contentAwareFill");
    const caf = s.retouch.caf!;
    expect(caf.sampling).toBe("auto");
    expect(caf.sampledFraction).toBeGreaterThan(0);
    expect(caf.preview).not.toBeNull();
    expect(caf.preview!.rgba.length).toBe(
      caf.preview!.width * caf.preview!.height * 4,
    );
    const before = depth(k);
    expect(await k.session.commitContentAwareFill()).toBe(true);
    await quiesce(k.session);
    expect(depth(k)).toBe(before + 1);
    expect(k.session.state().dialog).toBeNull();
    const px = await sourcePixels(k.session);
    expect(at(px, 10, 15)).toEqual([...RED]);
    expect(at(px, 60, 15)).toEqual([...BLUE]);
    expect(await k.session.undo()).toBe(true);
    expect(depth(k)).toBe(before);
    k.dispose();
  });

  it("needs a selection, and says so", async () => {
    const k = await bigImage();
    await k.run(`${C}.contentAwareFillWorkspace`);
    expect(k.session.state().dialog).toBeNull();
    expect(k.session.state().status).toMatch(/needs a selection/);
    k.dispose();
  });

  it("the Sampling brush paints a custom area; Alt erases; Cancel leaves the image as it was", async () => {
    covers("tool:media.paged.image.tool.cafSampling");
    const k = await bigImage();
    await select(k, 6, 10, 14, 20);
    await k.session.openContentAwareFill();
    const g = gestures(k.toolTarget).tool(`${T}.cafSampling`).settle();
    k.session.setBrushParams({ size: 6 });
    await g.drag({ from: [40 * PT, 5 * PT], to: [50 * PT, 5 * PT] }).settle();
    const caf = k.session.state().retouch.caf!;
    expect(caf.sampling).toBe("custom");
    const mask = k.session.cafSamplingMask()!;
    expect(mask[5 * 64 + 45]).toBe(255);
    await g
      .drag({ from: [45 * PT, 5 * PT], to: [45 * PT, 5 * PT], mods: ["alt"] })
      .settle();
    expect(k.session.cafSamplingMask()![5 * 64 + 45]).toBe(0);
    const before = await sourcePixels(k.session);
    await k.session.cancelContentAwareFill();
    expect(k.session.state().retouch.caf).toBeNull();
    expect(await sourcePixels(k.session)).toEqual(before);
    k.dispose();
  });

  it("a new or duplicated layer output needs the GPU composite; without one it refuses before changing anything", async () => {
    const k = await bigImage();
    await select(k, 6, 10, 14, 20);
    await k.session.openContentAwareFill();
    await k.session.setContentAwareFill({
      output: "new-layer",
      fill: { colour: "none" },
    });
    const layers = k.session.state().layers.layers.length;
    const before = depth(k);
    expect(await k.session.commitContentAwareFill()).toBe(false);
    expect(k.session.state().status).toMatch(/needs the GPU/);
    expect(k.session.state().layers.layers.length).toBe(layers);
    expect(depth(k)).toBe(before);
    // The workspace stays open to pick another output.
    expect(k.session.state().retouch.caf).not.toBeNull();
    k.dispose();
  });

  it("changing the settings recomputes the preview; Rectangular widens the sampling area", async () => {
    const k = await bigImage();
    await select(k, 20, 10, 28, 20);
    await k.session.openContentAwareFill();
    const auto = k.session.state().retouch.caf!.sampledFraction;
    await k.session.setContentAwareFill({ sampling: "rect" });
    const rect = k.session.state().retouch.caf!.sampledFraction;
    expect(rect).toBeGreaterThanOrEqual(auto);
    await k.session.setContentAwareFill({
      fill: { rotation: "full", mirror: true, scale: true },
    });
    expect(k.session.state().retouch.caf!.fill).toMatchObject({
      rotation: "full",
      mirror: true,
      scale: true,
    });
    expect(k.session.state().retouch.caf!.preview).not.toBeNull();
    k.dispose();
  });
});

describe("Content-Aware Move", () => {
  it("a drag holds the move for its transform on drop; Enter commits one undo step", async () => {
    covers("tool:media.paged.image.tool.contentAwareMove");
    const k = await bigImage();
    await select(k, 4, 8, 12, 16);
    const g = gestures(k.toolTarget).tool(`${T}.contentAwareMove`).settle();
    await g.drag({ from: [8 * PT, 12 * PT], to: [18 * PT, 12 * PT] }).settle();
    expect(k.session.state().retouch.pendingMove).toMatchObject({
      dx: 10,
      dy: 0,
      scale: 100,
      angle: 0,
    });
    k.session.setMoveTransform({ scale: 120 });
    const before = depth(k);
    await g.key("Enter").settle();
    await quiesce(k.session);
    expect(k.session.state().retouch.pendingMove).toBeNull();
    expect(depth(k)).toBe(before + 1);
    expect(k.session.state().status).toMatch(/Content-Aware Move/);
    k.dispose();
  });

  it("Escape drops the pending move; without transform on drop the drop commits", async () => {
    const k = await bigImage();
    await select(k, 4, 8, 12, 16);
    const g = gestures(k.toolTarget).tool(`${T}.contentAwareMove`).settle();
    await g.drag({ from: [8 * PT, 12 * PT], to: [18 * PT, 12 * PT] }).settle();
    await g.key("Escape").settle();
    expect(k.session.state().retouch.pendingMove).toBeNull();
    const before = depth(k);
    k.session.setMoveOptions({ transformOnDrop: false, mode: "extend" });
    // Into the blue half, so the copy changes pixels.
    await g.drag({ from: [8 * PT, 12 * PT], to: [38 * PT, 12 * PT] }).settle();
    await quiesce(k.session);
    expect(depth(k)).toBe(before + 1);
    const px = await sourcePixels(k.session);
    // Extend keeps the source, and the copy arrives.
    expect(at(px, 8, 12)).toEqual([...RED]);
    expect(at(px, 38, 12)).toEqual([...RED]);
    k.dispose();
  });

  it("the preview outline is the selection box moved, scaled and turned", () => {
    const box = movedBox({ x: 0, y: 0, w: 10, h: 10 }, 5, 0, 200, 0);
    expect(box[0]).toEqual([0, -5]);
    expect(box[2]).toEqual([20, 15]);
    const turned = movedBox({ x: 0, y: 0, w: 2, h: 2 }, 0, 0, 100, 90);
    expect(turned[0][0]).toBeCloseTo(2);
    expect(turned[0][1]).toBeCloseTo(0);
  });
});

describe("Remove", () => {
  it("a stroke over an object fills it from its surroundings — one undo step", async () => {
    covers("tool:media.paged.image.tool.remove");
    const k = await bigImage();
    expect(k.session.state().retouch.inpaintProvider).toBeNull();
    k.session.setBrushParams({ size: 4 });
    const before = depth(k);
    await gestures(k.toolTarget)
      .tool(`${T}.remove`)
      .settle()
      .drag({
        from: [8 * PT, 10 * PT],
        via: [[12 * PT, 14 * PT]],
        to: [14 * PT, 16 * PT],
      })
      .settle();
    await quiesce(k.session);
    expect(depth(k)).toBe(before + 1);
    expect(at(await sourcePixels(k.session), 12, 14)).toEqual([...RED]);
    k.dispose();
  });

  it("asks an installed ml.inpaint provider first and lands its pixels; the default is no provider", async () => {
    const k = await bigImage();
    let asked = 0;
    k.session.setInpaintProvider({
      id: "test-inpainter",
      async inpaint({ rgba, mask }) {
        asked++;
        const out = rgba.slice();
        for (let i = 0; i < mask.length; i++)
          if (mask[i]) out.set([0, 255, 0, 255], i * 4);
        return out;
      },
    });
    expect(k.session.state().retouch.inpaintProvider).toBe("test-inpainter");
    expect(
      await k.session.removeStroke(flatPoints([[30, 16]]).concat(30, 16), 4),
    ).toBe(true);
    expect(asked).toBe(1);
    expect(at(await sourcePixels(k.session), 30, 16)).toEqual([0, 255, 0, 255]);
    expect(k.session.state().status).toMatch(/test-inpainter/);
    // A host without the door has no provider.
    expect(hostInpaintProvider({ supports: () => false } as never)).toBeNull();
    k.dispose();
  });
});

describe("Clone Source", () => {
  it("the Clone Source panel command opens its panel", async () => {
    covers("command:media.paged.image.command.openCloneSource");
    const k = await bigImage();
    await k.run(`${C}.openCloneSource`);
    expect(k.opened).toContain("media.paged.image.panel.cloneSource");
    k.dispose();
  });

  it("five sources: an Alt-click anchors the active one, and each keeps its own transform", async () => {
    const k = await bigImage();
    const r = k.session;
    expect(r.state().retouch.cloneSource.slots).toHaveLength(5);
    r.selectCloneSource(2);
    r.setCloneSource([10, 12]);
    expect(r.state().retouch.cloneSource.slots[2].anchor).toEqual([10, 12]);
    expect(r.state().retouch.cloneSource.slots[0].anchor).toBeNull();
    r.setCloneSourceSlot(2, { scaleW: -50, scaleH: 200, angle: 30 });
    r.setCloneSample("all");
    const s = r.strokeSampling("clone", true)!;
    expect(s).toMatchObject({
      mode: "all",
      scaleX: -0.5,
      scaleY: 2,
      angleDeg: 30,
      offset: null,
    });
    // Aligned carries the previous stroke's offset; unaligned does not.
    r.afterStroke([7, -3]);
    expect(r.strokeSampling("clone", true)!.offset).toEqual([7, -3]);
    expect(r.strokeSampling("clone", false)!.offset).toBeNull();
    // A typed offset (target − source) reaches the engine negated.
    r.setCloneSourceSlot(2, { offset: [5, 4] });
    expect(r.strokeSampling("clone", true)!.offset).toEqual([-5, -4]);
    r.resetCloneTransform(2);
    expect(r.state().retouch.cloneSource.slots[2]).toMatchObject({
      offset: null,
      scaleW: 100,
      scaleH: 100,
      angle: 0,
    });
    // A new anchor drops the carried offset.
    r.setCloneSource([1, 1]);
    expect(r.state().retouch.cloneSource.carried).toBeNull();
    expect(r.strokeSampling("brush", true)).toBeNull();
    k.dispose();
  });

  it("the healing brush and the spot healing brush carry diffusion, sample and type", async () => {
    const k = await bigImage();
    const r = k.session;
    r.setHealOptions({ diffusion: 9, spotType: "proximity", sample: "below" });
    expect(r.state().retouch.heal.diffusion).toBe(7);
    expect(r.strokeSampling("heal", true)).toMatchObject({
      diffusion: 7,
      mode: "below",
    });
    expect(r.strokeSampling("spot-heal", true)).toMatchObject({
      spot: "proximity",
      mode: "below",
      offset: null,
    });
    k.dispose();
  });

  it("the overlay reads the source through the engine (whole image or clipped)", async () => {
    const k = await bigImage();
    const r = k.session;
    // No anchor: nothing to show.
    expect(await r.cloneOverlayAt([10, 10], 4)).toBe(false);
    r.setCloneSource([40, 10]);
    r.setCloneOverlay({ opacity: 100, clipped: false, invert: false });
    expect(await r.cloneOverlayAt([10, 10], 4)).toBe(true);
    expect(await r.cloneOverlayAt(null, 0)).toBe(false);
    k.dispose();
  });
});

describe("the retouching tool options", () => {
  it("apply to the session in its own units", async () => {
    const k = await bigImage();
    const r = k.session;
    applyRetouchSettings(r, "move", {
      mode: "extend",
      structure: 9,
      colour: 3,
      transformOnDrop: false,
      sampleAll: true,
    });
    expect(r.state().retouch.move).toEqual({
      mode: "extend",
      structure: 7,
      colour: 3,
      transformOnDrop: false,
      sampleAll: true,
    });
    applyRetouchSettings(r, "spotHeal", {
      type: "create-texture",
      diffusion: 2,
    });
    expect(r.state().retouch.heal).toMatchObject({
      spotType: "create-texture",
      diffusion: 2,
    });
    applyRetouchSettings(r, "clone", { sample: "below", aligned: true });
    expect(r.state().retouch.cloneSource.sample).toBe("below");
    applyRetouchSettings(r, "remove", { sampleAll: true });
    expect(r.state().retouch.remove.sampleAll).toBe(true);
    // Wrong types are ignored.
    applyRetouchSettings(r, "heal", { diffusion: "x", sample: "nope" });
    expect(r.state().retouch.heal.diffusion).toBe(2);
    k.dispose();
  });
});

describe("the retouching engine facade", () => {
  it("forwards every door with its arguments in order", async () => {
    const calls: unknown[][] = [];
    const rec =
      (name: string, ret: unknown) =>
      (...a: unknown[]) => {
        calls.push([name, ...a]);
        return ret;
      };
    const handle = {
      handle: 3,
      width: 4,
      height: 2,
      display: 0,
      depth_reduced: false,
      free() {},
    };
    const wasm = {
      caf_sampling_area: rec("area", new Uint8Array(1)),
      caf_overlay: rec("overlay", new Uint8Array(4)),
      caf_preview: rec("preview", {
        x: 1,
        y: 2,
        region_w: 3,
        region_h: 4,
        width: 5,
        height: 6,
        rgba: new Uint8Array(120),
        free() {},
      }),
      content_aware_fill_ex: rec("fill", Promise.resolve(handle)),
      content_aware_move: rec("move", Promise.resolve(handle)),
      remove_hole: rec("hole", new Uint8Array(8)),
      remove_stroke: rec("remove", Promise.resolve(handle)),
      remove_with_pixels: rec("removePx", Promise.resolve(handle)),
      brush_stroke_set_sampling: rec("sampling", Promise.resolve()),
      brush_stroke_source_offset: rec("offset", new Float32Array([2, 3])),
      clone_overlay: rec("clone", Promise.resolve(new Uint8Array(4))),
    } as unknown as RetouchWasm;
    const e = wrapRetouch(wasm, (h) => h.handle);
    const fill = {
      colour: "high" as const,
      rotation: "low" as const,
      scale: true,
      mirror: false,
      seed: 7,
    };
    expect(e.cafPreview(9, null, fill, 256, true)).toMatchObject({
      x: 1,
      regionW: 3,
      width: 5,
    });
    expect(await e.contentAwareFillEx(9, null, fill, "duplicate", false)).toBe(
      3,
    );
    await e.contentAwareMove(9, {
      dx: 4,
      dy: -2,
      mode: "move",
      structure: 5,
      colour: 6,
      scale: 1.5,
      angleDeg: 10,
      sampleAll: true,
    });
    await e.brushSetSampling({
      mode: "all",
      scaleX: -1,
      scaleY: 1,
      angleDeg: 0,
      offset: [5, 6],
      diffusion: 3,
      spot: "proximity",
    });
    expect(e.brushSourceOffset()).toEqual([2, 3]);
    const names = calls.map((c) => c[0]);
    expect(names).toEqual(["preview", "fill", "move", "sampling", "offset"]);
    expect(calls[1].slice(3)).toEqual([
      "high",
      "low",
      true,
      false,
      7,
      "duplicate",
      false,
    ]);
    expect(calls[2].slice(1)).toEqual([9, 4, -2, "move", 5, 6, 1.5, 10, true]);
    expect(calls[3].slice(1)).toEqual([
      "all",
      -1,
      1,
      0,
      true,
      5,
      6,
      3,
      "proximity",
    ]);
  });
});
