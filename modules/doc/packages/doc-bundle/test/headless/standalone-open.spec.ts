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
// The native story: the table stands in a paragraph of its own.
const STORY = ["Price list", "", "Dear «Name»", "Kind regards"];
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
      expect(await storyTexts(h.host, await story())).toEqual(STORY);
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

    it("paragraphs added and removed in a cell are in the exported .docx", async () => {
      // A paragraph added after "Item"; "Line two" removed from its cell;
      // a word typed into another cell alongside.
      await typeInCell(0, 0, "Item".length, "\nSecond");
      await typeInCell(2, 0, "Line one".length, "", "\nLine two".length);
      await typeInCell(1, 0, 0, "Red ");
      const back = await reimported();
      const after = [...CELLS];
      after[0] = "Item\nSecond";
      after[2] = "Red Apples";
      after[4] = "Line one";
      expect(back.cells).toEqual(after);
      expect(back.body).toEqual(BODY);
      expect(saveBackDiagnostics()).toEqual([]);
    });

    it("a look given to part of a run on the canvas splits that run in the exported .docx", async () => {
      // The style the import made for the bold "les" in "Apples".
      const engine = await DocEngine.boot();
      let boldStyle: string;
      try {
        engine.loadDocx(fixture("price-table.docx"));
        const table = engine
          .lowered()
          .story.blocks.find((b) => b.kind === "table");
        if (table?.kind !== "table") throw new Error("no table");
        boldStyle = table.cells[2]!.paragraphs[0]!.runs[1]!.charStyleId!;
      } finally {
        engine.dispose();
      }
      expect(boldStyle).toBeTruthy();
      const storyId = await story();
      // In a cell: "1." of "1.20" takes the bold look.
      const inCell = await h.host.document.mutate({
        op: "applyStyle",
        args: {
          storyId,
          start: 0,
          end: 2,
          style: boldStyle,
          scope: "character",
          cell: { tableId: await tableId(), row: 1, col: 1 },
        },
      } as never);
      expect(inCell.applied).toBe(true);
      // In the body: "Price" of "Price list".
      const inBody = await h.host.document.mutate({
        op: "applyStyle",
        args: {
          storyId,
          start: 0,
          end: 5,
          style: boldStyle,
          scope: "character",
        },
      } as never);
      expect(inBody.applied).toBe(true);

      const out = await exporter.export();
      expect(saveBackDiagnostics()).toEqual([]);
      const back = await DocEngine.boot();
      try {
        back.loadDocx(out!.bytes);
        const blocks = back.lowered().story.blocks;
        const runs = (p: {
          runs: Array<{ text: string; charStyleId?: string | null }>;
        }) => p.runs.map((r) => [r.text, r.charStyleId ?? null] as const);
        const heading = blocks[0];
        if (heading?.kind !== "paragraph") throw new Error("no heading");
        const [price, list] = runs(heading);
        expect([price![0], list![0]]).toEqual(["Price", " list"]);
        expect(price![1]).not.toEqual(list![1]);
        const table = blocks.find((b) => b.kind === "table");
        if (table?.kind !== "table") throw new Error("no table");
        const [one, twenty] = runs(table.cells[3]!.paragraphs[0]!);
        expect([one![0], twenty![0]]).toEqual(["1.", "20"]);
        expect(one![1]).not.toEqual(twenty![1]);
        // "Apples" kept its two runs; the other cells their text.
        expect(runs(table.cells[2]!.paragraphs[0]!).map((r) => r[0])).toEqual([
          "App",
          "les",
        ]);
        expect(
          table.cells.map((c) =>
            c.paragraphs
              .map((p) => p.runs.map((r) => r.text).join(""))
              .join("\n"),
          ),
        ).toEqual(CELLS);
      } finally {
        back.dispose();
      }
    });

    it("cells are saved back when another table was added to the story", async () => {
      const storyId = await story();
      const id = await tableId();
      const added = await h.host.document.mutate({
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
      expect(await h.objects.query(`story:${storyId} > table`)).toHaveLength(2);
      const ins = await h.host.document.mutate({
        op: "insertText",
        args: {
          storyId,
          offset: 0,
          text: "Red ",
          cell: { tableId: id, row: 1, col: 0 },
        },
      });
      expect(ins.applied).toBe(true);
      const back = await reimported();
      expect(back.cells[2]).toBe("Red Apples");
      expect(saveBackDiagnostics()).toEqual([]);
    });
  },
);
