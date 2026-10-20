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

// A picture's pixel size, read from its header (UX audit F-03, ADR 262):
// opening a picture with no document open mints a page of the picture's
// size before anything decodes it, and a Photoshop file is a format the
// browser cannot decode at all. PNG, JPEG, GIF, BMP, WebP and PSD/PSB
// carry their size in the first bytes; anything else goes to the
// browser's decoder when there is one.

export interface PictureSize {
  width: number;
  height: number;
}

const ok = (width: number, height: number): PictureSize | null =>
  width > 0 && height > 0 ? { width, height } : null;

/** The size a picture's header declares, or null for a format (or a
 *  file) this reader does not know. */
export function pictureHeaderSize(bytes: Uint8Array): PictureSize | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.byteLength;
  const at = (i: number, ...sig: number[]) =>
    i + sig.length <= n && sig.every((b, k) => bytes[i + k] === b);
  // PNG: the IHDR chunk follows the 8-byte signature.
  if (at(0, 0x89, 0x50, 0x4e, 0x47) && n >= 24) {
    return ok(v.getUint32(16), v.getUint32(20));
  }
  // GIF87a / GIF89a: the logical screen, little-endian.
  if (at(0, 0x47, 0x49, 0x46, 0x38) && n >= 10) {
    return ok(v.getUint16(6, true), v.getUint16(8, true));
  }
  // BMP: BITMAPINFOHEADER width and (signed, maybe bottom-up) height.
  if (at(0, 0x42, 0x4d) && n >= 26) {
    return ok(Math.abs(v.getInt32(18, true)), Math.abs(v.getInt32(22, true)));
  }
  // Photoshop (8BPS, PSD version 1 or PSB version 2): height then width.
  if (at(0, 0x38, 0x42, 0x50, 0x53) && n >= 22) {
    return ok(v.getUint32(18), v.getUint32(14));
  }
  // WebP: RIFF....WEBP and one of three chunk kinds.
  if (
    at(0, 0x52, 0x49, 0x46, 0x46) &&
    at(8, 0x57, 0x45, 0x42, 0x50) &&
    n >= 30
  ) {
    if (at(12, 0x56, 0x50, 0x38, 0x20)) {
      return ok(v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff);
    }
    if (at(12, 0x56, 0x50, 0x38, 0x4c)) {
      const b = v.getUint32(21, true);
      return ok((b & 0x3fff) + 1, ((b >>> 14) & 0x3fff) + 1);
    }
    if (at(12, 0x56, 0x50, 0x38, 0x58)) {
      const w = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
      const h = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
      return ok(w, h);
    }
    return null;
  }
  // JPEG: walk the markers to the first start-of-frame.
  if (at(0, 0xff, 0xd8)) {
    let i = 2;
    while (i + 9 < n) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1]!;
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      const len = v.getUint16(i + 2);
      const sof =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      if (sof) return ok(v.getUint16(i + 7), v.getUint16(i + 5));
      i += 2 + len;
    }
    return null;
  }
  return null;
}

/** The picture's size: its header, else the browser's own decoder. */
export async function pictureSize(
  bytes: Uint8Array,
  mimeType: string,
): Promise<PictureSize | null> {
  const fromHeader = pictureHeaderSize(bytes);
  if (fromHeader) return fromHeader;
  if (typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(
      new Blob([bytes as BlobPart], { type: mimeType || undefined }),
    );
    const size = ok(bitmap.width, bitmap.height);
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

/** InDesign's largest page side, pt (216 in). */
export const MAX_PAGE_SIDE_PT = 15552;

/** The page a picture opens on: one point per pixel, as Place sizes a
 *  picture at its natural size, scaled down whole to InDesign's largest
 *  page when the picture is bigger than that. */
export function pageForPicture(size: PictureSize): [number, number] {
  const scale = Math.min(
    1,
    MAX_PAGE_SIDE_PT / size.width,
    MAX_PAGE_SIDE_PT / size.height,
  );
  return [size.width * scale, size.height * scale];
}
