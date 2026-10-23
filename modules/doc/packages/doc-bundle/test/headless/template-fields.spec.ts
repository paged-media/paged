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

// paged.doc's template field kinds (editor plan G3a) on the real headless
// host and the real docx-js wasm: an author makes the placed letter's frame
// a module field, the session takes the filler role, and the field is read
// and written through `host.objects` the way the editor's form and
// `paged-node template fill` do. The engine checks every write against the
// role: inside the field's frame it passes, anywhere else it is refused.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { BundleHost, TemplateFieldRef } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { DocEngine } from "../../src/engine";
import { docAddress } from "../../src/object-model";
import {
  BLOCK_TEXT_KIND,
  LIST_ITEMS_KIND,
  MERGE_FIELD_KIND,
} from "../../src/template-fields";
import {
  docxPresent,
  fixture,
  openDoc,
  requireDocx,
  storyTexts,
} from "../conformance/harness";

requireDocx("doc headless — template field kinds");

const LETTER = [
  "Quarterly letter",
  "Dear «Name»,",
  "Thank you for your order.",
  "Apples",
  "Pears",
  "Plums",
  "Kind regards",
];

describe.skipIf(!docxPresent)(
  "doc headless — template field kinds @feat:plugin-doc.object-model",
  () => {
    let h: HeadlessHost;
    let host: BundleHost;
    let story: string;
    const FRAME = "docx_f0";

    beforeEach(async () => {
      const o = await openDoc("template-letter.docx");
      h = o.h;
      host = o.host;
      story = o.opened.storyIds[0]!;
    }, 60_000);
    afterEach(() => h?.dispose());

    const send = (kind: string, payload: unknown) =>
      h.host.editor.client.send({ kind, payload } as never) as Promise<{
        kind: string;
        payload: Record<string, unknown>;
      }>;

    /** Make the letter's frame a module field (as the author) and take the
     *  filler role; answers the field as the template lists it. */
    async function template(
      kind: string,
      def: unknown,
      grants: string[] = ["text.edit"],
    ): Promise<TemplateFieldRef> {
      expect(
        (await send("setSessionPolicy", { policy: { role: "author" } })).kind,
      ).toBe("sessionPolicyApplied");
      const label = JSON.stringify({
        v: 1,
        data: {
          field: {
            name: "part",
            kind: "module",
            module: { kind, grants, def },
          },
        },
      });
      const set = await send("mutate", {
        op: "setPluginMetadata",
        args: {
          elementId: { kind: "textFrame", id: FRAME },
          key: "x-paged:template",
          value: label,
        },
      });
      expect(set.kind).toBe("mutationApplied");
      expect(
        (await send("setSessionPolicy", { policy: { role: "filler" } })).kind,
      ).toBe("sessionPolicyApplied");
      const rows = (await h.host.editor.client.collection(
        "templateFields" as never,
      )) as {
        field: { name: string; module?: { kind: string; def: unknown } };
        targetId: string;
      }[];
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      return {
        name: row.field.name,
        targetId: row.targetId,
        kind: row.field.module!.kind,
        def: row.field.module!.def,
      };
    }

    /** The paragraphs the .docx the label names holds now. */
    async function docxTexts(): Promise<string[]> {
      const part = (await h.objects.get(
        docAddress("docxDocument", FRAME),
        "content",
      )) as { value: Uint8Array };
      const engine = await DocEngine.boot();
      try {
        engine.loadDocx(part.value);
        return engine
          .lowered()
          .story.blocks.map((b) =>
            b.kind === "paragraph" ? b.runs.map((r) => r.text).join("") : "",
          );
      } finally {
        engine.dispose();
      }
    }

    it("the bundle lists its three kinds with their controls and grants", async () => {
      const kinds = (await h.objects.templateFieldKinds()).filter(
        (k) => k.owner === "media.paged.doc",
      );
      expect(kinds.map((k) => [k.kind, k.control.kind, k.grants])).toEqual([
        [BLOCK_TEXT_KIND, "text", ["text.edit"]],
        [MERGE_FIELD_KIND, "text", ["text.edit"]],
        [LIST_ITEMS_KIND, "table", ["text.edit"]],
      ]);
      expect(await storyTexts(host, story)).toEqual(LETTER);
    });

    it("blocks read their heading level, bookmarks and list items (what an anchor names)", async () => {
      const get = async (b: number, path: string) =>
        (
          (await h.objects.get(
            docAddress("block", `${FRAME}/b${b}`),
            path,
          )) as {
            value: unknown;
          }
        ).value;
      expect(await get(0, "headingLevel")).toBe(1);
      expect(await get(2, "headingLevel")).toBeNull();
      expect(await get(2, "bookmarks")).toEqual(["intro"]);
      expect(await get(6, "bookmarks")).toEqual(["closing"]);
      expect(await get(3, "listItems")).toEqual(["Apples", "Pears", "Plums"]);
      expect(await get(1, "listItems")).toBeNull();
      expect(
        await h.objects.query("plugin:media.paged.doc/block[headingLevel=1]"),
      ).toEqual([docAddress("block", `${FRAME}/b0`)]);
    });

    it("block.text is writable (G4): one undo step, a line break refused", async () => {
      const b0 = docAddress("block", `${FRAME}/b0`);
      expect(await h.objects.set(b0, "text", "Spring letter")).toMatchObject({
        applied: true,
        undoSteps: 1,
      });
      expect((await storyTexts(host, story))[0]).toBe("Spring letter");
      expect((await docxTexts())[0]).toBe("Spring letter");
      expect((await h.objects.set(b0, "text", "a\nb")).reason).toMatch(
        /cannot hold a line break/,
      );
      await host.document.undo();
      expect(await storyTexts(host, story)).toEqual(LETTER);
    });

    it("blockText by bookmark: a filler reads and writes the paragraph, one undo step, the first run's look kept", async () => {
      const field = await template(BLOCK_TEXT_KIND, {
        anchor: { bookmark: "intro" },
      });
      expect(field.targetId).toBe(FRAME);
      expect(await h.objects.readTemplateField(field)).toEqual({
        control: { kind: "text" },
        value: "Thank you for your order.",
      });
      expect(
        await h.objects.writeTemplateField(field, "We look forward to spring."),
      ).toEqual({ ok: true });
      expect((await storyTexts(host, story))[2]).toBe(
        "We look forward to spring.",
      );
      expect((await docxTexts())[2]).toBe("We look forward to spring.");
      expect((await h.objects.readTemplateField(field)).value).toBe(
        "We look forward to spring.",
      );
      await host.document.undo();
      expect(await storyTexts(host, story)).toEqual(LETTER);
    });

    it("blockText by style and occurrence; a refused value and a missing anchor say why", async () => {
      const field = await template(BLOCK_TEXT_KIND, {
        anchor: { style: "heading 1" },
      });
      expect((await h.objects.readTemplateField(field)).value).toBe(
        "Quarterly letter",
      );
      expect(
        await h.objects.writeTemplateField(field, "Spring letter"),
      ).toEqual({ ok: true });
      expect((await storyTexts(host, story))[0]).toBe("Spring letter");
      const refused = await h.objects.writeTemplateField(field, "Two\nlines");
      expect(refused.ok).toBe(false);
      expect(refused).toMatchObject({
        problem: expect.stringMatching(/cannot hold a line break\.$/),
      });
      const nowhere = { ...field, def: { anchor: { bookmark: "nope" } } };
      expect((await h.objects.readTemplateField(nowhere)).value).toBeNull();
      expect(await h.objects.writeTemplateField(nowhere, "x")).toEqual({
        ok: false,
        problem: "The Word document has no bookmark named “nope”.",
      });
      expect((await storyTexts(host, story))[0]).toBe("Spring letter");
    });

    it("blockText by heading level and occurrence", async () => {
      const field = await template(BLOCK_TEXT_KIND, {
        anchor: { heading: 1 },
      });
      expect((await h.objects.readTemplateField(field)).value).toBe(
        "Quarterly letter",
      );
      expect(
        await h.objects.writeTemplateField(field, "Summer letter"),
      ).toEqual({ ok: true });
      expect((await storyTexts(host, story))[0]).toBe("Summer letter");
      const second = {
        ...field,
        def: { anchor: { heading: 1, occurrence: 1 } },
      };
      expect(await h.objects.writeTemplateField(second, "x")).toEqual({
        ok: false,
        problem: "The Word document has no heading number 2 of level 1.",
      });
      const zero = { ...field, def: { anchor: { heading: 0 } } };
      expect(await h.objects.writeTemplateField(zero, "x")).toEqual({
        ok: false,
        problem: "The anchor's heading level is a whole number from 1.",
      });
    });

    it("mergeField: the value of every use of the name, written as Word merges it", async () => {
      const field = await template(MERGE_FIELD_KIND, { name: "Name" });
      expect((await h.objects.readTemplateField(field)).value).toBe("«Name»");
      expect(await h.objects.writeTemplateField(field, "Ada")).toEqual({
        ok: true,
      });
      expect((await storyTexts(host, story))[1]).toBe("Dear Ada,");
      expect((await docxTexts())[1]).toBe("Dear Ada,");
      expect(await h.objects.writeTemplateField(field, 3)).toEqual({
        ok: false,
        problem: "A merge field's value must be text.",
      });
    });

    it("listItems: fewer items remove paragraphs, more add items of the same list", async () => {
      const field = await template(LIST_ITEMS_KIND, {
        anchor: { block: 4 },
      });
      expect(await h.objects.readTemplateField(field)).toEqual({
        control: { kind: "table", columns: [{ name: "text", title: "Item" }] },
        value: [["Apples"], ["Pears"], ["Plums"]],
      });
      expect(
        await h.objects.writeTemplateField(field, [["Figs"], ["Dates"]]),
      ).toEqual({ ok: true });
      expect(await storyTexts(host, story)).toEqual([
        ...LETTER.slice(0, 3),
        "Figs",
        "Dates",
        "Kind regards",
      ]);
      expect(await docxTexts()).toEqual([
        ...LETTER.slice(0, 3),
        "Figs",
        "Dates",
        "Kind regards",
      ]);
      await host.document.undo();
      expect(await storyTexts(host, story)).toEqual(LETTER);

      expect(
        await h.objects.writeTemplateField(field, [
          ["Apples"],
          ["Pears"],
          ["Plums"],
          ["Cherries"],
          ["Quinces"],
        ]),
      ).toEqual({ ok: true });
      const grown = [
        ...LETTER.slice(0, 6),
        "Cherries",
        "Quinces",
        "Kind regards",
      ];
      expect(await storyTexts(host, story)).toEqual(grown);
      expect(await docxTexts()).toEqual(grown);
      expect((await h.objects.readTemplateField(field)).value).toEqual([
        ["Apples"],
        ["Pears"],
        ["Plums"],
        ["Cherries"],
        ["Quinces"],
      ]);
      // The added paragraphs are items of the list in the .docx too.
      const items = await h.objects.get(
        docAddress("block", `${FRAME}/b7`),
        "listItems",
      );
      expect(items).toMatchObject({
        value: expect.arrayContaining(["Quinces"]),
      });
      expect(await h.objects.writeTemplateField(field, [])).toEqual({
        ok: false,
        problem: "A list keeps at least one item.",
      });
    });

    it("a write outside the field's frame is refused for the filler", async () => {
      // A second letter placed by the author: no field on its frame.
      expect(
        (await send("setSessionPolicy", { policy: { role: "author" } })).kind,
      ).toBe("sessionPolicyApplied");
      const placed = (await h.objects.invoke(
        "media.paged.doc.command.placeDoc",
        { bytes: fixture("template-letter.docx"), fileName: "other.docx" },
      )) as { document: string };
      const other = placed.document.split("/").pop()!;
      const field = await template(BLOCK_TEXT_KIND, {
        anchor: { bookmark: "intro" },
      });
      // The same kind pointed at the other frame: the engine refuses.
      const elsewhere = {
        ...field,
        def: { ...(field.def as object), frame: other },
      };
      const out = await h.objects.writeTemplateField(elsewhere, "Not mine");
      expect(out.ok).toBe(false);
      expect(out).toEqual({
        ok: false,
        problem: expect.stringMatching(
          /^The template does not permit text\.edit on story \S+, which is outside this field\.$/,
        ),
      });
      // And through the object model directly.
      const direct = await h.objects.set(
        docAddress("block", `${other}/b2`),
        "text",
        "Not mine",
      );
      expect(direct.applied).toBe(false);
      // The field itself still writes.
      expect(await h.objects.writeTemplateField(field, "Mine")).toEqual({
        ok: true,
      });
    });
  },
);
