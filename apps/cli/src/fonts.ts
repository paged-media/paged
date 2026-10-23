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

// Font files for `package --fonts`: which family and style a TrueType /
// OpenType file (or each face of a collection) answers for, and whether its
// licence lets it be copied. The family is the face's typographic family
// (name ID 16) when it has one, else its family (ID 1), as the engine reads
// it; the embedding permission is OS/2 `fsType`: 2 is Restricted Licence
// embedding, which `package` does not copy (as InDesign does not).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

export interface FontFile {
  path: string;
  family: string;
  style: string | null;
  /** `restricted` (fsType 2), `previewPrint`, `editable`, `installable`. */
  embedding: string | null;
  bytes: Uint8Array;
}

const FONT_EXTS = new Set([".ttf", ".otf", ".ttc", ".otc"]);

function embeddingOf(fsType: number): string {
  if ((fsType & 0x000f) === 0x0002) return "restricted";
  if (fsType & 0x0008) return "editable";
  if (fsType & 0x0004) return "previewPrint";
  return "installable";
}

/** The names and permission of the sfnt at `at` in `b`, or null. */
function readFace(
  b: Uint8Array,
  at: number,
): { family: string; style: string | null; embedding: string | null } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (at + 12 > b.byteLength) return null;
  const tag = (o: number) => String.fromCharCode(...b.subarray(o, o + 4));
  const sfnt = v.getUint32(at);
  if (sfnt !== 0x00010000 && tag(at) !== "OTTO" && tag(at) !== "true")
    return null;
  const count = v.getUint16(at + 4);
  const tables = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const r = at + 12 + i * 16;
    if (r + 16 > b.byteLength) return null;
    tables.set(tag(r), v.getUint32(r + 8));
  }
  const names = new Map<number, string>();
  const name = tables.get("name");
  if (name !== undefined && name + 6 <= b.byteLength) {
    const n = v.getUint16(name + 2);
    const strings = name + v.getUint16(name + 4);
    for (let i = 0; i < n; i++) {
      const r = name + 6 + i * 12;
      if (r + 12 > b.byteLength) break;
      const platform = v.getUint16(r);
      const lang = v.getUint16(r + 4);
      const id = v.getUint16(r + 6);
      const len = v.getUint16(r + 8);
      const off = strings + v.getUint16(r + 10);
      if (off + len > b.byteLength) continue;
      const raw = b.subarray(off, off + len);
      let text: string | null = null;
      if (platform === 3 && (lang === 0x0409 || !names.has(id)))
        text = new TextDecoder("utf-16be").decode(raw);
      else if (platform === 1 && !names.has(id))
        text = String.fromCharCode(...raw);
      if (text !== null && text.trim() !== "") names.set(id, text.trim());
    }
  }
  const family = names.get(16) ?? names.get(1);
  if (!family) return null;
  const os2 = tables.get("OS/2");
  const embedding =
    os2 !== undefined && os2 + 10 <= b.byteLength
      ? embeddingOf(v.getUint16(os2 + 8))
      : null;
  return { family, style: names.get(17) ?? names.get(2) ?? null, embedding };
}

/** The faces of one font file (several for a collection). */
export function facesOf(path: string, bytes: Uint8Array): FontFile[] {
  const tag = String.fromCharCode(...bytes.subarray(0, 4));
  const offsets: number[] = [];
  if (tag === "ttcf" && bytes.byteLength >= 12) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = v.getUint32(8);
    for (let i = 0; i < n && 12 + i * 4 + 4 <= bytes.byteLength; i++)
      offsets.push(v.getUint32(12 + i * 4));
  } else offsets.push(0);
  const out: FontFile[] = [];
  for (const at of offsets) {
    const face = readFace(bytes, at);
    if (face) out.push({ path, ...face, bytes });
  }
  return out;
}

/** Every face in `paths` (files, and the font files of directories,
 *  recursively). A file that is not a font is skipped. */
export function fontFiles(paths: readonly string[]): FontFile[] {
  const out: FontFile[] = [];
  const visit = (p: string) => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const e of readdirSync(p).sort()) visit(join(p, e));
      return;
    }
    if (!FONT_EXTS.has(extname(p).toLowerCase())) return;
    out.push(...facesOf(p, new Uint8Array(readFileSync(p))));
  };
  for (const p of paths) visit(p);
  return out;
}
