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

// SVG IMPORT AND EXPORT OF GRADIENTS (D-58's gradient part, engine ADR
// 1007), through the REAL engine. A `<linearGradient>` fill with
// `stop-opacity` lands as a native gradient whose stops carry their own
// colour and opacity, placed by the frame's gradient start, angle and
// length; an engine without paint v2 gets the first stop as a solid. The
// exporter writes the gradient back, opacity included.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { parseSvgDocument } from "@paged-media/draw-geometry";

import { drawBundle, exportSvg, importSvg } from "../../src";
import { PAINT_V2_FEATURE } from "../../src/io/svg";
import { rawGradientDetail } from "../../src/raw-wire";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const enc = (s: string) => new TextEncoder().encode(s);
const file = (name: string, svg: string) => ({
  name,
  bytes: enc(svg),
  mimeType: "image/svg+xml",
});

const FADE = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">
  <defs><linearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#0080ff"/>
    <stop offset="1" stop-color="#0080ff" stop-opacity="0"/>
  </linearGradient></defs>
  <rect x="20" y="30" width="200" height="100" fill="url(#fade)"/>
</svg>`;

const withoutPaint2 = (host: BundleHost): BundleHost =>
  new Proxy(host, {
    get(target, key, receiver) {
      if (key === "supports") {
        return (feature: string) =>
          feature !== PAINT_V2_FEATURE && target.supports(feature);
      }
      return Reflect.get(target, key, receiver);
    },
  }) as BundleHost;

async function prop(h: HeadlessHost, id: ElementId, path: string) {
  const props = await h.host.document.elementProperties(id);
  return props?.entries.find((e) => e.path === path)?.value;
}

describe("SVG gradients with stop-opacity [color-swatches.paint-v2]", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  it("a linear fade lands as a native gradient with inline, translucent stops, placed on the frame", async () => {
    const ids = await importSvg(h.host, file("fade.svg", FADE));
    expect(ids).toHaveLength(1);
    const fill = await prop(h, ids[0]!, "frameFillColor");
    expect(fill?.type).toBe("colorRef");
    const ref = (fill as { value: string }).value;
    expect(ref.startsWith("Gradient/")).toBe(true);
    const detail = await rawGradientDetail(h.host, ref);
    expect(detail?.kind).toBe("linear");
    expect(detail?.stops.map((s) => s.opacityPct ?? 100)).toEqual([100, 0]);
    expect(detail?.stops.every((s) => s.color?.space === "RGB")).toBe(true);
    expect(detail?.stops[0]!.resolvedRgbHex.toLowerCase()).toBe("#0080ff");
    expect(await prop(h, ids[0]!, "frameGradientFillLength")).toMatchObject({
      value: 200,
    });
    const angle = (await prop(h, ids[0]!, "frameGradientFillAngle")) as {
      value: number;
    };
    expect(Math.abs(angle.value)).toBeLessThan(1e-3);
    await h.host.document.undo();
  });

  it("the exporter writes the gradient back with its stop-opacity", async () => {
    const ids = await importSvg(h.host, file("fade.svg", FADE));
    await h.host.selection.set(ids as never[]);
    const out = await exportSvg(h.host);
    const text = new TextDecoder().decode(out!.bytes);
    expect(text).toContain("<linearGradient");
    expect(text).toContain('stop-opacity="0"');
    const g = parseSvgDocument(text)!.shapes[0]!.style.fillGradient!;
    expect(g.kind).toBe("linear");
    if (g.kind !== "linear") throw new Error("linear");
    expect(g.end[0] - g.start[0]).toBeCloseTo(200, 0);
    expect(g.stops.map((s) => s.opacity)).toEqual([1, 0]);
    await h.host.document.undo();
  });

  it("an engine without paint v2 paints the first stop solid", async () => {
    const ids = await importSvg(withoutPaint2(h.host), file("fade.svg", FADE));
    const fill = (await prop(h, ids[0]!, "frameFillColor")) as {
      value: string;
    };
    expect(fill.value.startsWith("Color/")).toBe(true);
    await h.host.document.undo();
  });
});
