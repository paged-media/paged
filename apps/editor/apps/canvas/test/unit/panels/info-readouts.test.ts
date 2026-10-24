/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// WP4.5 — the Info panel's arithmetic: the selection box and angle, the
// pixel read, the colour conversions, and the page sampler's cache.

import { describe, expect, test } from "bun:test";

import type { ElementGeometryItem, WorkerToMain } from "@paged-media/client";

import {
  angleOf,
  rgbHex,
  samplePixel,
  selectionReadout,
  srgbToLab,
} from "../../../src/panels/info-readouts";
import {
  createPageSampler,
  SAMPLE_WIDTH_PX,
} from "../../../src/panels/info-sampler";

const item = (
  bounds: [number, number, number, number],
  itemTransform: [number, number, number, number, number, number] | null = null,
  pageId: string | null = "p1",
) =>
  ({
    id: { kind: "rectangle", id: "x" },
    pageId,
    bounds,
    itemTransform,
  }) as ElementGeometryItem;

describe("selection readout", () => {
  test("one item: its box, its own size, its angle", () => {
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const r = selectionReadout([item([0, 0, 50, 100], [c, s, -s, c, 10, 20])])!;
    expect(r.w).toBeCloseTo(100);
    expect(r.h).toBeCloseTo(50);
    expect(r.angle).toBeCloseTo(30);
    expect(r.x).toBeCloseTo(10 - 50 * s);
    expect(r.y).toBeCloseTo(20);
  });

  test("a scaled item reads scaled; a mirrored one keeps the engine's angle", () => {
    const r = selectionReadout([item([0, 0, 10, 10], [2, 0, 0, 3, 0, 0])])!;
    expect([r.w, r.h, r.angle]).toEqual([20, 30, 0]);
    expect(angleOf([-1, 0, 0, 1, 0, 0])).toBe(0);
  });

  test("several: the union box; the angle only when they agree", () => {
    const r = selectionReadout([
      item([0, 0, 10, 10]),
      item([20, 30, 40, 50]),
      item([0, 0, 5, 5], null, null),
    ])!;
    expect(r).toEqual({ x: 0, y: 0, w: 50, h: 40, angle: 0, count: 2 });
    const mixed = selectionReadout([
      item([0, 0, 10, 10]),
      item([0, 0, 10, 10], [0, 1, -1, 0, 0, 0]),
    ])!;
    expect(mixed.angle).toBeNull();
    expect(selectionReadout([])).toBeNull();
  });
});

describe("colour", () => {
  test("hex", () => {
    expect(rgbHex(255, 0, 16)).toBe("#ff0010");
    expect(rgbHex(300, -4, 127.6)).toBe("#ff0080");
  });

  test("sRGB to L*a*b* (D50): white, black, the primaries", () => {
    expect(srgbToLab(255, 255, 255)).toEqual([100, 0, 0]);
    expect(srgbToLab(0, 0, 0)).toEqual([0, 0, 0]);
    const red = srgbToLab(255, 0, 0);
    expect(red[0]).toBeCloseTo(54.3, 0);
    expect(red[1]).toBeCloseTo(80.8, 0);
    expect(red[2]).toBeCloseTo(69.9, 0);
    const mid = srgbToLab(128, 128, 128);
    expect(mid[0]).toBeCloseTo(53.6, 0);
    expect(Math.abs(mid[1])).toBeLessThan(0.2);
  });

  test("the pixel under a page point, none outside the page", () => {
    const data = new Uint8ClampedArray(4 * 4 * 2);
    data.set([1, 2, 3, 255], (1 * 4 + 3) * 4); // x 3, y 1
    const raster = { width: 4, height: 2, data };
    expect(samplePixel(raster, [400, 200], [350, 150])).toEqual([1, 2, 3, 255]);
    // The far edge lands on the last pixel, not past it.
    expect(samplePixel(raster, [400, 200], [400, 200])).toEqual([1, 2, 3, 255]);
    expect(samplePixel(raster, [400, 200], [-1, 0])).toBeNull();
    expect(samplePixel(raster, [400, 200], [0, 201])).toBeNull();
  });
});

describe("page sampler", () => {
  function fake() {
    const listeners = new Set<(m: WorkerToMain) => void>();
    const asked: string[] = [];
    return {
      asked,
      emit: (m: unknown) => listeners.forEach((l) => l(m as WorkerToMain)),
      client: {
        async requestSnapshot(pageId: string, width: number) {
          asked.push(`${pageId}@${width}`);
          return { pngBytes: [1, 2, 3] } as never;
        },
        subscribe(fn: (m: WorkerToMain) => void) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      },
    };
  }
  const decode = async () => ({ width: 1, height: 1, data: [9, 9, 9, 255] });

  test("one snapshot per page until an edit names it", async () => {
    const f = fake();
    const s = createPageSampler(f.client as never, decode);
    await s.raster("p1" as never);
    await s.raster("p1" as never);
    expect(f.asked).toEqual([`p1@${SAMPLE_WIDTH_PX}`]);
    f.emit({ kind: "mutationApplied", payload: { pageIds: ["p2"] } });
    await s.raster("p1" as never);
    expect(f.asked).toHaveLength(1);
    f.emit({ kind: "mutationApplied", payload: { pageIds: ["p1"] } });
    await s.raster("p1" as never);
    expect(f.asked).toHaveLength(2);
    f.emit({ kind: "documentLoaded", payload: {} });
    await s.raster("p1" as never);
    expect(f.asked).toHaveLength(3);
    s.dispose();
  });

  test("a failed snapshot or decode answers null, not a colour", async () => {
    const f = fake();
    f.client.requestSnapshot = async () => {
      throw new Error("gone");
    };
    const s = createPageSampler(f.client as never, decode);
    expect(await s.raster("p1" as never)).toBeNull();
    const t = createPageSampler(fake().client as never, async () => null);
    expect(await t.raster("p1" as never)).toBeNull();
  });
});
