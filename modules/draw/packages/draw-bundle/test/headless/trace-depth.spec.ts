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

// IMAGE TRACE construct depth (WP6.6) through the REAL tracer wasm and the
// REAL engine: the PRESETS reach the kernel, the CENTRELINE presets lower
// line art to OPEN STROKED paths, RE-TRACE replaces a trace with new
// options in ONE undo step (and its regions name their source, so the old
// ones are found without any id in the record), and a LIVE trace is
// traced again inside the edit that changes its image's link.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import type { CommandContribution, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import {
  applyImageTrace,
  applyRetraceImage,
  drawBundle,
  imageTraceOf,
  liveRetraceOf,
  tracedRegionOf,
  IMAGE_TRACE_OPTIONS_COMMAND_ID,
} from "../../src";
import { imageItem, packageWithSpread, pngBytes } from "../fixtures/build-idml";
import { ringPixels } from "../fixtures/corpus";
import { linkIndex } from "../../src/link-index";
import { openHost } from "./host";
import { installPngRealm } from "./raster-realm";

const IMG = { kind: "rectangle", id: "uline" } as ElementId;

/** A 64 px raster with a 4 px black stroke: a horizontal bar and a
 *  vertical one forming an L — line art. */
function lineArtPixels(size = 64): Uint8Array {
  const out = new Uint8Array(size * size * 4).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ink =
        (y >= 50 && y < 54 && x >= 8 && x < 56) ||
        (x >= 8 && x < 12 && y >= 8 && y < 54);
      if (!ink) continue;
      const at = (y * size + x) * 4;
      out[at] = out[at + 1] = out[at + 2] = 0;
    }
  }
  return out;
}

const doc = () =>
  packageWithSpread(
    imageItem(
      "uline",
      "100 100 228 228",
      "file:line-64.png",
      pngBytes(64, 64, lineArtPixels(64)),
      { width: 64, height: 64 },
    ),
  );

async function tracedRegions(h: HeadlessHost): Promise<ElementId[]> {
  const { linked } = await linkIndex(h.host).snapshot();
  return linked
    .filter(({ envelope }) => tracedRegionOf(envelope)?.of.id === IMG.id)
    .map(({ id }) => id);
}

async function prop(
  h: HeadlessHost,
  id: ElementId,
  path: string,
): Promise<unknown> {
  const props = await h.host.document.elementProperties(id);
  return props?.entries.find((e) => e.path === path)?.value?.value ?? null;
}

describe("draw conformance — IMAGE TRACE construct depth (WP6.6)", () => {
  let h: HeadlessHost;
  let uninstall: () => void;
  beforeAll(async () => {
    uninstall = installPngRealm();
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => {
    h?.dispose();
    uninstall?.();
  });
  beforeEach(async () => {
    await h.load(doc());
    await h.host.selection.set([IMG]);
  });

  it("the LINE ART preset traces the drawing's CENTRELINES: open paths, stroked at the ink's width, unfilled", async () => {
    covers("command:media.paged.draw.command.imageTrace");
    const regions = await applyImageTrace(h.host, { preset: "lineArt" });
    expect(regions.length).toBeGreaterThanOrEqual(1);
    for (const id of regions) {
      const table = await h.host.document.pathAnchors(id);
      expect(table?.subpathOpen?.[0]).toBe(true);
      expect(await prop(h, id, "frameFillColor")).toBeNull();
      expect(await prop(h, id, "frameStrokeColor")).not.toBeNull();
      // 4 px of ink at 2 pt per pixel: about 8 pt.
      const weight = Number(await prop(h, id, "frameStrokeWeight"));
      expect(weight).toBeGreaterThan(4);
      expect(weight).toBeLessThan(14);
    }
    const record = imageTraceOf(await h.host.document.getMetadata(IMG));
    expect(record?.preset).toBe("lineArt");
    expect(record?.options.mode).toBe("centerline");
    // ONE undo takes the trace back.
    await h.host.document.undo();
    expect(await tracedRegions(h)).toHaveLength(0);
  });

  it("the “…” row, on a host with no panel door, traces with the default options (one undo step)", async () => {
    covers("command:media.paged.draw.command.imageTraceOptions");
    const rec = h.contributions.find(
      (c) => c.kind === "command" && c.id === IMAGE_TRACE_OPTIONS_COMMAND_ID,
    );
    expect(rec).toBeDefined();
    await (rec!.value as CommandContribution).handler(undefined, undefined);
    expect((await tracedRegions(h)).length).toBeGreaterThan(0);
    expect(
      imageTraceOf(await h.host.document.getMetadata(IMG))?.preset,
    ).toBeNull();
    await h.host.document.undo();
    expect(await tracedRegions(h)).toHaveLength(0);
  });

  it("the BLACK AND WHITE LOGO preset traces FILLED regions (the threshold mode)", async () => {
    covers("command:media.paged.draw.command.imageTrace");
    const regions = await applyImageTrace(h.host, {
      preset: "blackAndWhiteLogo",
    });
    expect(regions.length).toBeGreaterThanOrEqual(1);
    for (const id of regions) {
      expect(await prop(h, id, "frameFillColor")).not.toBeNull();
      expect(await prop(h, id, "frameStrokeColor")).toBeNull();
    }
  });

  it("RE-TRACE replaces the previous result with new options in ONE undo step", async () => {
    covers("command:media.paged.draw.command.retraceImage");
    const first = await applyImageTrace(h.host, {
      preset: "blackAndWhiteLogo",
    });
    expect(first.length).toBeGreaterThan(0);
    // Re-trace from the TRACED ARTWORK (its marker names the image).
    await h.host.selection.set([first[0]!]);
    const second = await applyRetraceImage(h.host, { preset: "lineArt" });
    expect(second.length).toBeGreaterThan(0);
    const now = (await tracedRegions(h)).map((id) => String(id.id)).sort();
    expect(now).toEqual(second.map((id) => String(id.id)).sort());
    for (const id of first) {
      expect(
        await h.host.document.pathAnchors(id).catch(() => null),
      ).toBeNull();
    }
    expect(imageTraceOf(await h.host.document.getMetadata(IMG))?.preset).toBe(
      "lineArt",
    );
    // ONE undo brings the first trace back.
    await h.host.document.undo();
    const restored = (await tracedRegions(h)).map((id) => String(id.id)).sort();
    expect(restored).toEqual(first.map((id) => String(id.id)).sort());
    expect(imageTraceOf(await h.host.document.getMetadata(IMG))?.preset).toBe(
      "blackAndWhiteLogo",
    );
  });

  it("RE-TRACE keeps the record's options it is not given, and refuses an image that was never traced", async () => {
    covers("command:media.paged.draw.command.retraceImage");
    expect(await applyRetraceImage(h.host, {})).toEqual([]);
    await applyImageTrace(h.host, { preset: "technicalDrawing" });
    await h.host.selection.set([IMG]);
    expect(
      (await applyRetraceImage(h.host, { filterSpeckle: 2 })).length,
    ).toBeGreaterThan(0);
    const record = imageTraceOf(await h.host.document.getMetadata(IMG));
    expect(record?.options.mode).toBe("centerline");
    expect(record?.options.pathMode).toBe("polygon");
    expect(record?.options.filterSpeckle).toBe(2);
    // A changed option is no longer the preset.
    expect(record?.preset).toBeNull();
  });

  it("a LIVE trace is traced again inside the edit that replaces its image", async () => {
    covers("command:media.paged.draw.command.retraceImage");
    const live = liveRetraceOf(h.host);
    expect(live).toBeDefined();
    await live!.idle();
    const first = await applyImageTrace(h.host, {
      preset: "blackAndWhiteLogo",
      live: true,
    });
    expect(first.length).toBeGreaterThan(0);
    await live!.idle();
    // Replace the image's bytes: the ring, which traces to ONE region
    // with a hole instead of the L.
    const ring = pngBytes(48, 48, ringPixels(48));
    const outcome = await h.host.document.mutateWithBytes(
      { op: "replaceImageBytes", args: { elementId: "uline", bytes: [] } },
      ring,
    );
    expect(outcome.applied).toBe(true);
    await live!.idle();
    await live!.idle();
    expect(live!.lastRetraced()).toEqual(["uline"]);
    const now = await tracedRegions(h);
    expect(now.map((id) => String(id.id)).sort()).not.toEqual(
      first.map((id) => String(id.id)).sort(),
    );
    // ONE undo takes the replacement AND the re-trace back.
    await h.host.document.undo();
    const back = (await tracedRegions(h)).map((id) => String(id.id)).sort();
    expect(back).toEqual(first.map((id) => String(id.id)).sort());
  });
});
