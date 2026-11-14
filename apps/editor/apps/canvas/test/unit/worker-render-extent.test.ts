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

// The CPU lane's compositing (engine ADR 1306): the paper over the trim,
// the tile at the page's screen extent (its bleed and pasteboard artwork
// drawn past the trim, as the GPU lane draws them), and the page edge only
// outside a proof (editor ADR 1212).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CameraBuffer } from "@paged-media/client";

import { WorkerRenderer, type RendererWasm } from "../../src/worker/render";

type Call = [string, ...unknown[]];

function fakeCanvas() {
  const calls: Call[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      return (...args: unknown[]) => {
        calls.push([String(prop), ...args]);
      };
    },
    set(target, prop, value) {
      target[prop as string] = value;
      return true;
    },
  });
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
  } as unknown as OffscreenCanvas;
  return { canvas, calls };
}

/** One 100 × 80 pt page whose artwork bleeds 10 pt past the top-left. */
function wasm(extent: number[] | undefined): RendererWasm {
  return {
    pageCount: () => 1,
    pageInfo: () => ["p1", 100, 80, 0, 0],
    renderTilePng: () => new Uint8Array([1, 2, 3]),
    screenExtent: () => extent,
  };
}

const camera = { scale: 1, tx: 0, ty: 0, rotation: 0 };

let restore: typeof globalThis.createImageBitmap | undefined;
beforeEach(() => {
  restore = globalThis.createImageBitmap;
  globalThis.createImageBitmap = (async () => ({
    width: 110,
    height: 90,
    close() {},
  })) as unknown as typeof globalThis.createImageBitmap;
});
afterEach(() => {
  globalThis.createImageBitmap = restore!;
});

async function rendered(extent: number[] | undefined) {
  const { canvas, calls } = fakeCanvas();
  const r = new WorkerRenderer(
    canvas,
    wasm(extent),
    CameraBuffer.allocate(),
    1,
    400,
    300,
  );
  r.refreshLayout();
  const internals = r as unknown as {
    draw(c: typeof camera): void;
    loadTile(pageId: string, widthPx: number): Promise<void>;
  };
  await internals.loadTile("p1", 256);
  calls.length = 0;
  return { r, calls, draw: () => internals.draw(camera) };
}

describe("the CPU lane's page", () => {
  test("the tile goes at the page's screen extent, over the paper of the trim", async () => {
    const { calls, draw } = await rendered([-10, -10, 110, 90]);
    draw();
    const fills = calls.filter((c) => c[0] === "fillRect");
    // The background, then the paper over the trim.
    expect(fills[fills.length - 1]).toEqual(["fillRect", 0, 0, 100, 80]);
    const image = calls.find((c) => c[0] === "drawImage");
    expect(image?.slice(2)).toEqual([-10, -10, 110, 90]);
    expect(calls.some((c) => c[0] === "strokeRect")).toBe(true);
  });

  test("an engine that reports no extent draws its tile over the trim", async () => {
    const { calls, draw } = await rendered(undefined);
    draw();
    const image = calls.find((c) => c[0] === "drawImage");
    expect(image?.slice(2)).toEqual([0, 0, 100, 80]);
  });

  test("a proof draws the page without its edge, and leaving it draws it again", async () => {
    const { r, calls, draw } = await rendered([0, 0, 100, 80]);
    r.setViewSettings({ mode: "preview", proof: true }, false);
    draw();
    expect(calls.some((c) => c[0] === "strokeRect")).toBe(false);
    r.setViewSettings({ mode: "preview" }, false);
    calls.length = 0;
    draw();
    expect(calls.some((c) => c[0] === "strokeRect")).toBe(true);
  });
});
