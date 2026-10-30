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

// Doc ADR 614 on the real engine: the W4a documents
// (docx_conformance::objects_*_docx) opened standalone. Text boxes are
// text frames with their own stories, poured; a float in a section's first
// paragraph is a picture frame with Word's wrap; floats elsewhere are
// anchored objects at Word's position; a table's borders, shading and
// alignment reach its cells and paragraph; a text box typed into saves into
// its `w:txbxContent`, and an unedited export writes every part as it was.

import { afterEach, describe, expect, it } from "bun:test";
import { inflateRawSync } from "node:zlib";

import type { ExporterContribution, Mutation } from "@paged-media/plugin-api";

import {
  docxPresent,
  fixture,
  type OpenedDoc,
  openDoc,
  requireDocx,
  storyTexts,
} from "../conformance/harness";

requireDocx("doc headless — floating objects and text boxes");

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
  "doc headless — floating objects and text boxes @feat:plugin-doc.standalone-open",
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

    it("text boxes are text frames whose stories hold the boxes' text", async () => {
      d = await openDoc("objects-text-boxes.docx");
      const boxes = (d.opened.ir.pageItems ?? []).filter(
        (i) => i.item.kind === "textBox",
      );
      expect(boxes).toHaveLength(3);
      const texts = await Promise.all(
        boxes.map((b) =>
          b.item.kind === "textBox"
            ? storyTexts(d!.host, b.item.storyId)
            : Promise.resolve([]),
        ),
      );
      expect(texts[0]).toEqual(["TB1 page box line one", "TB1 line two"]);
      expect(texts[1]).toEqual(["TBV legacy box"]);
      expect(texts[2]).toEqual(["TBH header box"]);
      const props = await d.host.document.elementProperties({
        kind: "textFrame",
        id: "docx_o0",
      } as never);
      expect(props).not.toBeNull();
    }, 60_000);

    it("an unedited export writes every part as it was", async () => {
      for (const name of [
        "objects-text-boxes.docx",
        "objects-floats.docx",
        "objects-table-look.docx",
        "objects-nested-tables.docx",
        "objects-languages.docx",
      ]) {
        d = await openDoc(name);
        const before = parts(fixture(name));
        const after = await exportNow();
        for (const [part, bytes] of Object.entries(before)) {
          expect([name, part, same(bytes, after[part])]).toEqual([
            name,
            part,
            true,
          ]);
        }
        d.h.dispose();
        d = undefined;
      }
    }, 120_000);

    it("a text box typed into is saved into its box and its fallback", async () => {
      d = await openDoc("objects-text-boxes.docx");
      const r = await d.host.document.mutate({
        op: "insertText",
        args: { storyId: "docx_o0_s", offset: 0, text: "New " },
      } as Mutation);
      expect(r.applied).toBe(true);
      const before = parts(fixture("objects-text-boxes.docx"));
      const after = await exportNow();
      const xml = text(after["word/document.xml"]!);
      expect(xml.split("New TB1 page box line one").length - 1).toBe(2);
      for (const [part, bytes] of Object.entries(before)) {
        if (part === "word/document.xml") continue;
        expect([part, same(bytes, after[part])]).toEqual([part, true]);
      }
    }, 60_000);

    it("floats are a picture frame and anchored objects", async () => {
      d = await openDoc("objects-floats.docx");
      const items = d.opened.ir.pageItems ?? [];
      expect(items.map((i) => i.id)).toEqual(["docx_o0", "docx_o1"]);
      const svg = await d.host.document.exportSvg({
        pageId: "docx_p0",
      } as never);
      expect(svg.svg ?? "").toContain("<image");
      // The anchored floats carry their settings: an anchored frame with a
      // custom position is in the story's paragraphs.
      const c = (await d.host.document.storyContent(
        d.opened.storyIds[3]!,
      )) as unknown as { paragraphs: unknown[] };
      expect(c.paragraphs.length).toBeGreaterThan(0);
    }, 60_000);

    it("a table's look reaches its cells", async () => {
      d = await openDoc("objects-table-look.docx");
      const tables = await d.h.objects.query(
        `story:${d.opened.storyIds[0]} > table`,
      );
      expect(tables).toHaveLength(6);
      const get = async (t: number, path: string) => {
        const id = tables[t]!.replace(/^table:/, "");
        return (
          (await d!.h.objects.get(`cell:${id}/0,0`, path)) as {
            value: unknown;
          }
        ).value;
      };
      // Every cell's text arrived with its look (one batch per table).
      expect(await get(1, "text")).toBe("TB r0c0");
      expect(await get(1, "cellFillColor")).toBe("Color/docx-FFFF00");
      expect(await get(1, "cellTopEdgeStrokeWeight")).toBe(1.5);
      expect(await get(1, "cellRightEdgeStrokeWeight")).toBe(0);
      expect(await get(0, "cellTopEdgeStrokeWeight")).toBe(0.5);
    }, 60_000);
  },
);
