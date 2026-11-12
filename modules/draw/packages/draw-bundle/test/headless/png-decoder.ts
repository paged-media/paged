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

// A STAND-IN FOR THE ENGINE'S DECODER, for the PNGs the fixtures write.
//
// Image Trace gets a placed image's pixels from the host's decoded-pixels
// door (`host.assets.decodeImage`, the engine's decoder in the editor and
// in the headless harness). The no-engine unit rigs have no engine, so
// this is their `PagedEditor.decodeImage`: it reads exactly what
// `fixtures/build-idml.ts`'s `pngBytes` writes — 8-bit RGBA, no interlace,
// filter type 0 on every row — and refuses anything else, the way the
// engine refuses bytes it cannot read. Everything after the decode (the
// trace wasm, the command) is the real thing.

import { inflateSync } from "node:zlib";

interface Bitmap {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function decodePng(bytes: Uint8Array): Bitmap {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0x89504e47) throw new Error("not a PNG");
  let at = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (at < bytes.length) {
    const length = view.getUint32(at);
    const type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const [depth, colour, , , interlace] = data.subarray(8, 13);
      if (depth !== 8 || colour !== 6 || interlace !== 0) {
        throw new Error("only 8-bit RGBA, non-interlaced PNGs decode here");
      }
    } else if (type === "IDAT") {
      idat.push(data);
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = 1 + width * 4;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    if (raw[y * stride] !== 0) throw new Error("only filter type 0 here");
    out.set(raw.subarray(y * stride + 1, (y + 1) * stride), y * width * 4);
  }
  return { width, height, data: out };
}

/** The fake engine decode: the PNG's pixels, shrunk (nearest
 *  neighbour) so no side exceeds `maxDim`; null for anything else. */
export async function pngDecodeImage(
  bytes: Uint8Array,
  maxDim?: number,
): Promise<{ width: number; height: number; rgba: Uint8Array } | null> {
  let image: Bitmap;
  try {
    image = decodePng(bytes);
  } catch {
    return null;
  }
  const k =
    maxDim && Math.max(image.width, image.height) > maxDim
      ? maxDim / Math.max(image.width, image.height)
      : 1;
  const w = Math.max(1, Math.round(image.width * k));
  const h = Math.max(1, Math.round(image.height * k));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.floor((x * image.width) / w);
      const sy = Math.floor((y * image.height) / h);
      const from = (sy * image.width + sx) * 4;
      out.set(image.data.subarray(from, from + 4), (y * w + x) * 4);
    }
  return { width: w, height: h, rgba: out };
}
