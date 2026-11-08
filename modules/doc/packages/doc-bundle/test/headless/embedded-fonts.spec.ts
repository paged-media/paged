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

// Doc ADR 626 — the fonts a Word document embeds reach the document. The
// fixture embeds Lora (an OFL face, unlocked with its GUID) under a family
// name no machine has; File ▸ Open hands the face to the host's document-font
// door once the document is open, the engine then serves the very bytes the
// file embedded, and the export leaves the font parts byte-identical.

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import type {
  ExporterContribution,
  ImporterContribution,
} from "@paged-media/plugin-api";
import {
  createHeadlessHost,
  type HeadlessHost,
  silentConsole as silent,
} from "@paged-media/plugin-sdk";

import { docBundle } from "../../src";
import {
  docxPresent,
  ENGINE_ANCHOR,
  fixture,
  requireDocx,
} from "../conformance/harness";

requireDocx("doc headless — embedded fonts");

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const FAMILY = "Paged Embedded Lora";

/** A row of the document's `fonts` collection (wire `FontSummary`). */
type FontSummary = { family: string; isMissing?: boolean };
type EngineClient = {
  send(m: { kind: string; payload: unknown }): Promise<{
    payload: { found: boolean; style: string; bytes: number[] };
  }>;
};

/** One entry of a ZIP, decompressed (stored or deflated). */
function part(bytes: Uint8Array, name: string): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  for (let i = 0; i < count; i += 1) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const entry = new TextDecoder().decode(
      bytes.subarray(at + 46, at + 46 + nameLen),
    );
    if (entry === name) {
      const dataAt =
        local +
        30 +
        view.getUint16(local + 26, true) +
        view.getUint16(local + 28, true);
      const raw = bytes.subarray(dataAt, dataAt + size);
      return method === 0
        ? raw
        : new Uint8Array(Bun.inflateSync(raw as Uint8Array<ArrayBuffer>));
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

describe.skipIf(!docxPresent)(
  "doc headless — embedded fonts @feat:doc-embedded-fonts",
  () => {
    let h: HeadlessHost | undefined;
    afterEach(() => h?.dispose());

    it("File ▸ Open gives the document the face the file embeds, and export keeps the font parts", async () => {
      const bytes = fixture("embedded-fonts.docx");
      const lora = new Uint8Array(
        readFileSync(
          new URL(
            "../../../../../../engine/core/corpus/fonts/Lora.ttf",
            import.meta.url,
          ),
        ),
      );
      h = await createHeadlessHost({
        resolveFrom: ENGINE_ANCHOR,
        console: silent,
      });
      h.loadBundle(docBundle);
      const importer = h
        .importersContributed()
        .find(
          (c) => c.id === "media.paged.doc.importer.docx",
        ) as ImporterContribution;
      await h.newBlank(300, 300);
      await importer.import({
        name: "embedded-fonts.docx",
        bytes,
        mimeType: DOCX_MIME,
        newDocument: true,
      });
      expect(h.host.supports("assets.documentFont@1")).toBe(true);
      const fonts = await h.host.document.collection<FontSummary>("fonts");
      const row = fonts.find((f) => f.family === FAMILY);
      expect(row, "the document names the family").toBeDefined();
      expect(row!.isMissing).toBeFalsy();

      // The engine serves the very bytes the file embedded (unlocked).
      const client = (h.host as unknown as { editor: { client: EngineClient } })
        .editor.client;
      const r = await client.send({
        kind: "requestFontFaceBytes",
        payload: { family: FAMILY, style: "Regular" },
      });
      expect(r.payload.found).toBe(true);
      expect(Uint8Array.from(r.payload.bytes)).toEqual(lora);

      // An unedited export carries the font table and the part untouched.
      const exporter = h
        .exportersContributed()
        .find(
          (c) => c.id === "media.paged.doc.exporter.docx",
        ) as ExporterContribution;
      const out = await exporter.export();
      expect(out).not.toBeNull();
      for (const name of ["word/fontTable.xml", "word/fonts/font1.odttf"]) {
        expect(part(out!.bytes, name), name).toEqual(part(bytes, name));
      }
    }, 120_000);
  },
);
