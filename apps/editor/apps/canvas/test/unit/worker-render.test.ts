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

// The worker's CPU render schedule (editor ADR "Performance budgets";
// UXI-PRF-001, PRF-004, PRF-005): one tile per draw, the page nearest the
// viewport's centre first, the neighbours after the visible pages, nothing
// rendered for a page the camera left before its turn, and the tile cache
// held to its byte budget without ever dropping a tile on screen.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { CameraBuffer } from "@paged-media/client";

import { WorkerRenderer, type RendererWasm } from "../../src/worker/render";

const PAGE: [number, number] = [612, 792];

const realBitmap = (globalThis as { createImageBitmap?: unknown })
  .createImageBitmap;
beforeAll(() => {
  // A tile's decode, as the browser's would answer it: a bitmap the size
  // the renderer asked for (a Letter page at 256 px is 256 × 331).
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async (
    blob: Blob,
  ) => {
    const width = Number((await blob.text()).split(":")[1]);
    return {
      width,
      height: Math.round((width * PAGE[1]) / PAGE[0]),
      close() {},
    };
  };
});
afterAll(() => {
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap =
    realBitmap;
});

function rig(pages: number, budget?: number, failing: string[] = []) {
  const rendered: string[] = [];
  const wasm: RendererWasm = {
    pageCount: () => pages,
    pageInfo: (i) => (i < pages ? [`p${i}`, PAGE[0], PAGE[1]] : undefined),
    renderTilePng: (pageId, width) => {
      rendered.push(pageId);
      if (failing.includes(pageId)) throw new Error("cannot render");
      // Not a PNG: the stub decode above reads the width back.
      return new TextEncoder().encode(`${pageId}:${width}`);
    },
  };
  const ctx = new Proxy(
    {},
    { get: () => () => {}, set: () => true },
  ) as unknown as OffscreenCanvasRenderingContext2D;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
  } as unknown as OffscreenCanvas;
  const camera = CameraBuffer.allocate();
  const r = new WorkerRenderer(canvas, wasm, camera, 1, 800, 900, {
    tileBudgetBytes: budget,
  });
  r.refreshLayout();
  /** Point the camera at page `i`'s centre, at `scale`. */
  const lookAt = (i: number, scale = 1) => {
    // The default stack: pages 24 pt apart, in one column.
    const cx = PAGE[0] / 2;
    const cy = i * (PAGE[1] + 24) + PAGE[1] / 2;
    camera.write({ scale, tx: 400 - cx * scale, ty: 450 - cy * scale });
  };
  /** One draw, then the decode it started. */
  const frame = async () => {
    r.drawNow();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((res) => setTimeout(res, 0));
  };
  return { r, rendered, lookAt, frame };
}

describe("the worker's CPU render schedule", () => {
  test("one page per draw, the one at the viewport's centre first, then outwards", async () => {
    const { rendered, lookAt, frame } = rig(10);
    // At 30 % five pages fit the height: 2..6 around page 4.
    lookAt(4, 0.3);
    await frame();
    expect(rendered).toEqual(["p4"]);
    await frame();
    await frame();
    expect(rendered.slice(1).sort()).toEqual(["p3", "p5"]);
    await frame();
    await frame();
    await frame();
    // The visible ones done, the neighbours come next.
    expect(rendered.slice(0, 5).sort()).toEqual(["p2", "p3", "p4", "p5", "p6"]);
    expect(["p1", "p7"]).toContain(rendered[5]);
  });

  test("a page the camera left before its turn is never rendered", async () => {
    const { rendered, lookAt, frame } = rig(30);
    lookAt(2, 0.3);
    await frame();
    // Jump far away before the rest of the first screen was drawn.
    lookAt(25, 0.3);
    for (let i = 0; i < 4; i++) await frame();
    expect(rendered[0]).toBe("p2");
    expect(rendered.slice(1, 4)).toContain("p25");
    expect(rendered.slice(1)).not.toContain("p1");
    expect(rendered.slice(1)).not.toContain("p3");
  });

  test("the tile cache keeps to its budget, never dropping a tile on screen", async () => {
    // One Letter tile at 256 px is 256 × 331 × 4 = 338,944 bytes: room for 3.
    const { r, rendered, lookAt, frame } = rig(20, 3 * 338_944);
    for (const page of [0, 5, 10, 15]) {
      lookAt(page, 1);
      await frame();
      await frame();
    }
    expect(r.tileBytes()).toBeLessThanOrEqual(3 * 338_944);
    // The page on screen kept its tile: no render on the next draw.
    const before = rendered.length;
    await frame();
    expect(rendered.slice(before)).not.toContain("p15");
    // The oldest went first: coming back to page 0 renders it again.
    lookAt(0, 1);
    await frame();
    expect(rendered.at(-1)).toBe("p0");
  });

  test("a page the engine cannot render is not asked again every draw, and the others go on", async () => {
    const { rendered, lookAt, frame } = rig(10, undefined, ["p4"]);
    lookAt(4, 0.3);
    for (let i = 0; i < 8; i++) await frame();
    expect(rendered.filter((p) => p === "p4")).toHaveLength(1);
    expect(rendered).toContain("p3");
    expect(rendered).toContain("p5");
  });
});
