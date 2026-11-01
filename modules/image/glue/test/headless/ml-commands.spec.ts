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

// Select Subject and Select Sky on the headless host (WP8.2, image ADR 485):
// the integration twin of ml-tier-a.spec.ts. The provider is registered on
// the host's ML registry AFTER the bundle loaded: the feature looks it up
// live. The model's mask becomes the session's selection and sends the
// DOCUMENT nothing.

import { describe, expect, it } from "bun:test";

import { fakeMlProvider } from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import { bundleOnHeadless, C } from "../command-kit";
import { scripted } from "../ml-kit";

async function ingested() {
  const k = await bundleOnHeadless();
  await k.ingest();
  const s = scripted();
  k.h.ml.register(s.provider);
  return { k, ...s };
}
const sel = (k: Awaited<ReturnType<typeof ingested>>["k"]) => {
  const v = k.session.state().selection;
  return v && [v.x, v.y, v.w, v.h];
};

describe("[image.ml.select-subject] ML selection commands on the headless host", () => {
  it("selectSubject selects what the model answered, one undo step, document untouched", async () => {
    covers("command:media.paged.image.command.selectSubject");
    const { k } = await ingested();
    const depth = k.session.state().history?.depth ?? 0;
    await k.run(`${C}.selectSubject`);
    expect(sel(k)).toEqual([0, 0, 2, 2]);
    expect(k.session.state().history?.depth).toBe(depth + 1);
    expect(k.changes()).toBe(0);
    await k.session.undo();
    expect(k.session.state().selection).toBeNull();
    k.dispose();
  });

  it("selectSky selects from points along the top edge", async () => {
    covers("command:media.paged.image.command.selectSky");
    const { k, seen } = await ingested();
    await k.run(`${C}.selectSky`);
    expect(sel(k)).toEqual([0, 0, 2, 2]);
    expect(
      (seen[0] as { request: { points: unknown[] } }).request.points,
    ).toHaveLength(7);
    expect(k.changes()).toBe(0);
    k.dispose();
  });
});

// The Tier B commands: the payload carries the prompt (a script, a template
// run); the fake provider answers deterministically, the scripted one
// segments. Each adds one undo step and sends the DOCUMENT nothing.
async function withModels() {
  const { k, seen } = await ingested();
  const fake = fakeMlProvider({
    capabilities: [
      "matting",
      "inpaint",
      "superres",
      "landmarks",
      "generate",
      "edit",
    ],
  });
  fake.attach(k.h.ml.register(fake));
  return { k, seen, fake };
}
type KB = Awaited<ReturnType<typeof withModels>>["k"];
const layerCount = (k: KB) => k.session.state().layers.layers.length;
const steps = (k: KB) => k.session.state().history?.depth ?? 0;
const selectLeft = (k: KB) => {
  const m = k.session.selectionMachine()!;
  m.begin("rect", [0, 0], "replace");
  m.update([2, 2]);
  m.end();
  k.session.refreshSelection();
};

describe("[image.ml.generate-image] generative commands on the headless host", () => {
  it("generateImage adds a layer from the payload's prompt", async () => {
    covers("command:media.paged.image.command.generateImage");
    const { k } = await withModels();
    await k.run(`${C}.generateImage`, { prompt: "a lake", seed: 1 });
    expect(layerCount(k)).toBe(2);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("generativeFill fills the selection into a masked layer", async () => {
    covers("command:media.paged.image.command.generativeFill");
    const { k } = await withModels();
    selectLeft(k);
    const d0 = steps(k);
    await k.run(`${C}.generativeFill`, { prompt: "a door" });
    expect(layerCount(k)).toBe(2);
    expect(steps(k)).toBe(d0 + 1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("generativeExpand grows the canvas", async () => {
    covers("command:media.paged.image.command.generativeExpand");
    const { k } = await withModels();
    await k.run(`${C}.generativeExpand`, {
      prompt: "more",
      width: 8,
      height: 4,
    });
    expect(k.session.state().source!.width).toBe(8);
    expect(layerCount(k)).toBe(2);
    k.dispose();
  });

  it("removeHq fills the selection; removeBackground masks the layer", async () => {
    covers("command:media.paged.image.command.removeHq");
    covers("command:media.paged.image.command.removeBackground");
    const { k } = await withModels();
    selectLeft(k);
    const d0 = steps(k);
    await k.run(`${C}.removeHq`);
    expect(steps(k)).toBe(d0 + 1);
    await k.run(`${C}.removeBackground`);
    expect(k.session.state().layers.layers[0]!.hasMask).toBe(true);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("the presets: skyReplacement, colorize, skinSmoothing", async () => {
    covers("command:media.paged.image.command.skyReplacement");
    covers("command:media.paged.image.command.colorize");
    covers("command:media.paged.image.command.skinSmoothing");
    const { k } = await withModels();
    await k.run(`${C}.skyReplacement`, { prompt: "a sunset" });
    expect(layerCount(k)).toBe(2);
    await k.run(`${C}.colorize`);
    expect(layerCount(k)).toBe(3);
    await k.run(`${C}.skinSmoothing`);
    expect(layerCount(k)).toBe(4);
    k.dispose();
  });

  it("the neural filters: superZoom and jpegArtifacts", async () => {
    covers("command:media.paged.image.command.superZoom");
    covers("command:media.paged.image.command.jpegArtifacts");
    const { k, fake } = await withModels();
    await k.run(`${C}.superZoom`, { scale: 4 });
    await k.run(`${C}.jpegArtifacts`);
    expect(layerCount(k)).toBe(3);
    expect(
      fake.calls
        .filter((c) => c.capability === "superres")
        .map((c) => (c.request as { scale: number }).scale),
    ).toEqual([4, 2]);
    k.dispose();
  });
});
