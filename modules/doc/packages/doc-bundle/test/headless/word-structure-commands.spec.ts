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

// Doc ADRs 611 / 612 and editor ADR 301 on the real engine: the Word
// structure commands, run as the shortcuts run them, on `structure.docx`
// opened through the importer — and a double-click in a page's header band
// entering its master's story (contract C6).

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { CommandContribution } from "@paged-media/plugin-api";
import {
  createHeadlessHost,
  type HeadlessHost,
  silentConsole as silent,
} from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import { docBundle } from "../../src";
import { WORD_COMMAND } from "../../src/word/commands";
import { referencesActions } from "../../src/word/references";
import {
  docxPresent,
  ENGINE_ANCHOR,
  fixture,
  requireDocx,
} from "../conformance/harness";

requireDocx("doc headless — Word structure commands");

const STORY = "docx_s0";

describe.skipIf(!docxPresent)(
  "doc headless — Word structure commands @feat:doc-word-fields",
  () => {
    let h: HeadlessHost;
    const command = (id: string) =>
      (
        h.contributions.find((c) => c.kind === "command" && c.id === id)!
          .value as CommandContribution
      ).handler(null);
    const at = async (text: string) => {
      const found = await h.host.text.find({ find: text, storyId: STORY });
      const hit = found.hits[0]!;
      return { storyId: STORY, start: hit.start, end: hit.start };
    };
    const run = async (
      name: keyof typeof WORD_COMMAND,
      sel: { storyId: string; start: number; end: number },
    ) => {
      h.setTextSelection(sel);
      return command(WORD_COMMAND[name]);
    };
    const codes = async (storyId = STORY) => {
      const c = (await h.host.document.storyContent(storyId)) as unknown as {
        paragraphs: Array<{ runs: Array<{ fieldCode?: string }> }>;
      };
      return c.paragraphs.flatMap((p) =>
        p.runs.flatMap((r) => (r.fieldCode ? [r.fieldCode] : [])),
      );
    };

    beforeAll(async () => {
      h = await createHeadlessHost({
        resolveFrom: ENGINE_ANCHOR,
        console: silent,
      });
      h.loadBundle(docBundle);
      const importer = h
        .importersContributed()
        .find((c) => c.id === "media.paged.doc.importer.docx")!;
      await h.newBlank(300, 300);
      await importer.import({
        name: "structure.docx",
        bytes: fixture("structure.docx"),
        mimeType: "",
        newDocument: true,
      });
    }, 60_000);
    afterAll(() => h?.dispose());

    it("a double-click in the header band enters the page's master header", async () => {
      expect(h.host.supports("shell.subContext@1")).toBe(true);
      await h.doubleClickPage("docx_p0", [100, 30]);
      const sub = h.subContext();
      expect(sub?.kind).toBe("header");
      expect(sub?.label).toBe("First Page Header -Section 1-");
      expect(sub?.commands).toContain(WORD_COMMAND.differentFirstPage);
      // Typing into the header edits the master story.
      const r = await h.host.document.mutate({
        op: "insertText",
        args: { storyId: sub!.storyId, offset: 0, text: "Draft ", cell: null },
      });
      expect(r.applied).toBe(true);
      const c = await h.host.document.storyContent(sub!.storyId);
      expect(c!.paragraphs[0]!.runs.map((x) => x.text).join("")).toBe(
        "Draft Title page header",
      );
      h.exitSubContext();
      expect(h.subContext()).toBeNull();
      // The body is not a band.
      await h.doubleClickPage("docx_p0", [100, 140]);
      expect(h.subContext()).toBeNull();
    });

    it("inserts a page number, a page count and a date at the caret", async () => {
      covers("command:media.paged.doc.command.word.insertPageNumber");
      const before = await codes();
      await run("insertPageNumber", await at("Body text"));
      await run("insertPageCount", await at("Body text"));
      await run("insertDate", await at("Body text"));
      const after = await codes();
      expect(after.length).toBe(before.length + 3);
      expect(after).toContain("PAGE");
      expect(after).toContain("NUMPAGES");
      expect(after.some((c) => c.startsWith("DATE"))).toBe(true);
    });

    it("Cmd+Alt+F puts a footnote at the caret", async () => {
      const notes = () => h.host.document.collection("footnotes");
      const n = (await notes()).length;
      await run("footnote", await at("A closing"));
      expect((await notes()).length).toBe(n + 1);
    });

    it("F9 updates the fields and Shift+F9 shows their codes", async () => {
      // The fields already show the layout's values: F9 writes what
      // changed, and with nothing to change the engine refuses, as Word
      // does nothing.
      const r = (await run(
        "updateFields",
        await at("Body text"),
      )) as unknown as { applied: boolean; error?: string } | undefined;
      expect(
        r === undefined ||
          r.applied ||
          /already shows its result/.test(r.error ?? ""),
      ).toBe(true);
      await run("toggleFieldCodes", await at("Body text"));
      expect(
        await h.objects.get("doc", "documentShowFieldCodes"),
      ).toMatchObject({ value: true });
      await run("toggleFieldCodes", await at("Body text"));
      expect(
        await h.objects.get("doc", "documentShowFieldCodes"),
      ).toMatchObject({ value: false });
    });

    it("a table of contents is built from the heading styles", async () => {
      const paras = async () =>
        (await h.host.document.storyContent(STORY))!.paragraphs.length;
      const n = await paras();
      await run("insertToc", await at("A closing"));
      expect(await paras()).toBeGreaterThan(n);
    });

    it("a page break starts the text after the caret on a new page", async () => {
      const paras = async () =>
        (await h.host.document.storyContent(STORY))!.paragraphs.length;
      const n = await paras();
      await run("pageBreak", await at("on page"));
      expect(await paras()).toBe(n + 1);
    });

    it("the References panel's bookmark, cross-reference, index entry and page setup", async () => {
      const refs = referencesActions(h.host, async () => [STORY, "docx_s1"]);
      h.setTextSelection(await at("A closing"));
      expect(await refs.insertBookmark("Closing")).toBe(true);
      const targets = await refs.targets();
      expect(targets.map((x) => x.label)).toContain("Closing");
      expect(targets.map((x) => x.label)).toContain("Background");
      const heading = targets.find((x) => x.label === "Background")!;
      h.setTextSelection(await at("A closing"));
      expect(
        await refs.insertCrossReference(heading.target, "pageNumber"),
      ).toBe(true);
      expect((await codes()).some((c) => c.startsWith("PAGEREF"))).toBe(true);
      h.setTextSelection(await at("A closing"));
      expect(await refs.insertIndexEntry(["Remarks", "Closing"])).toBe(true);
      h.setTextSelection(await at("A closing"));
      const setup = (await refs.pageSetup())!;
      expect(Math.round(setup.widthPt)).toBe(360);
      expect(
        await refs.applyPageSetup({
          ...setup,
          widthPt: setup.heightPt,
          heightPt: setup.widthPt,
          marginLeftPt: 36,
        }),
      ).toBe(true);
      const after = (await refs.pageSetup())!;
      expect(Math.round(after.widthPt)).toBe(288);
      expect(after.marginLeftPt).toBe(36);
    });
  },
);
