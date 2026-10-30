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

// @feat: image.layers.photoshop-parity
//
// The integration twin of layer-commands.spec.ts: the Layer menu's
// parity commands against the REAL canvas engine (the headless host).
// Every verb acts on the image's own layer stack and history; the
// DOCUMENT receives nothing until Commit.

import { describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { bundleOnHeadless, C, imageShape, sourcePixels } from "../command-kit";

async function ingested() {
  const k = await bundleOnHeadless();
  await k.ingest();
  return k;
}

describe("the Layer menu's parity commands over the real document [image.layers.photoshop-parity]", () => {
  it("newFillSolid declines without WebGPU (the fill renders on the GPU) and changes nothing", async () => {
    covers("command:media.paged.image.command.newFillSolid");
    const k = await ingested();
    const before = imageShape(k.session);
    await k.run(`${C}.newFillSolid`);
    expect(k.session.state().status).toMatch(/GPU-only/);
    expect(imageShape(k.session)).toEqual(before);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("newFillGradient declines without WebGPU (the fill renders on the GPU) and changes nothing", async () => {
    covers("command:media.paged.image.command.newFillGradient");
    const k = await ingested();
    const before = imageShape(k.session);
    await k.run(`${C}.newFillGradient`);
    expect(k.session.state().status).toMatch(/GPU-only/);
    expect(imageShape(k.session)).toEqual(before);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("newFillPattern declines without WebGPU (the fill renders on the GPU) and changes nothing", async () => {
    covers("command:media.paged.image.command.newFillPattern");
    const k = await ingested();
    const before = imageShape(k.session);
    await k.run(`${C}.newFillPattern`);
    expect(k.session.state().status).toMatch(/GPU-only/);
    expect(imageShape(k.session)).toEqual(before);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("newAdjustmentBrightnessContrast adds a Brightness/Contrast layer as one undo step", async () => {
    covers("command:media.paged.image.command.newAdjustmentBrightnessContrast");
    const k = await ingested();
    await k.run(`${C}.newAdjustmentBrightnessContrast`);
    const s = k.session.state();
    expect(s.layers.layers.map((l) => [l.kind, l.adjustKind])).toEqual([
      ["pixels", null],
      ["adjustment", "brightnessContrast"],
    ]);
    expect(s.history?.undoSteps).toEqual(["New Adjustment Layer"]);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers).toHaveLength(1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("newAdjustmentLevels adds a Levels layer as one undo step", async () => {
    covers("command:media.paged.image.command.newAdjustmentLevels");
    const k = await ingested();
    await k.run(`${C}.newAdjustmentLevels`);
    const s = k.session.state();
    expect(s.layers.layers.map((l) => [l.kind, l.adjustKind])).toEqual([
      ["pixels", null],
      ["adjustment", "levels"],
    ]);
    expect(s.history?.undoSteps).toEqual(["New Adjustment Layer"]);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers).toHaveLength(1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("newAdjustmentCurves adds a Curves layer as one undo step", async () => {
    covers("command:media.paged.image.command.newAdjustmentCurves");
    const k = await ingested();
    await k.run(`${C}.newAdjustmentCurves`);
    const s = k.session.state();
    expect(s.layers.layers.map((l) => [l.kind, l.adjustKind])).toEqual([
      ["pixels", null],
      ["adjustment", "curves"],
    ]);
    expect(s.history?.undoSteps).toEqual(["New Adjustment Layer"]);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers).toHaveLength(1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("newAdjustmentExposure adds a Exposure layer as one undo step", async () => {
    covers("command:media.paged.image.command.newAdjustmentExposure");
    const k = await ingested();
    await k.run(`${C}.newAdjustmentExposure`);
    const s = k.session.state();
    expect(s.layers.layers.map((l) => [l.kind, l.adjustKind])).toEqual([
      ["pixels", null],
      ["adjustment", "exposure"],
    ]);
    expect(s.history?.undoSteps).toEqual(["New Adjustment Layer"]);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers).toHaveLength(1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("newAdjustmentVibrance adds a Vibrance layer as one undo step", async () => {
    covers("command:media.paged.image.command.newAdjustmentVibrance");
    const k = await ingested();
    await k.run(`${C}.newAdjustmentVibrance`);
    const s = k.session.state();
    expect(s.layers.layers.map((l) => [l.kind, l.adjustKind])).toEqual([
      ["pixels", null],
      ["adjustment", "vibrance"],
    ]);
    expect(s.history?.undoSteps).toEqual(["New Adjustment Layer"]);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers).toHaveLength(1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("newAdjustmentHueSaturation adds a Hue/Saturation layer as one undo step", async () => {
    covers("command:media.paged.image.command.newAdjustmentHueSaturation");
    const k = await ingested();
    await k.run(`${C}.newAdjustmentHueSaturation`);
    const s = k.session.state();
    expect(s.layers.layers.map((l) => [l.kind, l.adjustKind])).toEqual([
      ["pixels", null],
      ["adjustment", "hueSaturation"],
    ]);
    expect(s.history?.undoSteps).toEqual(["New Adjustment Layer"]);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers).toHaveLength(1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("newAdjustmentColorBalance adds a Color Balance layer as one undo step", async () => {
    covers("command:media.paged.image.command.newAdjustmentColorBalance");
    const k = await ingested();
    await k.run(`${C}.newAdjustmentColorBalance`);
    const s = k.session.state();
    expect(s.layers.layers.map((l) => [l.kind, l.adjustKind])).toEqual([
      ["pixels", null],
      ["adjustment", "colorBalance"],
    ]);
    expect(s.history?.undoSteps).toEqual(["New Adjustment Layer"]);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers).toHaveLength(1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("newAdjustmentBlackWhite adds a Black & White layer as one undo step", async () => {
    covers("command:media.paged.image.command.newAdjustmentBlackWhite");
    const k = await ingested();
    await k.run(`${C}.newAdjustmentBlackWhite`);
    const s = k.session.state();
    expect(s.layers.layers.map((l) => [l.kind, l.adjustKind])).toEqual([
      ["pixels", null],
      ["adjustment", "blackWhite"],
    ]);
    expect(s.history?.undoSteps).toEqual(["New Adjustment Layer"]);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers).toHaveLength(1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("newAdjustmentPhotoFilter adds a Photo Filter layer as one undo step", async () => {
    covers("command:media.paged.image.command.newAdjustmentPhotoFilter");
    const k = await ingested();
    await k.run(`${C}.newAdjustmentPhotoFilter`);
    const s = k.session.state();
    expect(s.layers.layers.map((l) => [l.kind, l.adjustKind])).toEqual([
      ["pixels", null],
      ["adjustment", "photoFilter"],
    ]);
    expect(s.history?.undoSteps).toEqual(["New Adjustment Layer"]);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers).toHaveLength(1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("newAdjustmentChannelMixer adds a Channel Mixer layer as one undo step", async () => {
    covers("command:media.paged.image.command.newAdjustmentChannelMixer");
    const k = await ingested();
    await k.run(`${C}.newAdjustmentChannelMixer`);
    const s = k.session.state();
    expect(s.layers.layers.map((l) => [l.kind, l.adjustKind])).toEqual([
      ["pixels", null],
      ["adjustment", "channelMixer"],
    ]);
    expect(s.history?.undoSteps).toEqual(["New Adjustment Layer"]);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers).toHaveLength(1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("newAdjustmentColorLookup adds a Color Lookup layer as one undo step", async () => {
    covers("command:media.paged.image.command.newAdjustmentColorLookup");
    const k = await ingested();
    await k.run(`${C}.newAdjustmentColorLookup`);
    const s = k.session.state();
    expect(s.layers.layers.map((l) => [l.kind, l.adjustKind])).toEqual([
      ["pixels", null],
      ["adjustment", "colorLookup"],
    ]);
    expect(s.history?.undoSteps).toEqual(["New Adjustment Layer"]);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers).toHaveLength(1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("newAdjustmentInvert adds a Invert layer as one undo step", async () => {
    covers("command:media.paged.image.command.newAdjustmentInvert");
    const k = await ingested();
    await k.run(`${C}.newAdjustmentInvert`);
    const s = k.session.state();
    expect(s.layers.layers.map((l) => [l.kind, l.adjustKind])).toEqual([
      ["pixels", null],
      ["adjustment", "invert"],
    ]);
    expect(s.history?.undoSteps).toEqual(["New Adjustment Layer"]);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers).toHaveLength(1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("newAdjustmentPosterize adds a Posterize layer as one undo step", async () => {
    covers("command:media.paged.image.command.newAdjustmentPosterize");
    const k = await ingested();
    await k.run(`${C}.newAdjustmentPosterize`);
    const s = k.session.state();
    expect(s.layers.layers.map((l) => [l.kind, l.adjustKind])).toEqual([
      ["pixels", null],
      ["adjustment", "posterize"],
    ]);
    expect(s.history?.undoSteps).toEqual(["New Adjustment Layer"]);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers).toHaveLength(1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("newAdjustmentThreshold adds a Threshold layer as one undo step", async () => {
    covers("command:media.paged.image.command.newAdjustmentThreshold");
    const k = await ingested();
    await k.run(`${C}.newAdjustmentThreshold`);
    const s = k.session.state();
    expect(s.layers.layers.map((l) => [l.kind, l.adjustKind])).toEqual([
      ["pixels", null],
      ["adjustment", "threshold"],
    ]);
    expect(s.history?.undoSteps).toEqual(["New Adjustment Layer"]);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers).toHaveLength(1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("newAdjustmentGradientMap adds a Gradient Map layer as one undo step", async () => {
    covers("command:media.paged.image.command.newAdjustmentGradientMap");
    const k = await ingested();
    await k.run(`${C}.newAdjustmentGradientMap`);
    const s = k.session.state();
    expect(s.layers.layers.map((l) => [l.kind, l.adjustKind])).toEqual([
      ["pixels", null],
      ["adjustment", "gradientMap"],
    ]);
    expect(s.history?.undoSteps).toEqual(["New Adjustment Layer"]);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers).toHaveLength(1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("newAdjustmentSelectiveColor adds a Selective Color layer as one undo step", async () => {
    covers("command:media.paged.image.command.newAdjustmentSelectiveColor");
    const k = await ingested();
    await k.run(`${C}.newAdjustmentSelectiveColor`);
    const s = k.session.state();
    expect(s.layers.layers.map((l) => [l.kind, l.adjustKind])).toEqual([
      ["pixels", null],
      ["adjustment", "selectiveColor"],
    ]);
    expect(s.history?.undoSteps).toEqual(["New Adjustment Layer"]);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers).toHaveLength(1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("blendingOptions opens the Blending Options dialog on the active layer", async () => {
    covers("command:media.paged.image.command.blendingOptions");
    const k = await ingested();
    await k.run(`${C}.blendingOptions`);
    expect(k.session.state().dialog).toEqual({
      kind: "blendingOptions",
      index: 0,
    });
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("rasterizeLayer refuses on a pixel layer and changes nothing", async () => {
    covers("command:media.paged.image.command.rasterizeLayer");
    const k = await ingested();
    const before = imageShape(k.session);
    await k.run(`${C}.rasterizeLayer`);
    expect(k.session.state().status).toMatch(
      /not a fill layer, smart object or type layer/,
    );
    expect(imageShape(k.session)).toEqual(before);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("layerViaCopy needs a selection, then copies it onto a new layer (one undo step)", async () => {
    covers("command:media.paged.image.command.layerViaCopy");
    const k = await ingested();
    await k.run(`${C}.layerViaCopy`);
    expect(k.session.state().status).toMatch(/select an area first/);
    await k.run(`${C}.selectAll`);
    await k.run(`${C}.layerViaCopy`);
    const s = k.session.state();
    expect(s.layers.layers.map((l) => l.name)).toEqual([
      "Background",
      "Layer 1",
    ]);
    // Select All is a step of its own (a selection change, ADR 470).
    expect(s.history?.undoSteps).toEqual(["Select All", "Layer via Copy"]);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers).toHaveLength(1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("layerViaCut moves the selected pixels onto a new layer, the picture unchanged (one undo step)", async () => {
    covers("command:media.paged.image.command.layerViaCut");
    const k = await ingested();
    const before = await sourcePixels(k.session);
    await k.run(`${C}.selectAll`);
    await k.run(`${C}.layerViaCut`);
    const s = k.session.state();
    expect(s.layers.layers.map((l) => l.name)).toEqual([
      "Background",
      "Layer 1",
    ]);
    // Select All is a step of its own (a selection change, ADR 470).
    expect(s.history?.undoSteps).toEqual(["Select All", "Layer via Cut"]);
    // The cut layer alone shows: the composite is the original.
    expect(await sourcePixels(k.session)).toEqual(before);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers).toHaveLength(1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("mergeDown refuses on a one-layer stack and changes nothing", async () => {
    covers("command:media.paged.image.command.mergeDown");
    const k = await ingested();
    const before = imageShape(k.session);
    await k.run(`${C}.mergeDown`);
    expect(k.session.state().status).toMatch(/no layer below/);
    expect(imageShape(k.session)).toEqual(before);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("mergeVisible refuses on a one-layer stack and changes nothing", async () => {
    covers("command:media.paged.image.command.mergeVisible");
    const k = await ingested();
    const before = imageShape(k.session);
    await k.run(`${C}.mergeVisible`);
    expect(k.session.state().status).toMatch(/two visible layers/);
    expect(imageShape(k.session)).toEqual(before);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("mergeGroup refuses on a one-layer stack and changes nothing", async () => {
    covers("command:media.paged.image.command.mergeGroup");
    const k = await ingested();
    const before = imageShape(k.session);
    await k.run(`${C}.mergeGroup`);
    expect(k.session.state().status).toMatch(/not in a group/);
    expect(imageShape(k.session)).toEqual(before);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("stampVisible stamps the composite onto a new layer (one undo step)", async () => {
    covers("command:media.paged.image.command.stampVisible");
    const k = await ingested();
    await k.run(`${C}.stampVisible`);
    const s = k.session.state();
    expect(s.layers.layers.map((l) => l.name)).toEqual([
      "Background",
      "Layer 1",
    ]);
    expect(s.history?.undoSteps).toEqual(["Stamp Visible"]);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers).toHaveLength(1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("flattenImage declines without WebGPU (the white matte is a blend) and changes nothing", async () => {
    covers("command:media.paged.image.command.flattenImage");
    const k = await ingested();
    const before = imageShape(k.session);
    await k.run(`${C}.flattenImage`);
    expect(k.session.state().status).toMatch(/GPU-only/);
    expect(imageShape(k.session)).toEqual(before);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("alignLeft of a layer that fills the canvas moves nothing and records no step", async () => {
    covers("command:media.paged.image.command.alignLeft");
    const k = await ingested();
    const before = imageShape(k.session);
    const px = await sourcePixels(k.session);
    await k.run(`${C}.alignLeft`);
    expect(imageShape(k.session)).toEqual(before);
    expect(await sourcePixels(k.session)).toEqual(px);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("alignHCenter of a layer that fills the canvas moves nothing and records no step", async () => {
    covers("command:media.paged.image.command.alignHCenter");
    const k = await ingested();
    const before = imageShape(k.session);
    const px = await sourcePixels(k.session);
    await k.run(`${C}.alignHCenter`);
    expect(imageShape(k.session)).toEqual(before);
    expect(await sourcePixels(k.session)).toEqual(px);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("alignRight of a layer that fills the canvas moves nothing and records no step", async () => {
    covers("command:media.paged.image.command.alignRight");
    const k = await ingested();
    const before = imageShape(k.session);
    const px = await sourcePixels(k.session);
    await k.run(`${C}.alignRight`);
    expect(imageShape(k.session)).toEqual(before);
    expect(await sourcePixels(k.session)).toEqual(px);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("alignTop of a layer that fills the canvas moves nothing and records no step", async () => {
    covers("command:media.paged.image.command.alignTop");
    const k = await ingested();
    const before = imageShape(k.session);
    const px = await sourcePixels(k.session);
    await k.run(`${C}.alignTop`);
    expect(imageShape(k.session)).toEqual(before);
    expect(await sourcePixels(k.session)).toEqual(px);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("alignVCenter of a layer that fills the canvas moves nothing and records no step", async () => {
    covers("command:media.paged.image.command.alignVCenter");
    const k = await ingested();
    const before = imageShape(k.session);
    const px = await sourcePixels(k.session);
    await k.run(`${C}.alignVCenter`);
    expect(imageShape(k.session)).toEqual(before);
    expect(await sourcePixels(k.session)).toEqual(px);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("alignBottom of a layer that fills the canvas moves nothing and records no step", async () => {
    covers("command:media.paged.image.command.alignBottom");
    const k = await ingested();
    const before = imageShape(k.session);
    const px = await sourcePixels(k.session);
    await k.run(`${C}.alignBottom`);
    expect(imageShape(k.session)).toEqual(before);
    expect(await sourcePixels(k.session)).toEqual(px);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("distributeHorizontal needs three layers and changes nothing with one", async () => {
    covers("command:media.paged.image.command.distributeHorizontal");
    const k = await ingested();
    const before = imageShape(k.session);
    await k.run(`${C}.distributeHorizontal`);
    expect(k.session.state().status).toMatch(/three layers/);
    expect(imageShape(k.session)).toEqual(before);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("distributeVertical needs three layers and changes nothing with one", async () => {
    covers("command:media.paged.image.command.distributeVertical");
    const k = await ingested();
    const before = imageShape(k.session);
    await k.run(`${C}.distributeVertical`);
    expect(k.session.state().status).toMatch(/three layers/);
    expect(imageShape(k.session)).toEqual(before);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("linkLayers links the active layer with the one below (one undo step)", async () => {
    covers("command:media.paged.image.command.linkLayers");
    const k = await ingested();
    await k.run(`${C}.addLayer`);
    await k.run(`${C}.linkLayers`);
    const s = k.session.state();
    const links = s.layers.layers.map((l) => l.link);
    expect(links[0]).not.toBeNull();
    expect(links[1]).toBe(links[0]!);
    expect(s.history?.undoSteps.at(-1)).toBe("Link Layers");
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("unlinkLayer dissolves a link of two (one undo step)", async () => {
    covers("command:media.paged.image.command.unlinkLayer");
    const k = await ingested();
    await k.run(`${C}.addLayer`);
    await k.run(`${C}.linkLayers`);
    await k.run(`${C}.unlinkLayer`);
    const s = k.session.state();
    expect(s.layers.layers.map((l) => l.link)).toEqual([null, null]);
    expect(s.history?.undoSteps.at(-1)).toBe("Unlink Layer");
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("newLayerComp records a layer comp (one undo step)", async () => {
    covers("command:media.paged.image.command.newLayerComp");
    const k = await ingested();
    await k.run(`${C}.newLayerComp`);
    const s = k.session.state();
    expect(
      s.layers.comps.map((c) => [
        c.name,
        c.visibility,
        c.position,
        c.appearance,
      ]),
    ).toEqual([["Layer Comp 1", true, true, true]]);
    expect(s.history?.undoSteps).toEqual(["New Layer Comp"]);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.comps).toHaveLength(0);
    expect(k.changes()).toBe(0);
    k.dispose();
  });
});
