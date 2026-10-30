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

// SHA-256, lower-case hex: the content address of a part, a payload or a
// source (doc, slide, sheet, image and data name their parts by it).

/**
 * SHA-256 of `input` (bytes, or a text as UTF-8) in lower-case hex. One
 * parameter, so `parts.map(sha256Hex)` is safe. A view over a
 * SharedArrayBuffer (a worker's served bytes) is copied first: WebCrypto
 * refuses shared memory.
 */
export async function sha256Hex(
  input: Uint8Array | ArrayBuffer | string,
): Promise<string> {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  const owned =
    typeof SharedArrayBuffer !== "undefined" &&
    bytes.buffer instanceof SharedArrayBuffer
      ? bytes.slice()
      : bytes;
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    owned as Uint8Array<ArrayBuffer>,
  );
  return hex(new Uint8Array(digest));
}

/** The first `hexChars` hex digits of [`sha256Hex`]. paged.data's content
 *  addresses are the first 32 (128 bits) and documents persist them, so a
 *  shortened address stays a prefix of the full digest. */
export async function sha256HexPrefix(
  input: Uint8Array | ArrayBuffer | string,
  hexChars: number,
): Promise<string> {
  return (await sha256Hex(input)).slice(0, hexChars);
}

/** Lower-case hex of `bytes`, two digits per byte. */
export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3, the one ZIP and PNG use) of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
