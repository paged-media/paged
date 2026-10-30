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

// 8-bit PNG in and out of straight RGBA, in every realm (browser, worker,
// Bun, Node): zlib through the platform's CompressionStream /
// DecompressionStream. The writer emits RGBA rows with filter 0 in one
// IDAT; the reader takes grey, grey+alpha, RGB and RGBA at 8 bits, every
// row filter, not interlaced. Images of other depths go through the
// engine's decoders (paged-raster).

import { crc32 } from "./hash.ts";

/** Straight RGBA, 8 bits per channel, rows top to bottom. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

async function through(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const out = new Response(
    new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream),
  );
  return new Uint8Array(await out.arrayBuffer());
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** RGBA → an 8-bit RGBA PNG. */
export async function encodePng(image: RgbaImage): Promise<Uint8Array> {
  const { width, height, data } = image;
  if (data.length !== width * height * 4)
    throw new Error(
      `encodePng: ${data.length} bytes is not RGBA ${width}×${height}`,
    );
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    raw.set(
      data.subarray(y * width * 4, (y + 1) * width * 4),
      y * (width * 4 + 1) + 1,
    );
  const parts = [
    new Uint8Array(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", await through(raw, new CompressionStream("deflate"))),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** An 8-bit PNG → straight RGBA. */
export async function decodePng(
  png: Uint8Array,
): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  if (!SIGNATURE.every((b, i) => png[i] === b))
    throw new Error("decodePng: not a PNG file");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 8 <= png.length;) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      if (data[8] !== 8) throw new Error("decodePng: only 8-bit PNG is read");
      colorType = data[9]!;
      if (data[12] !== 0)
        throw new Error("decodePng: interlaced PNG is not read");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[
    colorType
  ];
  if (!channels)
    throw new Error(`decodePng: colour type ${colorType} is not read`);
  const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  let off = 0;
  for (const d of idat) {
    joined.set(d, off);
    off += d.length;
  }
  const raw = await through(joined, new DecompressionStream("deflate"));
  const stride = width * channels;
  if (raw.length < height * (stride + 1))
    throw new Error("decodePng: the image data is short");
  const pix = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pix[y * stride + x - channels]! : 0;
      const b = y > 0 ? pix[(y - 1) * stride + x]! : 0;
      const c =
        x >= channels && y > 0 ? pix[(y - 1) * stride + x - channels]! : 0;
      let p = line[x]!;
      if (filter === 1) p += a;
      else if (filter === 2) p += b;
      else if (filter === 3) p += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pix[y * stride + x] = p & 0xff;
    }
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const grey = channels <= 2;
    out[i * 4] = pix[s]!;
    out[i * 4 + 1] = grey ? pix[s]! : pix[s + 1]!;
    out[i * 4 + 2] = grey ? pix[s]! : pix[s + 2]!;
    out[i * 4 + 3] =
      channels === 2 ? pix[s + 1]! : channels === 4 ? pix[s + 3]! : 255;
  }
  return { width, height, data: out };
}
