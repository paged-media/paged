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

// Foreground / background colour and the eyedropper. Real engine wasm:
// the sample reads the composite through the CPU tile window.

import { describe, expect, it } from "bun:test";

import { createBundleHost } from "@paged-media/plugin-sdk";
import type { PluginManifest } from "@paged-media/plugin-api";
import manifestJson from "@paged-media/image-manifest/manifest.json";

import {
  averageRgba8,
  fromHex,
  nextSamplerId,
  sampleWindow,
  samplerNear,
  swapped,
  toHex,
  DEFAULT_COLORS,
  SAMPLE_SIZES,
} from "../src/color-state";
import { applyToolSettings, toolOptionFields } from "../src/tool-options";
import { createImageSession } from "../src/session";
import {
  makeFakeEditor,
  mapBacking,
  psdBytes,
  shellStub,
  silentConsole,
} from "./helpers";

function open() {
  const fake = makeFakeEditor();
  const handle = createBundleHost(
    () => fake.editor,
    manifestJson as PluginManifest,
    {
      console: silentConsole,
      storage: mapBacking(),
      shell: shellStub(),
    },
  );
  return { handle, session: createImageSession(handle.host) };
}

describe("colour-state", () => {
  it("averages premultiplied, so a transparent neighbour does not darken the sample", () => {
    const px = Uint8Array.from([255, 0, 0, 255, 0, 0, 0, 0]);
    expect(averageRgba8(px)).toEqual([1, 0, 0, 0.5]);
    expect(averageRgba8(new Uint8Array(0))).toBeNull();
  });

  it("hex round-trips, and bad input is refused", () => {
    expect(toHex([1, 0.5, 0, 1])).toBe("#ff8000");
    expect(fromHex("#ff8000")).toEqual([1, 128 / 255, 0, 1]);
    expect(fromHex("#f80")).toEqual([1, 136 / 255, 0, 1]);
    expect(fromHex("nope")).toBeNull();
  });

  it("swap exchanges, and the default is black on white", () => {
    expect(swapped(DEFAULT_COLORS)).toEqual({
      fg: [1, 1, 1, 1],
      bg: [0, 0, 0, 1],
    });
  });
});

describe("the session's colours", () => {
  it("the foreground IS the brush colour, both ways", () => {
    const { handle, session } = open();
    session.setForeground([1, 0, 0, 1]);
    expect(session.state().brush.color).toEqual([1, 0, 0, 1]);
    session.setBrushParams({ color: [0, 0, 1, 1] });
    expect(session.state().colors.fg).toEqual([0, 0, 1, 1]);
    session.swapColors();
    expect(session.state().colors).toEqual({
      fg: [1, 1, 1, 1],
      bg: [0, 0, 1, 1],
    });
    expect(session.state().brush.color).toEqual([1, 1, 1, 1]);
    session.resetColors();
    expect(session.state().colors).toEqual(DEFAULT_COLORS);
    session.dispose();
    handle.dispose();
  });

  it("the eyedropper takes the composite's pixel as the foreground", async () => {
    const { handle, session } = open();
    // psdBytes(): 2×1, pixels (10,30,50) and (20,40,60).
    expect(await session.importBytes("c.psd", psdBytes())).toBe(true);
    const c = session.sampleColor([1, 0], 1);
    expect(c).toEqual([20 / 255, 40 / 255, 60 / 255, 1]);
    expect(session.state().colors.fg).toEqual(c);
    expect(session.state().brush.color).toEqual(c);
    // 3×3 around the left pixel clips to the image: the two pixels' mean.
    const avg = session.sampleColor([0, 0], 3, "bg")!;
    expect(avg.map((v) => Math.round(v * 255))).toEqual([15, 35, 55, 255]);
    expect(session.state().colors.bg).toEqual(avg);
    // Outside the image: nothing.
    expect(session.sampleColor([5, 0])).toBeNull();
    session.dispose();
    handle.dispose();
  });
});

// WP4.10 — the standalone Eyedropper (sample sizes, current layer or all
// layers) and the Color Sampler (four fixed points, read live).
describe("the eyedropper and colour samplers [editor-shell.raster-color-binding]", () => {
  it("offers Photoshop's sample sizes and clips the window to the image", () => {
    expect(SAMPLE_SIZES).toEqual([1, 3, 5, 11, 31, 51, 101]);
    expect(sampleWindow([5, 5], 101, 20, 10)).toEqual({
      x: 0,
      y: 0,
      w: 20,
      h: 10,
    });
    expect(sampleWindow([5, 5], 3, 20, 10)).toEqual({ x: 4, y: 4, w: 3, h: 3 });
    expect(sampleWindow([25, 5], 1, 20, 10)).toBeNull();
  });

  it("a large average reads the whole small image", async () => {
    const { handle, session } = open();
    expect(await session.importBytes("c.psd", psdBytes())).toBe(true);
    const c = session.sampleColor([0, 0], 101)!;
    expect(c.map((v) => Math.round(v * 255))).toEqual([15, 35, 55, 255]);
    session.dispose();
    handle.dispose();
  });

  it("'Current layer' reads the active layer's own pixels; a transparent layer samples nothing", async () => {
    const { handle, session } = open();
    expect(await session.importBytes("c.psd", psdBytes())).toBe(true);
    // The ingest's one layer IS the image.
    expect(
      session.readColor([1, 0], 1, "layer")!.map((v) => Math.round(v * 255)),
    ).toEqual([20, 40, 60, 255]);
    // A new, empty layer on top becomes the active one.
    expect(await session.addLayer("Paint")).toBe(true);
    session.setForeground([1, 0, 0, 1]);
    expect(session.sampleColor([1, 0], 1, "fg", "layer")).toBeNull();
    expect(session.state().colors.fg).toEqual([1, 0, 0, 1]);
    // "All layers" still sees the composite under it.
    expect(
      session
        .sampleColor([1, 0], 1, "fg", "all")!
        .map((v) => Math.round(v * 255)),
    ).toEqual([20, 40, 60, 255]);
    session.dispose();
    handle.dispose();
  });

  it("the tool options feed the session; unknown sizes are ignored", () => {
    const { handle, session } = open();
    const fields = toolOptionFields({
      brush: "b",
      pencil: "p",
      eraser: "e",
      wand: "w",
      bucket: "k",
      gradient: "g",
      eyedropper: "i",
      colorSampler: "s",
    });
    expect(fields.i.map((f) => f.key)).toEqual(["sampleSize", "sampleSource"]);
    expect(fields.s.map((f) => f.key)).toEqual(["sampleSize"]);
    applyToolSettings(session, "eyedropper", {
      sampleSize: "11",
      sampleSource: "layer",
    });
    expect(session.state().eyedropper).toEqual({ size: 11, source: "layer" });
    applyToolSettings(session, "eyedropper", { sampleSize: "7" });
    expect(session.state().eyedropper.size).toBe(11);
    session.dispose();
    handle.dispose();
  });

  it("places up to four samplers, numbers them, re-reads them, moves and removes them", async () => {
    const { handle, session } = open();
    expect(await session.importBytes("c.psd", psdBytes())).toBe(true);
    expect(session.addColorSampler([0, 0])).toBe(1);
    expect(session.addColorSampler([1, 0])).toBe(2);
    expect(session.addColorSampler([1, 0])).toBe(3);
    expect(session.addColorSampler([0, 0])).toBe(4);
    expect(session.addColorSampler([0, 0])).toBeNull();
    expect(session.state().status).toContain("4 colour samplers");
    // Off the image: refused.
    expect(session.removeColorSampler(4)).toBe(true);
    expect(session.addColorSampler([9, 9])).toBeNull();
    const read = () =>
      session
        .state()
        .samplers.map((s) => [s.id, s.colour?.map((v) => Math.round(v * 255))]);
    expect(read()).toEqual([
      [1, [10, 30, 50, 255]],
      [2, [20, 40, 60, 255]],
      [3, [20, 40, 60, 255]],
    ]);
    // A freed number is reused.
    expect(nextSamplerId(session.state().samplers)).toBe(4);
    expect(session.moveColorSampler(2, [0, 0])).toBe(true);
    expect(read()[1]).toEqual([2, [10, 30, 50, 255]]);
    expect(samplerNear(session.state().samplers, [1.4, 0.4], 0.5)?.id).toBe(3);
    session.clearColorSamplers();
    expect(session.state().samplers).toEqual([]);
    session.dispose();
    handle.dispose();
  });
});
