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

// Doc ADRs 611 / 612, editor ADR 301 — the structure commands' writes
// (word/structure.ts) over a recording host: each is one engine mutation at
// the caret; the header and footer band a double-click lands in resolves to
// its master's story; the bar's toggles rewrite the section's grow rule.

import { describe, expect, it } from "bun:test";

import type { BundleHost, SubContextState } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import { runWordCommand, WORD_COMMAND, WORD_KEYS } from "../src/word/commands";
import {
  bandLabel,
  DATE_FIELD,
  HEADER_BAR_COMMANDS,
  resolveHeaderFooter,
  sectionOfPage,
  type WordStructure,
} from "../src/word/structure";

type Op = { op: string; args: Record<string, unknown> };

const STRUCTURE = (): WordStructure => ({
  sections: [
    {
      storyId: "docx_s0",
      pageId: "docx_p0",
      master: "docx_m0",
      firstMaster: "docx_m1",
    },
    { storyId: "docx_s1", pageId: "docx_p1", master: "docx_m2" },
  ],
  masters: [
    {
      id: "docx_m0",
      name: "Section 1",
      pageSizePt: [360, 288],
      header: {
        storyId: "docx_m0_h",
        frameId: "docx_m0_hf",
        bounds: [21.6, 36, 54, 324],
      },
      footer: {
        storyId: "docx_m0_f",
        frameId: "docx_m0_ff",
        bounds: [234, 36, 266.4, 324],
      },
    },
    {
      id: "docx_m1",
      name: "Section 1 First Page",
      pageSizePt: [360, 288],
      header: {
        storyId: "docx_m1_h",
        frameId: "docx_m1_hf",
        bounds: [21.6, 36, 54, 324],
      },
    },
    {
      id: "docx_m2",
      name: "Section 2",
      pageSizePt: [360, 288],
      header: {
        storyId: "docx_m2_h",
        frameId: "docx_m2_hf",
        bounds: [21.6, 36, 54, 324],
      },
      footer: {
        storyId: "docx_m2_f",
        frameId: "docx_m2_ff",
        bounds: [234, 36, 266.4, 324],
      },
    },
  ],
  margins: { top: 54, bottom: 54 },
});

const PAGES = [
  { selfId: "docx_p0", sizePt: [360, 288], appliedMaster: "docx_m1" },
  { selfId: "g1", sizePt: [360, 288], appliedMaster: "docx_m0" },
  { selfId: "docx_p1", sizePt: [360, 288], appliedMaster: "docx_m2" },
];

function recordingHost(sub: SubContextState | null = null) {
  const mutations: Op[] = [];
  let fieldCodes = false;
  const host = {
    supports: () => true,
    text: {
      selection: () => ({ storyId: "docx_s0", start: 12, end: 12 }),
      async characterRange() {
        return { storyId: "docx_s0", start: 11, end: 11 };
      },
    },
    objects: {
      async get(_address: string, path: string) {
        if (path === "documentShowFieldCodes") return { value: fieldCodes };
        return null;
      },
    },
    shell: {
      subContext: () => sub,
      exitSubContext: () => true,
      enterSubContext: () => true,
    },
    viewport: { activePage: () => "g1" },
    document: {
      async collection(name: string) {
        if (name === "pages") return PAGES;
        if (name === "masterPages")
          return [{ selfId: "mp9", masterId: "docx_m3" }];
        return [
          { selfId: "ParagraphStyle/docx-Heading1", name: "heading 1" },
          { selfId: "ParagraphStyle/docx-Heading2", name: "heading 2" },
          { selfId: "ParagraphStyle/docx-Normal", name: "Normal" },
        ];
      },
      async mutate(m: Op) {
        mutations.push(m);
        if (m.op === "set") fieldCodes = !fieldCodes;
        return {
          applied: true,
          createdId: { kind: "textFrame", id: "u77" },
        };
      },
    },
    log: { warn() {}, info() {} },
  } as unknown as BundleHost;
  return { host, mutations };
}

describe("the structure commands write one mutation at the caret", () => {
  it("page and section breaks split the paragraph and start the new one over", async () => {
    covers("command:media.paged.doc.command.word.pageBreak");
    covers("command:media.paged.doc.command.word.sectionNextPage");
    covers("command:media.paged.doc.command.word.sectionOddPage");
    covers("command:media.paged.doc.command.word.sectionEvenPage");
    covers("command:media.paged.doc.command.word.sectionContinuous");
    for (const [name, rule] of [
      ["pageBreak", "NextPage"],
      ["sectionNextPage", "NextPage"],
      ["sectionOddPage", "NextOddPage"],
      ["sectionEvenPage", "NextEvenPage"],
      ["sectionContinuous", null],
    ] as const) {
      const { host, mutations } = recordingHost();
      await runWordCommand(host, name, { copied: null });
      const ops = (mutations[0]!.args.ops as Op[]) ?? [];
      expect(ops[0]).toEqual({
        op: "insertText",
        args: { storyId: "docx_s0", offset: 12, text: "\n", cell: null },
      });
      if (rule) {
        expect(ops[1]!.args).toMatchObject({
          path: "paragraphStartParagraph",
          value: { type: "text", value: rule },
          elementId: { id: { story_id: "docx_s0", start: 11, end: 11 } },
        });
      } else {
        expect(ops).toHaveLength(1);
      }
    }
  });

  it("Cmd+Alt+F and Cmd+Alt+D insert a footnote and an endnote", async () => {
    covers("command:media.paged.doc.command.word.footnote");
    covers("command:media.paged.doc.command.word.endnote");
    for (const name of ["footnote", "endnote"] as const) {
      const { host, mutations } = recordingHost();
      await runWordCommand(host, name, { copied: null });
      expect(mutations[0]).toEqual({
        op: name === "footnote" ? "insertFootnote" : "insertEndnote",
        args: { storyId: "docx_s0", offset: 11, text: "" },
      });
    }
  });

  it("F9 updates the story's fields with the host's clock; Shift+F9 toggles codes", async () => {
    covers("command:media.paged.doc.command.word.updateFields");
    covers("command:media.paged.doc.command.word.toggleFieldCodes");
    const { host, mutations } = recordingHost();
    await runWordCommand(host, "updateFields", { copied: null });
    expect(mutations[0]!.op).toBe("updateFields");
    expect(mutations[0]!.args.storyId).toBe("docx_s0");
    expect(typeof mutations[0]!.args.now).toBe("string");
    await runWordCommand(host, "toggleFieldCodes", { copied: null });
    await runWordCommand(host, "toggleFieldCodes", { copied: null });
    expect(mutations.slice(1).map((m) => m.args.value)).toEqual([
      { type: "bool", value: true },
      { type: "bool", value: false },
    ]);
  });

  it("fields go in at the caret, a date with the clock", async () => {
    covers("command:media.paged.doc.command.word.insertPageNumber");
    covers("command:media.paged.doc.command.word.insertPageCount");
    covers("command:media.paged.doc.command.word.insertDate");
    for (const [name, code] of [
      ["insertPageNumber", "PAGE"],
      ["insertPageCount", "NUMPAGES"],
      ["insertDate", DATE_FIELD],
    ] as const) {
      const { host, mutations } = recordingHost();
      await runWordCommand(host, name, { copied: null });
      expect(mutations[0]).toEqual({
        op: "insertField",
        args: {
          storyId: "docx_s0",
          offset: 0,
          contentOffset: 12,
          field: { word: { code } },
        },
      });
      expect(mutations.length).toBe(name === "insertDate" ? 2 : 1);
    }
  });

  it("the table of contents lists the document's heading styles", async () => {
    covers("command:media.paged.doc.command.word.insertToc");
    covers("command:media.paged.doc.command.word.updateToc");
    const { host, mutations } = recordingHost();
    await runWordCommand(host, "insertToc", { copied: null });
    expect(mutations[0]!.op).toBe("insertTableOfContents");
    expect(mutations[0]!.args.levels).toEqual([
      { style: "ParagraphStyle/docx-Heading1", level: 1 },
      { style: "ParagraphStyle/docx-Heading2", level: 2 },
    ]);
    await runWordCommand(host, "updateToc", { copied: null });
    expect(mutations[1]).toEqual({
      op: "updateTableOfContents",
      args: { storyId: "docx_s0" },
    });
  });

  it("Word's dialogs open their section of the References panel", async () => {
    covers("command:media.paged.doc.command.word.crossReference");
    covers("command:media.paged.doc.command.word.field");
    covers("command:media.paged.doc.command.word.bookmark");
    covers("command:media.paged.doc.command.word.indexEntry");
    covers("command:media.paged.doc.command.word.pageSetup");
    for (const name of [
      "crossReference",
      "field",
      "bookmark",
      "indexEntry",
      "pageSetup",
    ] as const) {
      const opened: unknown[] = [];
      const { host } = recordingHost();
      (host.shell as unknown as { openPanel: unknown }).openPanel = (
        ...a: unknown[]
      ) => void opened.push(a);
      await runWordCommand(host, name, { copied: null });
      expect(opened).toEqual([
        ["media.paged.doc.panel.references", { target: name }],
      ]);
    }
  });

  it("the structure keys are Word's", () => {
    const key = (k: string) => WORD_KEYS.find((x) => x.key === k)?.command;
    expect(key("cmd+enter")).toBe(WORD_COMMAND.pageBreak);
    expect(key("cmd+alt+f")).toBe(WORD_COMMAND.footnote);
    expect(key("cmd+alt+d")).toBe(WORD_COMMAND.endnote);
    expect(key("f9")).toBe(WORD_COMMAND.updateFields);
    expect(key("shift+f9")).toBe(WORD_COMMAND.toggleFieldCodes);
    expect(key("alt+f9")).toBe(WORD_COMMAND.toggleFieldCodes);
  });
});

describe("headers and footers are edited in place (editor ADR 301)", () => {
  const bar = HEADER_BAR_COMMANDS.map((n) => WORD_COMMAND[n]);

  it("a double-click in a page's header band enters its master's header story", async () => {
    const { host } = recordingHost();
    const spec = await resolveHeaderFooter(
      host,
      STRUCTURE(),
      { editContext: "wordDocument", pageId: "docx_p0", pagePoint: [100, 30] },
      bar,
    );
    expect(spec).toEqual({
      kind: "header",
      pageId: "docx_p0",
      storyId: "docx_m1_h",
      frameId: "docx_m1_hf",
      masterId: "docx_m1",
      bounds: [21.6, 36, 54, 324],
      label: "First Page Header -Section 1-",
      commands: bar,
    });
  });

  it("the footer band of a later page names its section; the body is not a band", async () => {
    const { host } = recordingHost();
    const s = STRUCTURE();
    const footer = await resolveHeaderFooter(
      host,
      s,
      { editContext: "wordDocument", pageId: "docx_p1", pagePoint: [100, 250] },
      bar,
    );
    expect(footer?.storyId).toBe("docx_m2_f");
    expect(footer?.label).toBe("Footer -Section 2-");
    const body = await resolveHeaderFooter(
      host,
      s,
      { editContext: "wordDocument", pageId: "g1", pagePoint: [100, 140] },
      bar,
    );
    expect(body).toBeNull();
    // The first page's master has no footer: nothing to enter.
    const none = await resolveHeaderFooter(
      host,
      s,
      { editContext: "wordDocument", pageId: "docx_p0", pagePoint: [100, 260] },
      bar,
    );
    expect(none).toBeNull();
    expect(
      await resolveHeaderFooter(
        host,
        null,
        { editContext: "wordDocument", pageId: "g1", pagePoint: [1, 1] },
        bar,
      ),
    ).toBeNull();
  });

  it("pages belong to the section whose story opens at or before them", () => {
    const ids = PAGES.map((p) => p.selfId);
    expect(ids.map((id) => sectionOfPage(STRUCTURE(), ids, id))).toEqual([
      0, 0, 1,
    ]);
    expect(bandLabel("footer", "even", 2)).toBe("Even Page Footer -Section 3-");
  });

  it("Different first page off and on rewrites the section's grow rule", async () => {
    covers("command:media.paged.doc.command.word.differentFirstPage");
    const s = STRUCTURE();
    const sub = {
      kind: "header",
      pageId: "g1",
      storyId: "docx_m0_h",
      bounds: [0, 0, 1, 1],
      pluginId: "media.paged.doc",
    } as SubContextState;
    const { host, mutations } = recordingHost(sub);
    const state = { copied: null, structure: () => s };
    await runWordCommand(host, "differentFirstPage", state);
    expect(mutations.at(-1)!.args).toEqual({
      storyId: "docx_s0",
      grow: true,
      maxPages: null,
      copyFrameOptions: true,
      master: "docx_m0",
    });
    // On again: a new blank first-page master with a header and a footer
    // frame where the section's master has them.
    await runWordCommand(host, "differentFirstPage", state);
    const ops = mutations.map((m) => m.op);
    expect(ops).toContain("onMaster");
    expect(mutations.at(-1)!.args.firstMaster).toBe("docx_m3");
    expect(s.masters.at(-1)!.header?.frameId).toBe("u77");
  });

  it("Link to previous gives the section the previous section's masters", async () => {
    covers("command:media.paged.doc.command.word.linkToPrevious");
    covers("command:media.paged.doc.command.word.differentOddEven");
    const s = STRUCTURE();
    const sub = {
      kind: "header",
      pageId: "docx_p1",
      storyId: "docx_m2_h",
      bounds: [0, 0, 1, 1],
      pluginId: "media.paged.doc",
    } as SubContextState;
    const { host, mutations } = recordingHost(sub);
    const state = { copied: null, structure: () => s };
    await runWordCommand(host, "linkToPrevious", state);
    expect(mutations.at(-1)!.args).toMatchObject({
      storyId: "docx_s1",
      master: "docx_m0",
    });
    await runWordCommand(host, "differentOddEven", state);
    const batch = mutations.at(-1)!.args.ops as Op[];
    expect(batch.map((o) => o.args.storyId)).toEqual(["docx_s0", "docx_s1"]);
    // Linked sections share one even master.
    expect(batch[0]!.args.evenMaster).toBe(batch[1]!.args.evenMaster);
  });

  it("the bar's commands edit, insert into and close the header", async () => {
    covers("command:media.paged.doc.command.word.editHeader");
    covers("command:media.paged.doc.command.word.editFooter");
    covers("command:media.paged.doc.command.word.closeHeaderFooter");
    const s = STRUCTURE();
    const { host } = recordingHost();
    const state = { copied: null, structure: () => s };
    expect(await runWordCommand(host, "editHeader", state)).toEqual({
      applied: true,
    });
    expect(await runWordCommand(host, "editFooter", state)).toEqual({
      applied: true,
    });
    expect(await runWordCommand(host, "closeHeaderFooter", state)).toEqual({
      applied: true,
    });
  });
});
