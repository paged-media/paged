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

// paged.image's raster tools driven through the gesture DSL against the
// test kit's recording fake editor (through the real host adapter) and a
// recording session: the page point → image pixel mapping (aspect-fit
// into the frame), the previews they publish, and the one edit each
// sends. The session is a stub: the pixels are the engine's business
// (session.spec.ts), the gesture is this file's.

import { describe, expect, it } from "bun:test";

import type { ElementId, PluginManifest } from "@paged-media/plugin-api";
import { createBundleHost } from "@paged-media/plugin-sdk";
import { createFakeEditor, gestures } from "@paged-media/test-kit";
import manifestJson from "@paged-media/image-manifest/manifest.json";

import { makeBucketGesture } from "../src/bucket-tool";
import { makeGradientGesture } from "../src/gradient-tool";
import { makeMoveGesture } from "../src/move-tool";
import { makeRedEyeGesture } from "../src/red-eye-tool";
import type { ImageSession } from "../src/session";
import { mapBacking, silentConsole } from "./helpers";

const FRAME = { kind: "rectangle", id: "img" } as ElementId;

/** A frame x 100–500, y 100–300 (400 × 200 pt) holding an 800 × 400 px
 *  image: scale 0.5, origin (100, 100). */
function imageHarness(
  selection: { x: number; y: number; w: number; h: number } | null = null,
) {
  const fake = createFakeEditor({
    selection: [FRAME],
    geometry: (id) =>
      id.id === "img"
        ? {
            id,
            pageId: "page-1",
            bounds: [100, 100, 300, 500],
            itemTransform: null,
          }
        : null,
  });
  const { host } = createBundleHost(
    () => fake.editor,
    manifestJson as PluginManifest,
    {
      console: silentConsole,
      storage: mapBacking(),
    },
  );
  const calls: string[] = [];
  const session = {
    state: () => ({
      source: { elementId: "img", width: 800, height: 400 },
      selection,
    }),
    moveSelection: async (dx: number, dy: number, vacate: number) =>
      void calls.push(`moveSelection(${dx},${dy},${vacate})`),
    offsetLayer: async (dx: number, dy: number, edge: number) =>
      void calls.push(`offsetLayer(${dx},${dy},${edge})`),
    fillGradientLine: async (a: number[], b: number[]) =>
      void calls.push(`fillGradientLine(${a},${b})`),
    bucketFill: async (at: number[]) => void calls.push(`bucketFill(${at})`),
    sampleColor: (at: number[], size: number) =>
      void calls.push(`sampleColor(${at},${size})`),
    applyRedEye: async (box: { x: number; y: number; w: number; h: number }) =>
      void calls.push(`applyRedEye(${box.x},${box.y},${box.w},${box.h})`),
  } as unknown as ImageSession;
  return { fake, g: gestures(fake), host, session, calls };
}

describe("paged.image tools through the gesture DSL", () => {
  it("Move: the drag's page delta becomes an image-px delta (÷ the fit scale); the outline previews; the release sends it @level:gesture", async () => {
    const { fake, g, host, session, calls } = imageHarness();
    await g
      .tool(() => makeMoveGesture(host, session))
      .settle()
      .drag({ from: [200, 150], to: [250, 175] })
      .settle();
    const outline = fake
      .previews()
      .filter((p) => p !== null)
      .at(-1) as unknown as { points: number[][] };
    // The whole layer (no selection), moved by 100 × 50 px = 50 × 25 pt.
    expect(outline.points).toEqual([
      [150, 125],
      [550, 125],
      [550, 325],
      [150, 325],
    ]);
    expect(fake.currentPreview()).toBeNull();
    expect(calls).toEqual(["offsetLayer(100,50,0)"]);
  });

  it("Move: with a selection the selected pixels move; Alt copies them @level:gesture", async () => {
    const { g, host, session, calls } = imageHarness({
      x: 10,
      y: 10,
      w: 20,
      h: 20,
    });
    await g
      .tool(() => makeMoveGesture(host, session))
      .settle()
      .drag({ from: [200, 150], to: [210, 150], mods: ["alt"] })
      .settle();
    expect(calls).toEqual(["moveSelection(20,0,1)"]);
  });

  it("Gradient: the drag is the gradient line in image px; Shift snaps it to 45°; under 1 px nothing @level:gesture", async () => {
    const { g, host, session, calls } = imageHarness();
    await g
      .tool(() => makeGradientGesture(host, session))
      .settle()
      .drag({ from: [100, 100], to: [200, 100] })
      .drag({ from: [100, 100], to: [200, 104], mods: ["shift"] })
      .click([300, 200])
      .settle();
    expect(calls[0]).toBe("fillGradientLine(0,0,200,0)");
    const snapped = calls[1].match(
      /fillGradientLine\(0,0,([\d.]+),([\d.e-]+)\)/,
    )!;
    expect(Number(snapped[2])).toBeCloseTo(0, 9);
    expect(calls).toHaveLength(2);
  });

  it("Bucket: a click fills at the image pixel under it; Alt+click samples instead @level:gesture", async () => {
    const { g, host, session, calls } = imageHarness();
    await g
      .tool(() => makeBucketGesture(host, session))
      .settle()
      .click([300, 200])
      .click([300, 200], { mods: ["alt"] })
      .settle();
    expect(calls).toEqual(["bucketFill(400,200)", "sampleColor(400,200,3)"]);
  });

  it("Red eye: a drag is its box in image px; a click is a 24 px box around the point @level:gesture", async () => {
    const { g, host, session, calls } = imageHarness();
    await g
      .tool(() => makeRedEyeGesture(host, session))
      .settle()
      .drag({ from: [110, 110], to: [120, 130] })
      .click([300, 200])
      .settle();
    expect(calls).toEqual([
      "applyRedEye(20,20,20,40)",
      "applyRedEye(388,188,24,24)",
    ]);
  });

  it("with no frame to map through (the session has no source), the tools send nothing @level:gesture", async () => {
    const fake = createFakeEditor();
    const { host } = createBundleHost(
      () => fake.editor,
      manifestJson as PluginManifest,
      { console: silentConsole, storage: mapBacking() },
    );
    const calls: string[] = [];
    const session = {
      state: () => ({ source: null, selection: null }),
      bucketFill: async () => void calls.push("bucketFill"),
      offsetLayer: async () => void calls.push("offsetLayer"),
    } as unknown as ImageSession;
    const g = gestures(fake);
    await g
      .tool(() => makeBucketGesture(host, session))
      .settle()
      .click([300, 200])
      .tool(() => makeMoveGesture(host, session))
      .settle()
      .drag({ from: [1, 1], to: [50, 50] })
      .settle();
    expect(calls).toEqual([]);
  });
});
