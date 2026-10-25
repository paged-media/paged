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

// The text around native tables, on the real engine: paragraphs before,
// between and after tables, a blank line before a table and after one, a
// table that opens the document and tables back to back each pour into a
// paragraph of their own, opened standalone and placed embedded. Each native
// table stands in a paragraph that holds only the table. Save-back of a canvas
// edit after the tables lands in the right Word paragraph, and an untouched
// document exports as it came in.

import { afterEach, describe, expect, it } from "bun:test";
import { inflateRawSync } from "node:zlib";

import type {
  ExporterContribution,
  ImporterContribution,
} from "@paged-media/plugin-api";
import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

import { docBundle } from "../../src";
import { DocEngine } from "../../src/engine";
import {
  docxPresent,
  ENGINE_ANCHOR,
  requireDocx,
} from "../conformance/harness";

requireDocx("doc headless — text around native tables");

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// ---------------------------------------------------------------------------
// A minimal .docx, zipped here (stored entries), so the fixture is readable.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Zip `parts` without compression (a valid OPC package). */
function zipStored(parts: ReadonlyArray<[string, string]>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of parts) {
    const n = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, n.length, true);
    chunks.push(new Uint8Array(local.buffer), n, data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, n.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), n);
    offset += 30 + n.length + data.length;
  }
  const size = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, parts.length, true);
  end.setUint16(10, parts.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let at = 0;
  for (const c of all) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** One part of a zip package, inflated (stored or deflated entries). */
function zipPart(zip: Uint8Array, name: string): string | null {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const dec = new TextDecoder();
  let at = 0;
  while (at + 30 <= zip.length && view.getUint32(at, true) === 0x04034b50) {
    const method = view.getUint16(at + 8, true);
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extra = view.getUint16(at + 28, true);
    const entry = dec.decode(zip.subarray(at + 30, at + 30 + nameLength));
    const start = at + 30 + nameLength + extra;
    if ((view.getUint16(at + 6, true) & 8) !== 0) return null; // sizes after the data
    if (entry === name) {
      const data = zip.subarray(start, start + size);
      return dec.decode(method === 8 ? inflateRawSync(data) : data);
    }
    at = start + size;
  }
  return null;
}

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** A paragraph; `style` a paragraph style id of {@link STYLES}. */
const p = (text: string, style?: string) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${
    text ? `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>` : ""
  }</w:p>`;

/** A one-row table, one cell per text. */
const tbl = (...cells: string[]) =>
  `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${cells
    .map(() => `<w:gridCol w:w="2000"/>`)
    .join("")}</w:tblGrid><w:tr>${cells
    .map(
      (c) =>
        `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${p(c)}</w:tc>`,
    )
    .join("")}</w:tr></w:tbl>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Blank"><w:name w:val="Blank"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="240"/></w:pPr></w:style>
</w:styles>`;

function docx(body: string): Uint8Array {
  return zipStored([
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    ],
    [
      "word/_rels/document.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    ],
    [
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    ],
    ["word/styles.xml", STYLES],
  ]);
}

// para / table / para / blank line / table / table / para.
const MIXED = docx(
  p("Before") +
    tbl("A1", "B1") +
    p("Between") +
    p("", "Blank") +
    tbl("C1") +
    tbl("D1") +
    p("After"),
);
// A table that opens the document, a blank line right after it.
const LEADING = docx(tbl("T1") + p("", "Blank") + p("Tail"));

// The native story: each table in a paragraph of its own ("").
const MIXED_STORY = ["Before", "", "Between", "", "", "", "After"];
const MIXED_BODY = ["Before", "Between", "", "After"];
const MIXED_CELLS = [["A1", "B1"], ["C1"], ["D1"]];

// ---------------------------------------------------------------------------

describe.skipIf(!docxPresent)(
  "doc headless — text around native tables @feat:plugin-doc.object-model",
  () => {
    let h: HeadlessHost;
    const warnings: string[] = [];

    async function boot(): Promise<{
      importer: ImporterContribution;
      exporter: ExporterContribution;
    }> {
      warnings.length = 0;
      const record = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
      h = await createHeadlessHost({
        resolveFrom: ENGINE_ANCHOR,
        console: {
          debug: () => {},
          info: () => {},
          warn: record,
          error: record,
        },
      });
      h.loadBundle(docBundle);
      await h.newBlank(300, 300);
      return {
        importer: h
          .importersContributed()
          .find((c) => c.id === "media.paged.doc.importer.docx")!,
        exporter: h
          .exportersContributed()
          .find((c) => c.id === "media.paged.doc.exporter.docx")!,
      };
    }
    afterEach(() => h?.dispose());

    async function open(bytes: Uint8Array): Promise<ExporterContribution> {
      const { importer, exporter } = await boot();
      await importer.import({
        name: "tables.docx",
        bytes,
        mimeType: DOCX_MIME,
        newDocument: true,
      });
      return exporter;
    }

    async function storyIds(): Promise<string[]> {
      const stories = await h.host.document.collection<{ selfId: string }>(
        "stories",
      );
      return stories.map((s) => s.selfId);
    }

    async function paragraphs(storyId: string) {
      const c = await h.host.document.storyContent(storyId);
      return (c?.paragraphs ?? []).map((q) => ({
        text: q.runs.map((r) => r.text).join(""),
        style: (q as { paragraphStyle?: string }).paragraphStyle,
      }));
    }

    /** Each native table of the story, in order: its cells' text, row 0. */
    async function tableCells(storyId: string): Promise<string[][]> {
      const out: string[][] = [];
      for (const t of await h.objects.query(`story:${storyId} > table`)) {
        const id = t.replace(/^table:/, "");
        const row: string[] = [];
        for (let col = 0; ; col += 1) {
          let read;
          try {
            read = await h.objects.get(`cell:${id}/0,${col}`, "text");
          } catch {
            break;
          }
          if (read.kind !== "value") break;
          row.push(String(read.value));
        }
        out.push(row);
      }
      return out;
    }

    /** The lowering of `bytes`: its body paragraphs' text, each table's
     *  first-row cells, and the paragraph style id of every block. */
    async function lower(bytes: Uint8Array) {
      const engine = await DocEngine.boot();
      try {
        engine.loadDocx(bytes);
        const blocks = engine.lowered().story.blocks;
        const text = (q: { runs: Array<{ text: string }> }) =>
          q.runs.map((r) => r.text).join("");
        return {
          body: blocks.flatMap((b) =>
            b.kind === "paragraph" ? [text(b)] : [],
          ),
          cells: blocks.flatMap((b) =>
            b.kind === "table"
              ? [b.cells.map((c) => c.paragraphs.map(text).join("\n"))]
              : [],
          ),
          styles: blocks.map((b) =>
            b.kind === "paragraph" ? b.paraStyleId : undefined,
          ),
        };
      } finally {
        engine.dispose();
      }
    }

    it("every paragraph pours around the tables, each table in a paragraph of its own", async () => {
      await open(MIXED);
      const [story] = await storyIds();
      const paras = await paragraphs(story!);
      expect(paras.map((q) => q.text)).toEqual(MIXED_STORY);
      expect(await tableCells(story!)).toEqual(MIXED_CELLS);
      // The blank line (Word block 3) is native paragraph 3, styled by its
      // caret; the table after it (paragraph 4) is not the blank line.
      const { styles } = await lower(MIXED);
      expect(styles[3]).toBeDefined();
      expect(paras[3]!.style).toBe(styles[3]);
      expect(paras[4]!.style).not.toBe(styles[3]);
      expect(paras[2]!.style).toBe(styles[2]);
      expect(paras[6]!.style).toBe(styles[6]);
      expect(warnings.filter((w) => w.includes("paged.doc: "))).toEqual([]);
    });

    it("a table that opens the document takes its first paragraph; the blank line after it is its own", async () => {
      await open(LEADING);
      const [story] = await storyIds();
      const paras = await paragraphs(story!);
      expect(paras.map((q) => q.text)).toEqual(["", "", "Tail"]);
      expect(await tableCells(story!)).toEqual([["T1"]]);
      const { styles } = await lower(LEADING);
      expect(paras[1]!.style).toBe(styles[1]);
      expect(paras[0]!.style).not.toBe(styles[1]);
      expect(warnings.filter((w) => w.includes("paged.doc: "))).toEqual([]);
    });

    it("an untouched document exports as it came in", async () => {
      const exporter = await open(MIXED);
      const out = await exporter.export();
      expect(out).not.toBeNull();
      const back = await lower(out!.bytes);
      expect(back.body).toEqual(MIXED_BODY);
      expect(back.cells).toEqual(MIXED_CELLS);
      // No Word part was rewritten: the body is the one that came in.
      const source = zipPart(MIXED, "word/document.xml");
      expect(source).not.toBeNull();
      expect(zipPart(out!.bytes, "word/document.xml")).toBe(source);
      expect(h.host.diagnostics.get("media.paged.doc/save-back") ?? []).toEqual(
        [],
      );
    });

    it("an edit after the second table is saved into its Word paragraph", async () => {
      const exporter = await open(MIXED);
      const [story] = await storyIds();
      // The end of "After", native paragraph 6, in the insertText space:
      // every paragraph before it and one break each.
      const paras = await paragraphs(story!);
      let offset = 0;
      for (let k = 0; k < 6; k += 1)
        offset += new TextEncoder().encode(paras[k]!.text).length + 1;
      offset += "After".length;
      const typed = await h.host.document.mutate({
        op: "insertText",
        args: { storyId: story!, offset, text: " all", cell: null },
      });
      expect(typed.applied).toBe(true);
      // And the paragraph between the first two tables: the end of
      // "Between", native paragraph 2.
      const between = "Before".length + 1 + 1 + "Between".length;
      const edited = await h.host.document.mutate({
        op: "insertText",
        args: { storyId: story!, offset: between, text: " us", cell: null },
      });
      expect(edited.applied).toBe(true);
      expect((await paragraphs(story!)).map((q) => q.text)).toEqual([
        "Before",
        "",
        "Between us",
        "",
        "",
        "",
        "After all",
      ]);
      const out = await exporter.export();
      const back = await lower(out!.bytes);
      expect(back.body).toEqual(["Before", "Between us", "", "After all"]);
      expect(back.cells).toEqual(MIXED_CELLS);
      expect(h.host.diagnostics.get("media.paged.doc/save-back") ?? []).toEqual(
        [],
      );
    });

    it("placed embedded, the same document pours the same way", async () => {
      await boot();
      const out = (await h.objects.invoke("media.paged.doc.command.placeDoc", {
        bytes: MIXED,
        fileName: "placed.docx",
      })) as { story: string };
      const story = out.story.slice("story:".length);
      const paras = await paragraphs(story);
      expect(paras.map((q) => q.text)).toEqual(MIXED_STORY);
      expect(await tableCells(story)).toEqual(MIXED_CELLS);
      const { styles } = await lower(MIXED);
      expect(paras[3]!.style).toBe(styles[3]);
      expect(warnings.filter((w) => w.includes("paged.doc: "))).toEqual([]);
    });
  },
);
