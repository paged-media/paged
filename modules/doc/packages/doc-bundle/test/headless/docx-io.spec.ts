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

// File ▸ Open of a .docx and File ▸ Export as .docx on the REAL engine
// (headless): the bundle on a host whose native-document door loads the
// package it produces as the active document (the editor's arrangement).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

import type {
  BundleHost,
  ExporterContribution,
  ImporterContribution,
  PluginManifest,
} from "@paged-media/plugin-api";
import {
  createBundleHost,
  createHeadlessHost,
  type HeadlessHost,
  silentConsole as silent,
} from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import { docBundle } from "../../src";
import { DocEngine } from "../../src/engine";
import { placeEmbedded } from "../../src/place";
import {
  docxPresent,
  fixture,
  requireDocx,
  storyTexts,
} from "../conformance/harness";

requireDocx("doc headless — File ▸ Open and File ▸ Export");

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe.skipIf(!docxPresent)(
  "doc headless — File ▸ Open and File ▸ Export of a .docx (unavailable without bin/docx_js_bg.wasm: bash scripts/build-wasm.sh; REQUIRE_REAL_DOCX=1 fails instead)",
  () => {
    let h: HeadlessHost;
    let host: BundleHost;
    let importer: ImporterContribution;
    let exporter: ExporterContribution;
    let dispose: () => void;
    const errors: string[] = [];

    /** A fresh session: a headless host with the bundle activated. */
    async function start(): Promise<void> {
      errors.length = 0;
      h = await createHeadlessHost({
        resolveFrom: ENGINE_ANCHOR,
        console: silent,
      });
      const handle = createBundleHost(
        () => h.host.editor,
        docBundle.manifest as PluginManifest,
        {
          console: {
            ...silent,
            error: (...a: unknown[]) => void errors.push(a.join(" ")),
          },
          nativeDocument: {
            readModel: async () => null,
            readComposition: async () => null,
            listParts: async () => [],
            open: async (bytes) => {
              await h.load(bytes);
            },
          },
        },
      );
      host = handle.host;
      const bundle = docBundle.activate(host);
      dispose = () => {
        bundle.dispose();
        handle.dispose();
      };
      importer = h
        .importersContributed()
        .find((c) => c.id === "media.paged.doc.importer.docx")!;
      exporter = h
        .exportersContributed()
        .find((c) => c.id === "media.paged.doc.exporter.docx")!;
    }

    beforeEach(async () => {
      await start();
      await h.newBlank(300, 300);
    }, 60_000);

    afterEach(() => {
      dispose?.();
      h?.dispose();
    });

    /** Every story's paragraphs, in document order. */
    async function allText(): Promise<string[]> {
      const stories = await h.host.document.collection<{ selfId: string }>(
        "stories",
      );
      const out: string[] = [];
      for (const s of stories) out.push(...(await storyTexts(host, s.selfId)));
      return out;
    }

    it("File ▸ Open of a .docx opens it as its own document: the Word page, its text, a Word document object", async () => {
      covers("importer:media.paged.doc.importer.docx");
      await importer.import({
        name: "merge-letter.docx",
        bytes: fixture("merge-letter.docx"),
        mimeType: DOCX_MIME,
      });
      expect(errors).toEqual([]);
      // The blank page is gone: the document is the Word document.
      const pages = await h.host.document.collection<{
        sizePt?: [number, number];
      }>("pages");
      expect(pages.length).toBeGreaterThanOrEqual(1);
      expect(pages[0]!.sizePt?.map(Math.round)).not.toEqual([300, 300]);
      expect(await allText()).toEqual([
        "Dear «First Name», from «City» and «City», page 1",
        "Order «OrderNo»",
      ]);
      expect(
        await host.objects.query("plugin:media.paged.doc/docxDocument"),
      ).toHaveLength(1);
    });

    it("bytes that are not a Word document open nothing", async () => {
      covers("importer:media.paged.doc.importer.docx");
      const before = await h.host.document.collection("pages");
      await importer
        .import({
          name: "notes.docx",
          bytes: new TextEncoder().encode("not a zip"),
          mimeType: DOCX_MIME,
        })
        .catch(() => undefined);
      expect(await h.host.document.collection("pages")).toEqual(before);
      expect(
        await host.objects.query("plugin:media.paged.doc/docxDocument"),
      ).toEqual([]);
    });

    it("File ▸ Export writes the open Word document as a .docx Word reads, with an edit made since", async () => {
      covers("exporter:media.paged.doc.exporter.docx");
      await importer.import({
        name: "merge-letter.docx",
        bytes: fixture("merge-letter.docx"),
        mimeType: DOCX_MIME,
      });
      const field = "plugin:media.paged.doc/mergeField/docx_f0/b1/f0";
      expect(await host.objects.set(field, "value", "A-17")).toMatchObject({
        applied: true,
      });
      const out = await exporter.export();
      expect(out).not.toBeNull();
      expect(out!.fileName).toBe("merge-letter.docx");
      expect(new TextDecoder().decode(out!.bytes.subarray(0, 2))).toBe("PK");
      const engine = await DocEngine.boot();
      try {
        engine.loadDocx(out!.bytes);
        const text = engine
          .lowered()
          .story.blocks.flatMap((b) =>
            b.kind === "paragraph" ? b.runs.map((r) => r.text) : [],
          )
          .join("");
        expect(text).toContain("A-17");
      } finally {
        engine.dispose();
      }
    });

    it("File ▸ Export of a saved Word document reopened in a new session writes it with its edits", async () => {
      covers("exporter:media.paged.doc.exporter.docx");
      await importer.import({
        name: "merge-letter.docx",
        bytes: fixture("merge-letter.docx"),
        mimeType: DOCX_MIME,
      });
      const field = "plugin:media.paged.doc/mergeField/docx_f0/b1/f0";
      expect(await host.objects.set(field, "value", "B-9")).toMatchObject({
        applied: true,
      });
      const { bytes: saved } = await h.exportDocument("paged");
      dispose();
      h.dispose();
      // Another session opens the saved document: the importing session's
      // record is gone, the label and the parts are not.
      await start();
      await h.load(saved);
      const out = await exporter.export();
      expect(out).not.toBeNull();
      expect(out!.fileName).toBe("merge-letter.docx");
      const engine = await DocEngine.boot();
      try {
        engine.loadDocx(out!.bytes);
        const text = engine
          .lowered()
          .story.blocks.flatMap((b) =>
            b.kind === "paragraph" ? b.runs.map((r) => r.text) : [],
          )
          .join("");
        expect(text).toContain("B-9");
      } finally {
        engine.dispose();
      }
    });

    it("Insert ▸ Word document… of a two-column section places the copy in a two-column frame at Word's gap", async () => {
      covers("command:media.paged.doc.command.placeDoc");
      const bytes = fixture("two-columns.docx");
      const engine = await DocEngine.boot();
      let ir;
      try {
        engine.loadDocx(bytes);
        ir = engine.lowered();
      } finally {
        engine.dispose();
      }
      expect(ir.section.frameColumns).toBe(2);
      const placed = await placeEmbedded(host, ir, bytes, "two-columns.docx");
      expect(placed).not.toBeNull();
      const frame = `${placed!.frameId.kind}:${placed!.frameId.id}`;
      // `w:cols w:num="2" w:space="360"`: two columns, 18 pt apart.
      expect(await host.objects.get(frame, "textFrameColumnCount")).toEqual({
        kind: "value",
        value: 2,
      });
      expect(await host.objects.get(frame, "textFrameColumnGutter")).toEqual({
        kind: "value",
        value: 18,
      });
      expect(errors).toEqual([]);
    });

    it("a placed Word document saves its table cells back after the story's tables changed", async () => {
      covers("exporter:media.paged.doc.exporter.docx");
      const bytes = fixture("price-table.docx");
      const engine = await DocEngine.boot();
      let ir;
      try {
        engine.loadDocx(bytes);
        ir = engine.lowered();
      } finally {
        engine.dispose();
      }
      const placed = await placeEmbedded(host, ir, bytes, "price-table.docx");
      const storyId = placed!.storyId!;
      const [word] = await host.objects.query(`story:${storyId} > table`);
      const wordTable = word!.replace(/^table:/, "");
      // A table of the same shape added to the story after the Word one,
      // a cell of each typed into.
      const added = await host.document.mutate({
        op: "insertTable",
        args: {
          storyId,
          rows: 3,
          cols: 2,
          headerRows: 0,
          footerRows: 0,
          columnWidths: [100, 100],
          rowHeights: [],
        },
      } as never);
      expect(added.applied).toBe(true);
      const tables = await host.objects.query(`story:${storyId} > table`);
      expect(tables).toHaveLength(2);
      const other = tables
        .map((a) => a.replace(/^table:/, ""))
        .find((t) => t !== wordTable)!;
      for (const [tableId, text] of [
        [wordTable, "Red "],
        [other, "Mine"],
      ] as const) {
        const ins = await host.document.mutate({
          op: "insertText",
          args: {
            storyId,
            offset: 0,
            text,
            cell: { tableId, row: 1, col: 0 },
          },
        });
        expect(ins.applied).toBe(true);
      }
      const out = await exporter.export();
      expect(out).not.toBeNull();
      const back = await DocEngine.boot();
      try {
        back.loadDocx(out!.bytes);
        const table = back
          .lowered()
          .story.blocks.find((b) => b.kind === "table");
        expect(
          table?.kind === "table"
            ? table.cells.map((c) =>
                c.paragraphs
                  .map((p) => p.runs.map((r) => r.text).join(""))
                  .join("\n"),
              )
            : [],
        ).toEqual([
          "Item",
          "Price",
          "Red Apples",
          "1.20",
          "Line one\nLine two",
          "For «Name»",
        ]);
      } finally {
        back.dispose();
      }
      expect(host.diagnostics.get("media.paged.doc/save-back")).toEqual([]);
      expect(errors).toEqual([]);
    });

    it("with no Word document open there is nothing to export", async () => {
      covers("exporter:media.paged.doc.exporter.docx");
      expect(await exporter.export()).toBeNull();
    });
  },
);
