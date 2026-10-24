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

// Extensions ADR 338 — `render.snapshot@2`: a region, the named items
// alone, raw pixels, a transparent ground and a trim; `host.render.element`
// and the `rasterizeElements` helper built on them. Against the real
// engine, and against a scripted one that predates @2 (the SDK must never
// hand a whole-page PNG out as the region or the pixels asked for).

import { afterEach, describe, expect, it } from "bun:test";

import type { ElementId, PluginManifest } from "@paged-media/plugin-api";

import {
  createBundleHost,
  PluginCapabilityError,
  rasterizeElements,
  regionAround,
} from "../src";
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

const RECT = { kind: "rectangle", id: "urect" } as ElementId;

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

const alphaAt = (rgba: Uint8Array, w: number, x: number, y: number) =>
  rgba[(y * w + x) * 4 + 3];

describe("host.render.snapshot@2 [plugin-platform.render-snapshot-v2]", () => {
  it("draws a region, the named item alone, as raw straight-alpha pixels", async () => {
    live = await createHeadlessHost({ console: silent });
    const [pageId] = await live.load(minimalIdml());
    expect(live.host.supports("render.snapshot@2")).toBe(true);

    const [geometry] = await live.host.document.elementGeometry([RECT]);
    const around = regionAround([geometry], 10);

    const shot = (await live.host.render.snapshot(pageId, {
      dpi: 72,
      clip: around,
      only: [RECT],
      format: "rgba",
      background: "transparent",
    }))!;
    expect(shot).not.toBeNull();
    expect(shot.format).toBe("rgba");
    expect(shot.png.length).toBe(0);
    expect(shot.rgba!.length).toBe(shot.widthPx * shot.heightPx * 4);
    // The region is the clip grown to whole pixels (72 dpi: whole pt).
    expect(shot.region!.x).toBe(Math.floor(around.x));
    expect(shot.region!.y).toBe(Math.floor(around.y));
    // The 10 pt margin is transparent; the rectangle's middle is opaque.
    expect(alphaAt(shot.rgba!, shot.widthPx, 2, 2)).toBe(0);
    expect(
      alphaAt(
        shot.rgba!,
        shot.widthPx,
        Math.floor(shot.widthPx / 2),
        Math.floor(shot.heightPx / 2),
      ),
    ).toBe(255);

    // `trim` crops to what was drawn: the margin goes.
    const trimmed = (await live.host.render.snapshot(pageId, {
      dpi: 72,
      clip: around,
      only: [RECT],
      format: "rgba",
      background: "transparent",
      trim: true,
    }))!;
    expect(trimmed.widthPx).toBeLessThan(shot.widthPx);
    expect(trimmed.region!.x).toBeGreaterThan(shot.region!.x);
    expect(alphaAt(trimmed.rgba!, trimmed.widthPx, 0, 0)).toBeGreaterThan(0);

    // A query, not an edit: the v1 page image is unchanged by any of it.
    const page = (await live.host.render.snapshot(pageId, { widthPx: 100 }))!;
    expect(page.format).toBe("png");
    expect(page.region).toBeUndefined();
  });

  it("render.element and rasterizeElements: the item alone, cropped to it, at a resolution", async () => {
    live = await createHeadlessHost({ console: silent });
    await live.load(minimalIdml());
    const at72 = (await live.host.render.element(RECT, { format: "rgba" }))!;
    const at144 = (await live.host.render.element(RECT, {
      dpi: 144,
      format: "rgba",
    }))!;
    expect(at72).not.toBeNull();
    expect(Math.abs(at144.widthPx - 2 * at72.widthPx)).toBeLessThanOrEqual(2);
    expect(Math.abs(at144.region.x - at72.region.x)).toBeLessThan(1);

    const helper = (await rasterizeElements(live.host, [RECT], { ppi: 72 }))!;
    expect(helper.rgba).toEqual(at72.rgba!);
    expect(helper.bounds).toEqual([
      helper.region.y,
      helper.region.x,
      helper.region.y + helper.region.height,
      helper.region.x + helper.region.width,
    ]);

    // On paper: the same pixel region, opaque.
    const white = (await rasterizeElements(live.host, [RECT], {
      ppi: 72,
      background: "paper",
    }))!;
    expect([white.widthPx, white.heightPx]).toEqual([
      helper.widthPx,
      helper.heightPx,
    ]);
    expect(white.region).toEqual(helper.region);
    for (let i = 3; i < white.rgba.length; i += 4) {
      expect(white.rgba[i]).toBe(255);
    }

    // Nothing to draw: null, never an empty image.
    expect(
      await live.host.render.element({
        kind: "rectangle",
        id: "no-such",
      } as ElementId),
    ).toBeNull();
  });

  it("refuses a bad dpi; a v1 request still needs a width", async () => {
    live = await createHeadlessHost({ console: silent });
    const [pageId] = await live.load(minimalIdml());
    await expect(live.host.render.snapshot(pageId, { dpi: 0 })).rejects.toThrow(
      /dpi/,
    );
    await expect(live.host.render.element(RECT, { dpi: 5000 })).rejects.toThrow(
      /dpi/,
    );
    await expect(live.host.render.snapshot(pageId, {})).rejects.toThrow(
      /widthPx/,
    );
  });

  it("forwards the @2 fields, and answers null where an engine before @2 drew the whole page", async () => {
    const fake = makeFakeEditor();
    const v1Reply = {
      kind: "snapshotReady",
      payload: {
        pageId: "p1",
        widthPx: 10,
        heightPx: 10,
        layoutGeneration: 0,
        numberingGeneration: 0,
        pngBytes: [0x89, 0x50, 0x4e, 0x47],
      },
    };
    fake.onSend("requestSnapshot", () => v1Reply);
    const { host } = createBundleHost(() => fake.editor, manifest(), {
      console: silent,
    });
    const only = [RECT];
    const clip = { x: 1, y: 2, width: 3, height: 4 };
    expect(
      await host.render.snapshot("p1", {
        dpi: 300,
        only,
        clip,
        format: "rgba",
        background: "transparent",
        trim: true,
      }),
    ).toBeNull();
    const last = fake.sent.at(-1)!;
    expect(last.kind).toBe("requestSnapshot");
    expect(last.payload).toEqual({
      pageId: "p1",
      targetWidthPx: 0,
      hideItems: [],
      dpi: 300,
      only,
      clip,
      format: "rgba",
      background: "transparent",
      trim: true,
    });
    // A clip with no region back: null too.
    expect(await host.render.snapshot("p1", { widthPx: 10, clip })).toBeNull();
    // A v1 request through the same engine is fine, and sends no @2 field.
    const plain = await host.render.snapshot("p1", { widthPx: 10 });
    expect(plain?.format).toBe("png");
    expect(fake.sent.at(-1)!.payload).toEqual({
      pageId: "p1",
      targetWidthPx: 10,
      hideItems: [],
    });
  });

  it("render.element is a document read: refused without the read capability", async () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, manifest({}), {
      console: silent,
      capabilityMode: "enforce",
    });
    await expect(host.render.element(RECT)).rejects.toBeInstanceOf(
      PluginCapabilityError,
    );
  });
});
