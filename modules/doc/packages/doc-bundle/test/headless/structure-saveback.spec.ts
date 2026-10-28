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

// Save-back of Word's structure on the real engine (doc ADRs 610–612):
// `structure.docx` opened standalone; File ▸ Export of it unedited writes
// every part as it was, a header typed into on its master is spliced into
// its own part, and a footnote inserted on the canvas makes its note and
// reference.

import { afterEach, describe, expect, it } from "bun:test";
import { inflateRawSync } from "node:zlib";

import type { ExporterContribution, Mutation } from "@paged-media/plugin-api";

import {
  docxPresent,
  fixture,
  type OpenedDoc,
  openDoc,
  requireDocx,
} from "../conformance/harness";

requireDocx("doc headless — structure save-back");

const text = (b: Uint8Array): string => new TextDecoder().decode(b);

/** A ZIP's entries by name, decompressed. */
function parts(bytes: Uint8Array): Record<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out: Record<string, Uint8Array> = {};
  for (let i = 0; i < count; i += 1) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = text(bytes.subarray(at + 46, at + 46 + nameLen));
    const dataAt =
      local +
      30 +
      view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true);
    const data = bytes.subarray(dataAt, dataAt + size);
    out[name] = method === 0 ? data : new Uint8Array(inflateRawSync(data));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const same = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
  a !== undefined && b !== undefined && Buffer.from(a).equals(Buffer.from(b));

describe.skipIf(!docxPresent)(
  "doc headless — structure save-back @feat:doc-word-headers-footers",
  () => {
    let d: OpenedDoc | undefined;
    afterEach(() => d?.h.dispose());

    async function exportNow(): Promise<Record<string, Uint8Array>> {
      const exporter = d!.h
        .exportersContributed()
        .find(
          (c) => c.id === "media.paged.doc.exporter.docx",
        ) as ExporterContribution;
      const out = await exporter.export();
      expect(out).not.toBeNull();
      return parts(out!.bytes);
    }

    it("an unedited structured document exports every part as it was", async () => {
      d = await openDoc("structure.docx");
      const before = parts(fixture("structure.docx"));
      const after = await exportNow();
      for (const [name, bytes] of Object.entries(before)) {
        expect([name, same(bytes, after[name])]).toEqual([name, true]);
      }
    }, 60_000);

    it("a header typed into on its master is spliced into its part only", async () => {
      d = await openDoc("structure.docx");
      const m = d.opened.ir.masters!.find((x) => x.header)!;
      const part = d.opened.ir.headerFooterParts![m.header!.part]!.part;
      const r = await d.host.document.mutate({
        op: "insertText",
        args: { storyId: m.header!.storyId, offset: 0, text: "New " },
      } as Mutation);
      expect(r.applied).toBe(true);
      const before = parts(fixture("structure.docx"));
      const after = await exportNow();
      expect(text(after[part]!)).toContain("New ");
      for (const [name, bytes] of Object.entries(before)) {
        if (name === part) continue;
        expect([name, same(bytes, after[name])]).toEqual([name, true]);
      }
    }, 60_000);

    it("a footnote inserted on the canvas makes its note and reference @feat:doc-word-footnotes", async () => {
      d = await openDoc("structure.docx");
      const r = await d.host.document.mutate({
        op: "insertFootnote",
        args: { storyId: "docx_s0", offset: 3, text: "Canvas note." },
      } as Mutation);
      expect(r.applied).toBe(true);
      const after = await exportNow();
      const notes = text(after["word/footnotes.xml"]!);
      expect(notes).toContain("Canvas note.");
      const ids = [...notes.matchAll(/<w:footnote w:id="(\d+)">/g)].map(
        (m) => m[1],
      );
      const added = ids.at(-1)!;
      expect(text(after["word/document.xml"]!)).toContain(
        `<w:footnoteReference w:id="${added}"/>`,
      );
    }, 60_000);
  },
);
