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

// Table cells through the object model and the template field kinds (editor
// plan G4) on the real headless host and the real docx-js wasm: a cell's
// runs, paragraphs and merge fields are written like the body's — the .docx,
// the poured cell text and the label in one undo step — and a cell edited on
// the canvas since is refused, not written over.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { BundleHost, TemplateFieldRef } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { DocEngine } from "../../src/engine";
import { docAddress } from "../../src/object-model";
import { BLOCK_TEXT_KIND, MERGE_FIELD_KIND } from "../../src/template-fields";
import {
  docxPresent,
  openDoc,
  requireDocx,
  storyTexts,
} from "../conformance/harness";

requireDocx("doc headless — table cells");

// price-table.docx: a heading, a 3 x 2 table, a body paragraph after it.
// The lowered cells, in order: Item | Price / App+les (bookmark
// "first-item") | 1.20 (style Price) / "Line one" + "Line two" |
// "For " + «Name».
const FRAME = "docx_f0";
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
  "doc headless — table cells @feat:plugin-doc.object-model",
  () => {
    let h: HeadlessHost;
    let host: BundleHost;
    let story: string;

    beforeEach(async () => {
      const o = await openDoc("price-table.docx");
      h = o.h;
      host = o.host;
      story = o.opened.storyIds[0]!;
    }, 60_000);
    afterEach(() => h?.dispose());

    const value = async (address: string, path: string) =>
      ((await h.objects.get(address, path)) as { value: unknown }).value;

    /** The poured cells' text, as the engine holds it, in lowered order. */
    async function liveCells(): Promise<string[]> {
      const [table] = await h.objects.query(`story:${story} > table`);
      const id = table!.replace(/^table:/, "");
      const out: string[] = [];
      for (const [row, col] of [
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
        [2, 0],
        [2, 1],
      ])
        out.push((await value(`cell:${id}/${row},${col}`, "text")) as string);
      return out;
    }

    /** The cells' text in the .docx the label names now. */
    async function docxCells(): Promise<string[]> {
      const part = (await h.objects.get(
        docAddress("docxDocument", FRAME),
        "content",
      )) as { value: Uint8Array };
      const engine = await DocEngine.boot();
      try {
        engine.loadDocx(part.value);
        const t = engine.lowered().story.blocks[1]!;
        if (t.kind !== "table") throw new Error("block 1 is the table");
        return t.cells.map((c) =>
          c.paragraphs
            .map((p) => p.runs.map((r) => r.text).join(""))
            .join("\n"),
        );
      } finally {
        engine.dispose();
      }
    }

    it("a table's cell paragraphs are blocks, listed within the table", async () => {
      expect(await storyTexts(host, story)).toEqual(BODY);
      expect(await liveCells()).toEqual(CELLS);
      const table = docAddress("block", `${FRAME}/b1`);
      const inside = await h.objects.query(
        `${table} plugin:media.paged.doc/block`,
      );
      expect(inside).toEqual(
        ["c0/p0", "c1/p0", "c2/p0", "c3/p0", "c4/p0", "c4/p1", "c5/p0"].map(
          (c) => docAddress("block", `${FRAME}/b1/${c}`),
        ),
      );
      const apples = docAddress("block", `${FRAME}/b1/c2/p0`);
      expect(await value(apples, "kind")).toBe("paragraph");
      expect(await value(apples, "index")).toBe(1);
      expect(await value(apples, "text")).toBe("Apples");
      expect(await value(apples, "bookmarks")).toEqual(["first-item"]);
      expect(await value(apples, "runCount")).toBe(2);
      expect(
        await value(docAddress("block", `${FRAME}/b1/c3/p0`), "paragraphStyle"),
      ).toBe("ParagraphStyle/docx-Price");
      expect(
        await value(docAddress("run", `${FRAME}/b1/c2/p0/r1`), "block"),
      ).toBe(apples);
      expect(
        await value(
          docAddress("mergeField", `${FRAME}/b1/c5/p0/f0`),
          "writable",
        ),
      ).toBe(true);
    });

    it("run.text and block.text in a cell: the .docx and the poured cell in one undo step", async () => {
      const out = await h.objects.batch([
        {
          op: "set",
          address: docAddress("block", `${FRAME}/b1/c2/p0`),
          path: "text",
          value: "Pears",
        },
        {
          op: "set",
          address: docAddress("run", `${FRAME}/b1/c4/p1/r0`),
          path: "text",
          value: "Grüße zwei",
        },
      ]);
      expect(out).toMatchObject({ applied: true, undoSteps: 1 });
      const after = [...CELLS];
      after[2] = "Pears";
      after[4] = "Line one\nGrüße zwei";
      expect(await liveCells()).toEqual(after);
      expect(await docxCells()).toEqual(after);
      expect(
        await value(docAddress("block", `${FRAME}/b1/c2/p0`), "bookmarks"),
      ).toEqual(["first-item"]);
      // The body around the table is untouched.
      expect(await storyTexts(host, story)).toEqual(BODY);
      await host.document.undo();
      expect(await liveCells()).toEqual(CELLS);
      expect(await docxCells()).toEqual(CELLS);
    });

    it("the paragraph after a table continues in the table's host paragraph", async () => {
      const b2 = docAddress("block", `${FRAME}/b2`);
      expect(await h.objects.set(b2, "text", "Hello")).toMatchObject({
        applied: true,
      });
      expect(await storyTexts(host, story)).toEqual([
        "Price list",
        "Hello",
        "Kind regards",
      ]);
      expect(await liveCells()).toEqual(CELLS);
    });

    it("a cell edited on the canvas since is refused, not written over", async () => {
      const [table] = await h.objects.query(`story:${story} > table`);
      const typed = await host.document.mutate({
        op: "insertText",
        args: {
          storyId: story,
          offset: 0,
          text: "Fresh ",
          cell: { tableId: table!.replace(/^table:/, ""), row: 1, col: 0 },
        },
      });
      expect(typed.applied).toBe(true);
      const out = await h.objects.set(
        docAddress("block", `${FRAME}/b1/c2/p0`),
        "text",
        "Pears",
      );
      expect(out.applied).toBe(false);
      expect(out.reason).toMatch(/was edited on the canvas/);
      expect((await liveCells())[2]).toBe("Fresh Apples");
      expect((await docxCells())[2]).toBe("Apples");
    });

    it("fillMergeFields fills a merge field in a cell and in the body", async () => {
      const out = (await h.objects.invoke(
        "media.paged.doc.command.fillMergeFields",
        {
          document: docAddress("docxDocument", FRAME),
          values: { Name: "Ada" },
        },
      )) as { filled: number };
      expect(out.filled).toBe(2);
      expect((await liveCells())[5]).toBe("For Ada");
      expect((await docxCells())[5]).toBe("For Ada");
      expect((await storyTexts(host, story))[1]).toBe("Dear Ada");
    });

    describe("template fields in a cell", () => {
      const send = (kind: string, payload: unknown) =>
        h.host.editor.client.send({ kind, payload } as never) as Promise<{
          kind: string;
        }>;

      /** The table's frame as a module field, the session as its filler. */
      async function template(
        kind: string,
        def: unknown,
      ): Promise<TemplateFieldRef> {
        await send("setSessionPolicy", { policy: { role: "author" } });
        const set = await send("mutate", {
          op: "setPluginMetadata",
          args: {
            elementId: { kind: "textFrame", id: FRAME },
            key: "x-paged:template",
            value: JSON.stringify({
              v: 1,
              data: {
                field: {
                  name: "part",
                  kind: "module",
                  module: { kind, grants: ["text.edit"], def },
                },
              },
            }),
          },
        });
        expect(set.kind).toBe("mutationApplied");
        await send("setSessionPolicy", { policy: { role: "filler" } });
        return { name: "part", targetId: FRAME, kind, def };
      }

      it("blockText by a bookmark in a cell", async () => {
        const field = await template(BLOCK_TEXT_KIND, {
          anchor: { bookmark: "first-item" },
        });
        expect((await h.objects.readTemplateField(field)).value).toBe("Apples");
        expect(await h.objects.writeTemplateField(field, "Quinces")).toEqual({
          ok: true,
        });
        expect((await liveCells())[2]).toBe("Quinces");
        expect((await docxCells())[2]).toBe("Quinces");
        await host.document.undo();
        expect(await liveCells()).toEqual(CELLS);
      });

      it("blockText by a style in a cell, and by block, cell and paragraph", async () => {
        const price = await template(BLOCK_TEXT_KIND, {
          anchor: { style: "Price" },
        });
        expect((await h.objects.readTemplateField(price)).value).toBe("1.20");
        expect(await h.objects.writeTemplateField(price, "2.40")).toEqual({
          ok: true,
        });
        expect((await liveCells())[3]).toBe("2.40");
        const second = await template(BLOCK_TEXT_KIND, {
          anchor: { block: 1, cell: 4, paragraph: 1 },
        });
        expect(await h.objects.writeTemplateField(second, "Line 2")).toEqual({
          ok: true,
        });
        expect((await liveCells())[4]).toBe("Line one\nLine 2");
        expect((await docxCells())[3]).toBe("2.40");
        const nowhere = await template(BLOCK_TEXT_KIND, {
          anchor: { block: 1, cell: 9, paragraph: 0 },
        });
        expect(await h.objects.writeTemplateField(nowhere, "x")).toEqual({
          ok: false,
          problem:
            "The Word document's block 1 is no table with a cell 9 that has a paragraph 0.",
        });
      });

      it("mergeField writes every use of the name, the cell's included", async () => {
        const field = await template(MERGE_FIELD_KIND, { name: "Name" });
        expect(await h.objects.writeTemplateField(field, "Grace")).toEqual({
          ok: true,
        });
        expect((await liveCells())[5]).toBe("For Grace");
        expect((await docxCells())[5]).toBe("For Grace");
        expect((await storyTexts(host, story))[1]).toBe("Dear Grace");
        await host.document.undo();
        expect((await liveCells())[5]).toBe("For «Name»");
        expect((await storyTexts(host, story))[1]).toBe("Dear «Name»");
      });
    });
  },
);
