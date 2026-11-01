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

// The shared 8-bit PNG codec and CRC-32: a round trip, every row filter
// (as other encoders write them), grey and RGB inputs, refusals.

import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";

import { crc32, decodePng, encodePng } from "../src/index.ts";

const img = {
  width: 3,
  height: 5,
  data: Uint8ClampedArray.from({ length: 60 }, (_, i) => (i * 37 + 11) % 256),
};

function pngOf(
  colorType: number,
  channels: number,
  rows: number[][],
  w: number,
): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(
      [...type].map((c) => c.charCodeAt(0)),
      4,
    );
    out.set(data, 8);
    new DataView(out.buffer).setUint32(
      8 + data.length,
      crc32(out.subarray(4, 8 + data.length)),
    );
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, rows.length);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  void channels;
  const raw = new Uint8Array(rows.flat());
  return new Uint8Array([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", new Uint8Array(deflateSync(raw))),
    ...chunk("IEND", new Uint8Array()),
  ]);
}

describe("8-bit PNG codec", () => {
  test("CRC-32 of a known text", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("round trip", async () => {
    const back = await decodePng(await encodePng(img));
    expect([back.width, back.height]).toEqual([3, 5]);
    expect([...back.data]).toEqual([...img.data]);
  });

  test("every row filter, 0 to 4", async () => {
    const stride = 12;
    const px = (x: number, y: number) =>
      x < 0 || y < 0 ? 0 : img.data[y * stride + x]!;
    const paeth = (a: number, b: number, c: number) => {
      const pa = Math.abs(b - c);
      const pb = Math.abs(a - c);
      const pc = Math.abs(a + b - 2 * c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    const rows = [0, 1, 2, 3, 4].map((y) => [
      y,
      ...Array.from({ length: stride }, (_, x) => {
        const a = px(x - 4, y);
        const b = px(x, y - 1);
        const c = px(x - 4, y - 1);
        const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][y]!;
        return (px(x, y) - pred) & 0xff;
      }),
    ]);
    expect([...(await decodePng(pngOf(6, 4, rows, 3))).data]).toEqual([
      ...img.data,
    ]);
  });

  test("grey, grey+alpha and RGB become RGBA", async () => {
    expect([...(await decodePng(pngOf(0, 1, [[0, 7, 9]], 2))).data]).toEqual([
      7, 7, 7, 255, 9, 9, 9, 255,
    ]);
    expect([...(await decodePng(pngOf(4, 2, [[0, 7, 100]], 1))).data]).toEqual([
      7, 7, 7, 100,
    ]);
    expect([...(await decodePng(pngOf(2, 3, [[0, 1, 2, 3]], 1))).data]).toEqual(
      [1, 2, 3, 255],
    );
  });

  test("refuses what it does not read", async () => {
    await expect(decodePng(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /not a PNG/,
    );
    await expect(decodePng(pngOf(3, 1, [[0, 0]], 1))).rejects.toThrow(
      /colour type 3/,
    );
    await expect(
      encodePng({ width: 2, height: 2, data: new Uint8Array(3) }),
    ).rejects.toThrow(/not RGBA/);
  });
});
