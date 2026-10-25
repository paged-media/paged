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

// Extensions ADR 349 — `host.render.story`: a story the document does not
// hold, laid out and drawn by the engine. Against the real engine, and
// against a scripted one that predates the field (it draws the page in the
// region, which the SDK must never hand out as the story).

import { afterEach, describe, expect, it } from "bun:test";

import type { PluginManifest, RenderStory } from "@paged-media/plugin-api";

import { createBundleHost, PluginCapabilityError } from "../src";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { makeFakeEditor } from "./fake-editor";
import { minimalIdml } from "./fixtures/minimal-idml";

import { silentConsole as silent } from "../src/testing";

const manifest = (
  capabilities: PluginManifest["capabilities"] = {
    document: { read: "broad" },
  },
): PluginManifest => ({
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities,
});

const STORY: RenderStory = {
  bounds: [20, 20, 120, 220],
  paragraphs: [
    {
      runs: [{ text: "Type layer", pointSize: 24, fillRgb: [200, 20, 30] }],
      justification: "LeftAlign",
    },
  ],
};

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

describe("host.render.story [image.layers.type]", () => {
  it("draws the story alone, trimmed, and leaves the document as it was", async () => {
    live = await createHeadlessHost({ console: silent });
    const [pageId] = await live.load(minimalIdml());
    expect(live.host.supports("render.story@1")).toBe(true);
    const before = await live.host.document.tree();

    const shot = (await live.host.render.story(pageId, STORY, {
      marginPt: 8,
    }))!;
    expect(shot).not.toBeNull();
    expect(shot.format).toBe("rgba");
    expect(shot.rgba!.length).toBe(shot.widthPx * shot.heightPx * 4);
    // Trimmed to the ink: inside the frame (grown by the margin), and
    // smaller than it.
    expect(shot.region.x).toBeGreaterThanOrEqual(12);
    expect(shot.region.y).toBeGreaterThanOrEqual(12);
    expect(shot.widthPx).toBeLessThan(200);
    expect(shot.heightPx).toBeLessThan(100);
    let red = 0;
    for (let i = 0; i < shot.rgba!.length; i += 4) {
      if (shot.rgba![i + 3] === 255 && shot.rgba![i]! > 150) red++;
    }
    expect(red).toBeGreaterThan(20);

    // Twice the dpi: twice the pixels.
    const at144 = (await live.host.render.story(pageId, STORY, {
      dpi: 144,
      marginPt: 8,
    }))!;
    expect(Math.abs(at144.widthPx - 2 * shot.widthPx)).toBeLessThanOrEqual(3);

    // Untrimmed: the frame's box exactly.
    const box = (await live.host.render.story(pageId, STORY, {
      trim: false,
    }))!;
    expect([box.widthPx, box.heightPx]).toEqual([200, 100]);
    expect(box.region).toEqual({ x: 20, y: 20, width: 200, height: 100 });

    // A read: the document has no new item.
    expect(await live.host.document.tree()).toEqual(before);
    // Nothing to draw: null.
    expect(
      await live.host.render.story(pageId, { ...STORY, paragraphs: [] }),
    ).toBeNull();
  });

  it("forwards only the contract's fields, and answers null from an engine without the field", async () => {
    const fake = makeFakeEditor();
    fake.onSend("requestSnapshot", () => ({
      kind: "snapshotReady",
      payload: {
        pageId: "p1",
        widthPx: 10,
        heightPx: 10,
        layoutGeneration: 0,
        numberingGeneration: 0,
        pngBytes: [],
        format: "rgba",
        rgba: new Array(400).fill(0),
        region: { x: 0, y: 0, width: 10, height: 10 },
      },
    }));
    const { host } = createBundleHost(() => fake.editor, manifest(), {
      console: silent,
    });
    const smuggled = {
      ...STORY,
      paragraphs: [
        {
          ...STORY.paragraphs[0]!,
          runs: [{ text: "x", fillRgb: [300, -4, 9.6], evil: 1 }],
        },
      ],
      extra: true,
    } as unknown as RenderStory;
    expect(await host.render.story("p1", smuggled, { dpi: 150 })).toBeNull();
    const sent = fake.sent.at(-1)!;
    expect(sent.kind).toBe("requestSnapshot");
    expect(sent.payload).toEqual({
      pageId: "p1",
      targetWidthPx: 0,
      hideItems: [],
      dpi: 150,
      clip: { x: 20, y: 20, width: 200, height: 100 },
      format: "rgba",
      background: "transparent",
      trim: true,
      story: {
        bounds: [20, 20, 120, 220],
        paragraphs: [
          {
            runs: [{ text: "x", fillRgb: [255, 0, 10] }],
            justification: "LeftAlign",
          },
        ],
      },
    });
    await expect(
      host.render.story("p1", { ...STORY, bounds: [0, 0, 0, 10] }),
    ).rejects.toThrow(/area/);
  });

  it("is a document read: refused without the read capability", async () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, manifest({}), {
      console: silent,
      capabilityMode: "enforce",
    });
    await expect(host.render.story("p1", STORY)).rejects.toBeInstanceOf(
      PluginCapabilityError,
    );
  });
});
