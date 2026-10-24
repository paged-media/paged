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

// A ZIP writer for `package -o x.zip`: deflated entries (stored when
// deflating does not help), CRC-32, one central directory. No ZIP64: a
// package over 4 GiB is refused.

import { deflateRawSync } from "node:zlib";

import { crc32 } from "@paged-media/helpers";

/** The ZIP of `entries` (path → bytes), in the order given. */
export function zip(entries: ReadonlyArray<[string, Uint8Array]>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const deflated = deflateRawSync(data);
    const stored = deflated.byteLength >= data.byteLength;
    const body = stored ? data : new Uint8Array(deflated);
    const crc = crc32(data);
    if (offset + body.byteLength > 0xffffffff)
      throw new Error(
        "the package is over 4 GiB, which a ZIP without ZIP64 cannot hold",
      );
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, stored ? 0 : 8, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.byteLength, true);
    local.setUint32(22, data.byteLength, true);
    local.setUint16(26, nameBytes.byteLength, true);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, stored ? 0 : 8, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, body.byteLength, true);
    dir.setUint32(24, data.byteLength, true);
    dir.setUint16(28, nameBytes.byteLength, true);
    dir.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, body);
    central.push(new Uint8Array(dir.buffer), nameBytes);
    offset += 30 + nameBytes.byteLength + body.byteLength;
  }
  const size = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}
