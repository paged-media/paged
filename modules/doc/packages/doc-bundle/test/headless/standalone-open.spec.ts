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

// A .docx opened standalone on the plain headless host (the Node CLI's host):
// its native-open door loads the bundle's skeleton as the document, so File ▸
// Open makes the Word document the whole document, as in the editor. Then the
// save-back of the native tables' cells: text typed into a cell on the canvas
// (the cell-addressed text ops the editor's typing sends) is written into the
// cell's runs of the exported .docx.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

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
import { DocEngine } from "../../src/engine";
import {
  docxPresent,
  ENGINE_ANCHOR,
  fixture,
  requireDocx,
  storyTexts,
} from "../conformance/harness";

requireDocx("doc headless — standalone open and cell save-back");

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
// price-table.docx: a heading, a 3 x 2 table, a body paragraph after it.
const BODY = ["Price list", "Dear «Name»", "Kind regards"];
const CELLS = [
  "Item",
  "Price",
  "Apples",
  "1.20",
  "Line one\nLine two",
  "For «Name»",
];

describe.skipIf(!docxPresent)(
  "doc headless — standalone open and cell save-back @feat:plugin-doc.object-model",
  () => {
    let h: HeadlessHost;
    let importer: ImporterContribution;
    let exporter: ExporterContribution;

    beforeEach(async () => {
      h = await createHeadlessHost({
        resolveFrom: ENGINE_ANCHOR,
        console: silent,
      });
      h.loadBundle(docBundle);
      importer = h
        .importersContributed()
        .find((c) => c.id === "media.paged.doc.importer.docx")!;
      exporter = h
        .exportersContributed()
        .find((c) => c.id === "media.paged.doc.exporter.docx")!;
      await h.newBlank(300, 300);
      await importer.import({
        name: "price-table.docx",
        bytes: fixture("price-table.docx"),
        mimeType: DOCX_MIME,
        newDocument: true,
      });
    }, 60_000);
    afterEach(() => h?.dispose());

    /** The skeleton's one section story. */
    async function story(): Promise<string> {
      const stories = await h.host.document.collection<{ selfId: string }>(
        "stories",
      );
      expect(stories).toHaveLength(1);
      return stories[0]!.selfId;
    }

    /** The native table's id in the section story. */
    async function tableId(): Promise<string> {
      const [table] = await h.objects.query(`story:${await story()} > table`);
      return table!.replace(/^table:/, "");
    }

    /** Type into a cell as the canvas does: cell-local text ops. */
    async function typeInCell(
      row: number,
      col: number,
      offset: number,
      text: string,
      remove = 0,
    ): Promise<void> {
      const cell = { tableId: await tableId(), row, col };
      const storyId = await story();
      if (remove > 0) {
        const del = await h.host.document.mutate({
          op: "deleteRange",
          args: { storyId, start: offset, end: offset + remove, cell },
        });
        expect(del.applied).toBe(true);
      }
      if (text) {
        const ins = await h.host.document.mutate({
          op: "insertText",
          args: { storyId, offset, text, cell },
        });
        expect(ins.applied).toBe(true);
      }
    }

    /** Export, then open the exported .docx again: its body and cells. */
    async function reimported(): Promise<{ body: string[]; cells: string[] }> {
      const out = await exporter.export();
      expect(out).not.toBeNull();
      const engine = await DocEngine.boot();
      try {
        engine.loadDocx(out!.bytes);
        const blocks = engine.lowered().story.blocks;
        const text = (p: { runs: Array<{ text: string }> }) =>
          p.runs.map((r) => r.text).join("");
        const table = blocks.find((b) => b.kind === "table");
        return {
          body: blocks.flatMap((b) =>
            b.kind === "paragraph" ? [text(b)] : [],
          ),
          cells:
            table?.kind === "table"
              ? table.cells.map((c) => c.paragraphs.map(text).join("\n"))
              : [],
        };
      } finally {
        engine.dispose();
      }
    }

    const saveBackDiagnostics = () =>
      h.host.diagnostics.get("media.paged.doc/save-back");

    it("the importer opens the .docx as its own document through the native-open door", async () => {
      expect(h.host.supports("document.openNative@1")).toBe(true);
      const pages = await h.host.document.collection<{
        sizePt?: [number, number];
      }>("pages");
      expect(pages.length).toBeGreaterThanOrEqual(1);
      // The blank 300 x 300 page is gone: the Word page took its place.
      expect(pages[0]!.sizePt?.map(Math.round)).not.toEqual([300, 300]);
      expect(await storyTexts(h.host, await story())).toEqual(BODY);
      expect(
        await h.objects.query("plugin:media.paged.doc/docxDocument"),
      ).toHaveLength(1);
      const id = await tableId();
      expect(await h.objects.get(`cell:${id}/1,0`, "text")).toMatchObject({
        value: "Apples",
      });
    });

    it("text typed into table cells on the canvas is in the exported .docx", async () => {
      // "Apples" → "Green apples"; "Line two" → "Line 2"; "1.20" → "1.25".
      await typeInCell(1, 0, 0, "Green a", 1);
      await typeInCell(2, 0, "Line one\nLine ".length, "2", "two".length);
      await typeInCell(1, 1, 3, "5", 1);
      const after = [...CELLS];
      after[2] = "Green apples";
      after[3] = "1.25";
      after[4] = "Line one\nLine 2";
      const back = await reimported();
      expect(back.cells).toEqual(after);
      expect(back.body).toEqual(BODY);
    });

    it("an untouched document exports its cells as they were", async () => {
      const back = await reimported();
      expect(back.cells).toEqual(CELLS);
      expect(back.body).toEqual(BODY);
    });

    it("a paragraph added in a cell is not saved and is reported", async () => {
      await typeInCell(0, 0, "Item".length, "\nSecond");
      await typeInCell(1, 0, 0, "Red ");
      const back = await reimported();
      expect(back.cells[0]).toBe("Item");
      expect(back.cells[2]).toBe("Red Apples");
      const messages = saveBackDiagnostics().map((d) => d.message);
      expect(messages.join("\n")).toMatch(/paragraphs were added or removed/);
    });
  },
);
