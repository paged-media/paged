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

// The draw module's actions (PM-0015; extensions ADR 344): the bundle
// registers them on a shared registry and ANOTHER bundle runs them.
//
// The trace runs the REAL trace wasm. Its decode is the platform's
// (createImageBitmap + OffscreenCanvas), which Node does not have, so the
// trace lane stands one in — a fake container (`FAKE`, the size, then
// RGBA) with a nearest-neighbour `drawImage` — exactly as the Image Trace
// command's spec does; without it the action refuses with the decoder's
// sentence, which is pinned too. The recolour is pure TS over the SVG.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "bun:test";
import { stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import type { ActionAsset, PluginManifest } from "@paged-media/plugin-api";
import {
  createActionRegistry,
  createBundleHost,
  createFakeEditor,
  loadBundle,
  mapBacking,
  silentConsole as silent,
} from "@paged-media/plugin-sdk";
import { parseCssColor, parsePathData } from "@paged-media/draw-geometry";

import { drawBundle } from "../src";
import { DRAW_ACTION_IDS, recolorSvg } from "../src/actions";
import { RASTER_DECODER_UNAVAILABLE } from "../src/io/raster-decode";

const built = existsSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "wasm",
    "trace_js_bg.wasm",
  ),
);

const RUNNER: PluginManifest = {
  id: "media.paged.data",
  name: "data",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { actions: { run: true } },
};

function hosts() {
  const registry = createActionRegistry();
  const fake = createFakeEditor();
  const draw = loadBundle(() => fake.editor, drawBundle, {
    console: silent,
    storage: mapBacking(),
    actions: registry,
  });
  const runner = createBundleHost(() => fake.editor, RUNNER, {
    console: silent,
    actions: registry,
    capabilityMode: "enforce",
  }).host;
  return { draw, runner };
}

/** A `size²` picture: white paper with a red square in the middle. */
function redSquare(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const lo = size / 4;
  const hi = (size * 3) / 4;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const inside = x >= lo && x < hi && y >= lo && y < hi;
      px.set(
        inside ? [200, 20, 30, 255] : [255, 255, 255, 255],
        (y * size + x) * 4,
      );
    }
  return px;
}

/** The fake container the stand-in decoder reads. */
function fakePicture(size: number): ActionAsset {
  const bytes = new Uint8Array(12 + size * size * 4);
  bytes.set(new TextEncoder().encode("FAKE"));
  new DataView(bytes.buffer).setUint32(4, size, true);
  new DataView(bytes.buffer).setUint32(8, size, true);
  bytes.set(redSquare(size), 12);
  return { bytes, mediaType: "image/x-fake" };
}

interface FakeBitmap {
  width: number;
  height: number;
  rgba: Uint8Array;
  close(): void;
}

function stubDecoder(): void {
  stubGlobal("createImageBitmap", async (blob: Blob): Promise<FakeBitmap> => {
    const b = new Uint8Array(await blob.arrayBuffer());
    if (new TextDecoder().decode(b.subarray(0, 4)) !== "FAKE")
      throw new Error("not a fake picture");
    const v = new DataView(b.buffer, b.byteOffset);
    return {
      width: v.getUint32(4, true),
      height: v.getUint32(8, true),
      rgba: b.subarray(12),
      close() {},
    };
  });
  stubGlobal(
    "OffscreenCanvas",
    class {
      data: Uint8ClampedArray;
      constructor(
        readonly width: number,
        readonly height: number,
      ) {
        this.data = new Uint8ClampedArray(width * height * 4);
      }
      getContext() {
        return {
          drawImage: (
            bm: FakeBitmap,
            _x: number,
            _y: number,
            w: number,
            h: number,
          ) => {
            for (let y = 0; y < h; y++)
              for (let x = 0; x < w; x++) {
                const sx = Math.floor((x * bm.width) / w);
                const sy = Math.floor((y * bm.height) / h);
                const s = (sy * bm.width + sx) * 4;
                this.data.set(bm.rgba.subarray(s, s + 4), (y * w + x) * 4);
              }
          },
          getImageData: () => ({ data: this.data }),
        };
      }
    },
  );
}

afterEach(() => unstubAllGlobals());

/** The attributes of each `<tag …>` of `svg`, in order. */
const elements = (svg: string, tag: string): Record<string, string>[] =>
  [...svg.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, "g"))].map((m) =>
    Object.fromEntries(
      [...m[1]!.matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1]!, a[2]!]),
    ),
  );

/** A trace's SVG as its size and paths (the trace writes one `<path>` per
 *  region or stroke). */
const svgOf = (out: unknown) => {
  const a = out as ActionAsset;
  expect(a.mediaType).toBe("image/svg+xml");
  const text = new TextDecoder().decode(a.bytes);
  const root = elements(text, "svg")[0]!;
  return {
    width: Number(root.width),
    height: Number(root.height),
    shapes: elements(text, "path").map((p) => ({
      anchors: parsePathData(p.d!),
      fill: p.fill,
    })),
  };
};

describe("media.paged.draw actions on a shared registry [plugin-platform.actions-door]", () => {
  it("registers trace and recolor, and nothing once disposed", () => {
    const { runner, draw } = hosts();
    expect(runner.actions.list("asset").map((a) => a.id)).toEqual([
      DRAW_ACTION_IDS.trace,
      DRAW_ACTION_IDS.recolor,
    ]);
    draw.dispose();
    expect(runner.actions.list()).toEqual([]);
  });

  it.skipIf(!built)(
    "trace turns a picture into an SVG of its size, whose region is the square [plugin-draw.image-trace]",
    async () => {
      stubDecoder();
      const { runner } = hosts();
      const r = await runner.actions.run(
        DRAW_ACTION_IDS.trace,
        fakePicture(32),
        {
          pathMode: "polygon",
        },
      );
      const doc = svgOf(r.output);
      expect([doc.width, doc.height]).toEqual([32, 32]);
      // The paper is dropped (ignoreWhite); the square is one red region.
      expect(doc.shapes.length).toBe(1);
      expect(parseCssColor(doc.shapes[0]!.fill!)).toEqual([200, 20, 30]);
      const xs = doc.shapes[0]!.anchors.anchors.map((a) => a.anchor[0]);
      expect(Math.min(...xs)).toBeCloseTo(8, 0);
      expect(Math.max(...xs)).toBeCloseTo(24, 0);
    },
  );

  it.skipIf(!built)(
    "a picture over the trace budget is traced downsampled and written at its own size [plugin-draw.image-trace]",
    async () => {
      stubDecoder();
      const { runner } = hosts();
      const r = await runner.actions.run(
        DRAW_ACTION_IDS.trace,
        fakePicture(64),
        {
          pathMode: "polygon",
          maxTracePixels: 32 * 32,
        },
      );
      const doc = svgOf(r.output);
      expect([doc.width, doc.height]).toEqual([64, 64]);
      const xs = doc.shapes[0]!.anchors.anchors.map((a) => a.anchor[0]);
      expect(Math.min(...xs)).toBeCloseTo(16, 0);
      expect(Math.max(...xs)).toBeCloseTo(48, 0);
    },
  );

  it.skipIf(!built)(
    "without a platform decoder the trace refuses with the decoder's sentence",
    async () => {
      const { runner } = hosts();
      await expect(
        runner.actions.run(DRAW_ACTION_IDS.trace, fakePicture(8)),
      ).rejects.toThrow(RASTER_DECODER_UNAVAILABLE.slice(0, 40));
    },
  );

  it.skipIf(!built)(
    "trace → recolor chains, and the second run is cached [plugin-draw.recolor-artwork]",
    async () => {
      stubDecoder();
      const { runner } = hosts();
      const steps = [
        { action: DRAW_ACTION_IDS.trace, params: { pathMode: "polygon" } },
        {
          action: DRAW_ACTION_IDS.recolor,
          params: { mode: "map", map: { "#c8141e": "#0000ff" } },
        },
      ];
      const first = await runner.actions.runChain(steps, fakePicture(32));
      expect(svgOf(first.output).shapes[0]!.fill).toBe("#0000ff");
      const again = await runner.actions.runChain(steps, fakePicture(32));
      expect(again).toMatchObject({ cached: true, key: first.key });
    },
  );
});

const ART =
  `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="10" viewBox="0 0 30 10">` +
  `<rect x="0" y="0" width="10" height="10" fill="#e01010"/>` +
  `<rect x="10" y="0" width="10" height="10" fill="#d02020" stroke="#101010" stroke-width="2"/>` +
  `<rect x="20" y="0" width="10" height="10" fill="#1040e0"/>` +
  `</svg>`;

describe.skipIf(!built)(
  "recolor over an SVG [plugin-draw.recolor-artwork]",
  () => {
    const fills = (svg: string) => elements(svg, "rect").map((r) => r.fill);
    const strokes = (svg: string) => elements(svg, "rect").map((r) => r.stroke);

    it("reduces to N colours, keeping an existing colour per cluster", async () => {
      const out = await recolorSvg(ART, { mode: "reduce", count: 3 });
      const f = fills(out);
      // The two reds are one cluster; blue and the black stroke stay.
      expect(f[0]).toBe(f[1]);
      expect(f[2]).toBe("#1040e0");
      expect(strokes(out)[1]).toBe("#101010");
      // Everything but the colours is the file as it was.
      expect(out.replace(/#[0-9a-f]{6}/g, "#")).toBe(
        ART.replace(/#[0-9a-f]{6}/g, "#"),
      );
    });

    it("maps colours and moves them to a harmony, leaving neutrals", async () => {
      expect(
        fills(
          await recolorSvg(ART, { mode: "map", map: { "#1040e0": "#00ff00" } }),
        ),
      ).toEqual(["#e01010", "#d02020", "#00ff00"]);
      const h = await recolorSvg(ART, {
        mode: "harmony",
        rule: "complementary",
        base: "#00a0a0",
      });
      const [r] = parseCssColor(fills(h)[0]!)!;
      expect(r).toBeLessThan(100); // red became a cyan-ish colour
      expect(strokes(h)[1]).toBe("#101010");
    });

    it("carries what a flattening reader dropped: gradient stops, CSS, <use> (draw ADR 364)", async () => {
      const rich =
        `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">` +
        `<style>.k { fill: #e01010 }</style>` +
        `<linearGradient id="g"><stop offset="0" stop-color="#e01010"/><stop offset="1" stop-color="#ffffff"/></linearGradient>` +
        `<rect id="r" class="k" width="5" height="5"/><use href="#r" x="5"/>` +
        `<rect y="5" width="10" height="5" fill="url(#g)"/></svg>`;
      const out = await recolorSvg(rich, {
        mode: "map",
        map: { "#e01010": "#00aa00" },
      });
      expect(out).toContain(".k { fill: #00aa00 }");
      expect(out).toContain('stop-color="#00aa00"');
      expect(out).toContain('<use href="#r" x="5"/>');
      expect(out).toContain('fill="url(#g)"');
    });

    it("refuses what it cannot read", async () => {
      await expect(recolorSvg(ART, { mode: "spin" })).rejects.toThrow(
        /mode is/,
      );
      await expect(recolorSvg("not svg", {})).rejects.toThrow(
        /not an SVG document/,
      );
      const { runner } = hosts();
      await expect(
        runner.actions.run(DRAW_ACTION_IDS.recolor, {
          bytes: new Uint8Array([1]),
          mediaType: "image/png",
        }),
      ).rejects.toThrow(/takes image\/svg\+xml/);
    });
  },
);
