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

// Doc ADR 608 amendment 1 on the headless host (the real engine): what
// engine ADRs 1018 and 1021 made possible — highlight, double underline,
// hidden text, shading, borders, Show ¶, Clear paragraph formatting, the
// multilevel list presets with Tab / Shift+Tab as `setListLevel` and
// Restart / Continue Numbering, the Styles menu (Update to Match, Modify,
// New Style, Apply Styles), the Word find keys naming the host's commands,
// and `host.text.find` / `replace` (Replace All one undo step).

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { CommandContribution } from "@paged-media/plugin-api";
import {
  createHeadlessHost,
  type HeadlessHost,
  silentConsole as silent,
} from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import { docBundle } from "../../src";
import { WORD_COMMAND, WORD_HOST_KEYS } from "../../src/word/commands";
import {
  docxPresent,
  ENGINE_ANCHOR,
  fixture,
  requireDocx,
} from "../conformance/harness";

requireDocx("doc headless — Word wave 1 UI");

// template-letter.docx as poured into docx_s0:
//   0 "Quarterly letter" 0..16 · 1 "Dear «Name»," 17..31 ·
//   2 "Thank you for your order." 32..57 · 3.. the list and the close.
const STORY = "docx_s0";
const DEAR = { storyId: STORY, start: 17, end: 21 };
const THANK = { storyId: STORY, start: 32, end: 37 };
const THANK_START = { storyId: STORY, start: 32, end: 32 };

describe.skipIf(!docxPresent)(
  "doc headless — Word wave 1 UI @feat:plugin-doc.edit-context",
  () => {
    let h: HeadlessHost;
    const opened: unknown[][] = [];
    const command = (id: string) =>
      (
        h.contributions.find((c) => c.kind === "command" && c.id === id)!
          .value as CommandContribution
      ).handler(null);
    const read = async (path: string) => {
      const props = await h.host.text.properties([path as never]);
      const r = props?.[path as never];
      return r === "mixed" ? "mixed" : (r?.value ?? null);
    };
    const run = async (
      name: keyof typeof WORD_COMMAND,
      sel: { storyId: string; start: number; end: number } = DEAR,
    ) => {
      h.setTextSelection(sel);
      return command(WORD_COMMAND[name]);
    };
    const storyText = async () => {
      const c = (await h.host.document.storyContent(STORY))!;
      return c.paragraphs.map((p) => p.runs.map((r) => r.text).join(""));
    };

    beforeAll(async () => {
      h = await createHeadlessHost({
        resolveFrom: ENGINE_ANCHOR,
        console: silent,
        shell: {
          openPanel: (...args: unknown[]) => void opened.push(args),
          closePanel: () => {},
          pickFile: async () => [],
        },
      });
      h.loadBundle(docBundle);
      const importer = h
        .importersContributed()
        .find((c) => c.id === "media.paged.doc.importer.docx")!;
      await h.newBlank(300, 300);
      await importer.import({
        name: "template-letter.docx",
        bytes: fixture("template-letter.docx"),
        mimeType: "",
        newDocument: true,
      });
    }, 60_000);
    afterAll(() => h?.dispose());

    it("binds the new keys and Word's find keys onto the host's commands", () => {
      const bound = h.contributions
        .filter((c) => c.kind === "keybinding")
        .map(
          (c) => c.value as { key: string; command: string; scope?: unknown },
        );
      covers(
        "keybinding:cmd+shift+d→media.paged.doc.command.word.doubleUnderline",
      );
      covers("keybinding:cmd+shift+h→media.paged.doc.command.word.hidden");
      covers("keybinding:cmd+f→paged.edit.find");
      covers("keybinding:cmd+h→paged.edit.replace");
      covers("keybinding:cmd+g→paged.edit.goTo");
      for (const k of [
        { key: "cmd+shift+d", command: WORD_COMMAND.doubleUnderline },
        { key: "cmd+shift+h", command: WORD_COMMAND.hidden },
        ...WORD_HOST_KEYS,
      ]) {
        expect(bound).toContainEqual(
          expect.objectContaining({
            key: k.key,
            command: k.command,
            scope: { editContext: "wordDocument" },
          }),
        );
      }
      expect(WORD_HOST_KEYS.map((k) => k.command)).toEqual([
        "paged.edit.replace",
        "paged.edit.goTo",
      ]);
    });

    it("character additions: double underline, hidden text, highlight", async () => {
      covers("command:media.paged.doc.command.word.doubleUnderline");
      await run("doubleUnderline");
      expect(await read("characterUnderlineType")).toBe("double");
      await run("doubleUnderline");
      expect(await read("characterUnderlineType")).not.toBe("double");
      covers("command:media.paged.doc.command.word.hidden");
      await run("hidden");
      expect(await read("characterHidden")).toBe(true);
      await run("hidden");
      expect(await read("characterHidden")).toBe(false);
      covers("command:media.paged.doc.command.word.highlight");
      await run("highlight");
      const swatch = await read("characterHighlightColor");
      expect(swatch).toBe("Color/word-highlight-yellow");
      await run("highlight");
      expect(await read("characterHighlightColor")).toBe("Swatch/None");
    });

    it("Show ¶ toggles the document's hidden text", async () => {
      covers("command:media.paged.doc.command.word.showHidden");
      const { readShowHidden } = await import("../../src/word/word-state");
      const before = await readShowHidden(h.host);
      await run("showHidden");
      expect(await readShowHidden(h.host)).toBe(!before);
      await run("showHidden");
      expect(await readShowHidden(h.host)).toBe(before);
    });

    it("paragraph additions: shading, borders, clear paragraph formatting", async () => {
      covers("command:media.paged.doc.command.word.shading");
      await run("shading", THANK);
      expect(await read("paragraphShadingOn")).toBe(true);
      expect(await read("paragraphShadingColor")).toBe("Color/Black");
      await run("shading", THANK);
      expect(await read("paragraphShadingOn")).toBe(false);
      covers("command:media.paged.doc.command.word.borderBottom");
      await run("borderBottom", THANK);
      expect(await read("paragraphRuleBelow")).toMatchObject({ on: true });
      covers("command:media.paged.doc.command.word.borderBox");
      await run("borderBox", THANK);
      expect(await read("paragraphBorderOn")).toBe(true);
      expect(await read("paragraphRuleBelow")).toMatchObject({ on: false });
      covers("command:media.paged.doc.command.word.borderNone");
      await run("borderNone", THANK);
      expect(await read("paragraphBorderOn")).toBe(false);
      covers("command:media.paged.doc.command.word.clearParagraph");
      await run("alignCenter", THANK);
      await run("increaseIndent", THANK);
      expect(await read("paragraphJustification")).toBe("CenterAlign");
      await run("clearParagraph", THANK);
      expect(await read("paragraphJustification")).not.toBe("CenterAlign");
      // The override is gone: the style's indent (none) shows through.
      expect((await read("paragraphLeftIndent")) ?? 0).toBe(0);
    });

    it("lists: presets, Tab / Shift+Tab as setListLevel, restart and continue", async () => {
      covers("command:media.paged.doc.command.word.listOutline");
      await run("listOutline", THANK);
      expect(await read("paragraphListType")).toBe("NumberedList");
      expect(await read("paragraphAppliedNumberingList")).toBe(
        "NumberingList/word-preset-outline",
      );
      const lists = (await h.host.document.collection(
        "numberingLists",
      )) as unknown as Array<{ selfId: string }>;
      expect(lists.map((l) => l.selfId)).toContain(
        "NumberingList/word-preset-outline",
      );
      covers("command:media.paged.doc.command.word.listLevelDown");
      await run("listLevelDown", THANK_START);
      expect(await read("paragraphNumberingLevel")).toBe(2);
      // One `setListLevel`, one undo step.
      await h.host.document.undo();
      // Back to no level of its own: level 1.
      expect((await read("paragraphNumberingLevel")) ?? 1).toBe(1);
      await run("listLevelDown", THANK_START);
      expect(await read("paragraphNumberingLevel")).toBe(2);
      covers("command:media.paged.doc.command.word.listLevelUp");
      await run("listLevelUp", THANK_START);
      expect(await read("paragraphNumberingLevel")).toBe(1);
      covers("command:media.paged.doc.command.word.restartNumbering");
      await run("restartNumbering", THANK);
      expect(await read("paragraphNumberingContinue")).toBe(false);
      covers("command:media.paged.doc.command.word.continueNumbering");
      await run("continueNumbering", THANK);
      expect(await read("paragraphNumberingContinue")).toBe(true);
      covers("command:media.paged.doc.command.word.listLegal");
      await run("listLegal", THANK);
      expect(await read("paragraphAppliedNumberingList")).toBe(
        "NumberingList/word-preset-legal",
      );
      covers("command:media.paged.doc.command.word.listBullets");
      await run("listBullets", THANK);
      expect(await read("paragraphListType")).toBe("BulletList");
      await run("bullets", THANK);
      expect(await read("paragraphListType")).toBe("NoList");
    });

    it("styles: update to match, modify, new style from selection, apply styles", async () => {
      await run("normal", THANK);
      await run("alignRight", THANK);
      covers("command:media.paged.doc.command.word.styleUpdate");
      await run("styleUpdate", THANK);
      const normal = (await h.host.document.styleProperties(
        "paragraph" as never,
        "ParagraphStyle/docx-Normal",
      )) as unknown as { entries?: Array<{ path: string; value: unknown }> };
      const just = normal?.entries?.find(
        (e) => e.path === "paragraphJustification",
      );
      expect(JSON.stringify(just?.value ?? null)).toContain("RightAlign");
      covers("command:media.paged.doc.command.word.styleModify");
      opened.length = 0;
      await run("styleModify", THANK);
      expect(opened).toEqual([
        [
          "paged.style-options",
          { target: "style:paragraph/ParagraphStyle/docx-Normal" },
        ],
      ]);
      covers("command:media.paged.doc.command.word.styleNew");
      opened.length = 0;
      await run("styleNew", THANK);
      const style = (await read("appliedParagraphStyle")) as string;
      const styles = (await h.host.document.collection(
        "paragraphStyles",
      )) as unknown as Array<{
        selfId: string;
        name: string;
        basedOn?: string;
      }>;
      const made = styles.find((s) => s.selfId === style)!;
      expect(made.name).toBe("Style 1");
      expect(made.basedOn).toBe("ParagraphStyle/docx-Normal");
      expect(opened[0]).toEqual([
        "paged.style-options",
        { target: `style:paragraph/${style}` },
      ]);
      covers("command:media.paged.doc.command.word.applyStyles");
      const r = (await run("applyStyles", THANK)) as { applied: boolean };
      expect(r.applied).toBe(true);
    });

    it("host.text.find and replace: hits in both offsets, Replace All one undo step", async () => {
      const found = await h.host.text.find({ find: "order" });
      expect(found.hits).toHaveLength(1);
      const [hit] = found.hits;
      expect(hit!.storyId).toBe(STORY);
      expect(hit!.text).toBe("order");
      const before = await storyText();
      const r = await h.host.text.replace({
        find: "e",
        replace: "E",
        all: true,
        matchCase: true,
      });
      expect(r.applied).toBe(true);
      expect(r.replaced).toBeGreaterThan(3);
      expect((await storyText()).join("\n")).not.toContain("e");
      await h.host.document.undo();
      expect(await storyText()).toEqual(before);
      const none = await h.host.text.replace({ find: "zzz", replace: "y" });
      expect(none.applied).toBe(false);
      expect(await storyText()).toEqual(before);
    });
  },
);
