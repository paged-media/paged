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

// The one ZIP codec of the built-ins, the editor and the CLI (plan C13):
// entries in the order given, CRC-32, one central directory, UTF-8 names.
// Deflate is the caller's: the CLI hands Node's `deflateRawSync`, the
// browser `deflateRaw` (CompressionStream, so `zipAsync`), and an export of
// PNG, JPEG or WebP files stores (deflating them again gains nothing). An
// entry is stored whenever deflating does not make it smaller. `ocf` writes
// an OCF package (IDML, EPUB): `mimetype` first and stored. `unzip` reads
// stored and deflated entries. No ZIP64: an archive over 4 GiB is refused.

import { crc32 } from "./hash.ts";

export interface ZipOptions {
  /** Raw DEFLATE (no zlib header) of an entry; absent: every entry is
   *  stored. */
  deflate?: (data: Uint8Array) => Uint8Array;
  /** An OCF package: the `mimetype` entry first and stored. */
  ocf?: boolean;
}

export interface ZipAsyncOptions {
  /** Raw DEFLATE of an entry, as a promise (`deflateRaw` in a browser). */
  deflate?: (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  ocf?: boolean;
}

type Entries = ReadonlyArray<readonly [string, Uint8Array]>;

/** `entries` with `mimetype` first when an OCF package is asked for. */
const ordered = (entries: Entries, ocf: boolean | undefined): Entries =>
  ocf
    ? [
        ...entries.filter(([n]) => n === "mimetype"),
        ...entries.filter(([n]) => n !== "mimetype"),
      ]
    : entries;

/** The ZIP of `entries` (path → bytes), in the order given. */
export function zip(entries: Entries, options: ZipOptions = {}): Uint8Array {
  const list = ordered(entries, options.ocf);
  return assemble(
    list,
    list.map(([name, data]) =>
      options.ocf && name === "mimetype" ? undefined : options.deflate?.(data),
    ),
  );
}

/** {@link zip} with an asynchronous deflate (the browser's streams). */
export async function zipAsync(
  entries: Entries,
  options: ZipAsyncOptions = {},
): Promise<Uint8Array> {
  const list = ordered(entries, options.ocf);
  const bodies = await Promise.all(
    list.map(([name, data]) =>
      options.ocf && name === "mimetype" ? undefined : options.deflate?.(data),
    ),
  );
  return assemble(list, bodies);
}

async function pipe(
  bytes: Uint8Array,
  stream: GenericTransformStream,
): Promise<Uint8Array> {
  const out = new Response(
    new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(
        stream as unknown as TransformStream<Uint8Array, Uint8Array>,
      ),
  );
  return new Uint8Array(await out.arrayBuffer());
}

/** Raw DEFLATE through the platform's `CompressionStream`. */
export const deflateRaw = (bytes: Uint8Array): Promise<Uint8Array> =>
  pipe(bytes, new CompressionStream("deflate-raw" as CompressionFormat));

/** Raw INFLATE through the platform's `DecompressionStream`. */
export const inflateRaw = (bytes: Uint8Array): Promise<Uint8Array> =>
  pipe(bytes, new DecompressionStream("deflate-raw" as CompressionFormat));

/** Every entry of a ZIP, in central-directory order (stored or deflated;
 *  no ZIP64). Throws on bytes that are not a ZIP. */
export async function unzip(
  bytes: Uint8Array,
): Promise<Array<[string, Uint8Array]>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const names = new TextDecoder();
  const out: Array<[string, Uint8Array]> = [];
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extra = view.getUint16(p + 30, true);
    const comment = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = names.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const start =
      local +
      30 +
      view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    out.push([name, method === 0 ? raw.slice() : await inflateRaw(raw)]);
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

/** The archive of `entries`, each written from its deflated body when one
 *  is given and smaller, else stored. */
function assemble(
  entries: Entries,
  deflated: ReadonlyArray<Uint8Array | undefined>,
): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  entries.forEach(([name, data], i) => {
    const nameBytes = new TextEncoder().encode(name);
    const packed = deflated[i];
    const stored = !packed || packed.byteLength >= data.byteLength;
    const body = stored ? data : packed;
    const crc = crc32(data);
    if (offset + body.byteLength > 0xffffffff)
      throw new Error(
        "the archive is over 4 GiB, which a ZIP without ZIP64 cannot hold",
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
  });
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
