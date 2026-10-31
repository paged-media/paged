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

import { describe, expect, it } from "bun:test";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import { crc32, zip } from "../src/index.ts";

/** The entries of a ZIP, read back through its central directory. */
function unzip(bytes: Uint8Array): Array<[string, Uint8Array, number]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out: Array<[string, Uint8Array, number]> = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(
      bytes.subarray(at + 46, at + 46 + nameLen),
    );
    const localName = view.getUint16(local + 26, true);
    const body = bytes.subarray(
      local + 30 + localName,
      local + 30 + localName + size,
    );
    const data = method === 8 ? new Uint8Array(inflateRawSync(body)) : body;
    expect(crc32(data)).toBe(crc);
    out.push([name, data, method]);
    at += 46 + nameLen;
  }
  return out;
}

describe("zip", () => {
  it("crc32 is the IEEE checksum", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("stores entries in order with UTF-8 names", () => {
    const a = new TextEncoder().encode("hello");
    const b = new Uint8Array([0, 1, 2, 3, 255]);
    const entries = unzip(
      zip([
        ["a.txt", a],
        ["Größe/b@2x.png", b],
      ]),
    );
    expect(entries.map(([n]) => n)).toEqual(["a.txt", "Größe/b@2x.png"]);
    expect(entries[0]![1]).toEqual(a);
    expect(entries[1]![1]).toEqual(b);
    expect(entries.every(([, , m]) => m === 0)).toBe(true);
  });

  it("deflates with the caller's deflate when it helps, stores otherwise", () => {
    const text = new TextEncoder().encode("abc".repeat(1000));
    const noise = new Uint8Array([7, 3, 9]);
    const deflate = (d: Uint8Array) => new Uint8Array(deflateRawSync(d));
    const entries = unzip(
      zip(
        [
          ["text.svg", text],
          ["tiny.bin", noise],
        ],
        { deflate },
      ),
    );
    expect(entries[0]![2]).toBe(8);
    expect(entries[0]![1]).toEqual(text);
    expect(entries[1]![2]).toBe(0);
    expect(entries[1]![1]).toEqual(noise);
  });

  it("an empty archive is just the end record", () => {
    expect(zip([]).byteLength).toBe(22);
  });
});
