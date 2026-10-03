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

// The ROUND-TRIP lane's package half: get IDML bytes OUT of the headless
// engine, and read a package's parts back without a `zip` tool.
//
// The export rides `host.editor.client` — the MARKED escape hatch
// (DESIGN.md §4.9) a conformance spec may use for an engine query the
// plugin contract does not expose; the bundle's own source never does.
// `exportIdml` answers `idmlExported { idmlBytes, lost, links }`, where
// `lost` is the engine's own list of what the IDML cannot carry.

import { inflateRawSync } from "node:zlib";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

interface RawClient {
  send(m: { kind: string; payload: unknown }): Promise<{
    kind: string;
    payload: Record<string, unknown>;
  }>;
}

const clientOf = (h: HeadlessHost): RawClient =>
  (h.host as unknown as { editor: { client: RawClient } }).editor.client;

export interface IdmlExport {
  bytes: Uint8Array;
  /** What the engine says the IDML could not carry. */
  lost: string[];
}

/** Export the open document as IDML through the real engine. THROWS when
 *  the engine refuses (`exportIdmlFailed`) — a failed export must not
 *  turn into an empty fixture. */
export async function exportIdml(h: HeadlessHost): Promise<IdmlExport> {
  const reply = await clientOf(h).send({ kind: "exportIdml", payload: {} });
  if (reply.kind !== "idmlExported") {
    throw new Error(`exportIdml answered ${reply.kind}: ${JSON.stringify(reply.payload)}`);
  }
  return {
    bytes: new Uint8Array(reply.payload.idmlBytes as number[]),
    lost: ((reply.payload.lost as string[] | undefined) ?? []).slice(),
  };
}

/** Every entry of a ZIP package, name → bytes (STORED or DEFLATEd — the
 *  two methods an IDML uses). Reads the central directory, so entries
 *  written with a data descriptor (sizes after the data, as InDesign's
 *  own writer does) are read correctly too. */
export function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a ZIP package: no end-of-central-directory record");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = dv.getUint16(p + 10, true);
    const compressed = dv.getUint32(p + 20, true);
    const nameLength = dv.getUint16(p + 28, true);
    const extraLength = dv.getUint16(p + 30, true);
    const commentLength = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength));
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compressed);
    if (method === 0) out.set(name, data.slice());
    else if (method === 8) out.set(name, new Uint8Array(inflateRawSync(data)));
    else throw new Error(`${name}: unsupported compression method ${method}`);
    p += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/** The text of every `Spreads/*.xml` part, in package order. */
export function spreadXml(bytes: Uint8Array): string[] {
  const out: string[] = [];
  for (const [name, data] of unzip(bytes)) {
    if (name.startsWith("Spreads/")) out.push(new TextDecoder().decode(data));
  }
  return out;
}
