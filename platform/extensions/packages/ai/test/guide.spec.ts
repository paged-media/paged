/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// The guide teaches the model by example, so every example must run. Each
// fenced js block executes on a fresh document against the real engine.

import { afterEach, describe, expect, it } from "vitest";

import { AUTHORING_GUIDE } from "../src";
import { headlessEngine } from "./engine-fixture";

const examples = [...AUTHORING_GUIDE.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]!);
let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

describe("authoring guide examples", () => {
  it("has examples", () => expect(examples.length).toBeGreaterThanOrEqual(2));

  it.each(examples.map((src, i) => [i, src] as const))("example %i runs clean", async (_i, src) => {
    const { engine, host } = await headlessEngine();
    dispose = () => host.dispose();
    const run = await engine.runScript(src);
    expect(run.error).toBeNull();
    expect(JSON.parse((await engine.runScript("console.log(paged.stories())")).output[0]!.replace(/^\[log\] /, ""))).toHaveLength(1);
  });
});

describe("authoring guide colours", () => {
  it("the colour the guide teaches actually paints", async () => {
    const { engine, host } = await headlessEngine();
    dispose = () => host.dispose();
    const run = await engine.runScript(examples[1]!);
    expect(run.error).toBeNull();
    const page = JSON.parse((await engine.runScript("console.log(paged.pages())")).output[0]!.replace(/^\[\w+\] /, ""))[0].selfId;
    const shot = await host.host.render.snapshot(page, { widthPx: 200 });
    expect(shot).not.toBeNull();
    // The band runs across the top of the page: find a strongly red pixel there.
    const { inflateSync } = await import("node:zlib");
    const png = shot!.png;
    // Decode just enough of the PNG to read the first rows (8-bit RGB/RGBA, filter bytes).
    let off = 8, width = 0, height = 0, channels = 4;
    const idat: Buffer[] = [];
    while (off < png.length) {
      const len = (png[off]! << 24) | (png[off + 1]! << 16) | (png[off + 2]! << 8) | png[off + 3]!;
      const type = String.fromCharCode(png[off + 4]!, png[off + 5]!, png[off + 6]!, png[off + 7]!);
      const data = Buffer.from(png.subarray(off + 8, off + 8 + len));
      if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); channels = data[9] === 2 ? 3 : 4; }
      if (type === "IDAT") idat.push(data);
      off += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    // Undo the PNG row filters (None, Sub, Up, Average, Paeth) for the first rows.
    const rows: Uint8Array[] = [];
    for (let y = 0; y <= 3; y++) {
      const f = raw[y * (stride + 1)]!;
      const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      const out = new Uint8Array(stride);
      const up = rows[y - 1] ?? new Uint8Array(stride);
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? out[i - channels]! : 0;
        const ul = i >= channels ? up[i - channels]! : 0;
        const p = left + up[i]! - ul;
        const pa = Math.abs(p - left), pb = Math.abs(p - up[i]!), pc = Math.abs(p - ul);
        const pred = f === 0 ? 0 : f === 1 ? left : f === 2 ? up[i]! : f === 3 ? (left + up[i]!) >> 1 : pa <= pb && pa <= pc ? left : pb <= pc ? up[i]! : ul;
        out[i] = (src[i]! + pred) & 0xff;
      }
      rows.push(out);
    }
    const x = 2;
    const px = rows[3]!.subarray(x * channels, x * channels + 3);
    expect(height).toBeGreaterThan(10);
    expect(px[0]).toBeGreaterThan(150);
    expect(px[1]).toBeLessThan(80);
  });
});
