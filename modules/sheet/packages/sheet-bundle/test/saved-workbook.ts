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

// The workbook version the document's label names, read back from its
// stored part: what the object model wrote, without an engine door.

import { inflateRawSync } from "node:zlib";

import { P, value, type SheetEnv } from "./conformance/env";

/** The workbook version the document names, unzipped: its first sheet's
 *  XML and its styles. */
export async function savedWorkbook(
  env: SheetEnv,
): Promise<{ sheet: string; styles: string }> {
  const hash = await value(env, `${P}/workbook/main`, "version");
  const bytes = await env.host.parts.read(`versions/${String(hash)}.xlsx`);
  if (!bytes) throw new Error(`no stored version ${String(hash)}`);
  const out = xlsxEntries(bytes);
  return {
    sheet: out.get("xl/worksheets/sheet1.xml") ?? "",
    styles: out.get("xl/styles.xml") ?? "",
  };
}

/** Every entry of an xlsx (a zip), as text. */
export function xlsxEntries(bytes: Uint8Array): Map<string, string> {
  const zip = Buffer.from(bytes);
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const at =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(at, at + size);
    out.set(
      name,
      (method === 8 ? inflateRawSync(data) : data).toString("utf8"),
    );
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
