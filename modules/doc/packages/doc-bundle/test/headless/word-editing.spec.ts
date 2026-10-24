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

// Doc ADR 608 — Word inside paged on the headless host (the real engine):
// a .docx opened as the document holds the wordDocument document context,
// the Home group, the shortcuts and the status items are contributed in
// it, and every Word command formats the selection through host.text —
// read back from the engine as the effective value the text is set with.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { CommandContribution } from "@paged-media/plugin-api";
import {
  createHeadlessHost,
  type HeadlessHost,
  silentConsole as silent,
} from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import { docBundle } from "../../src";
import { WORD_COMMAND, WORD_KEYS } from "../../src/word/commands";
import {
  docxPresent,
  ENGINE_ANCHOR,
  fixture,
  requireDocx,
} from "../conformance/harness";

requireDocx("doc headless — Word editing");

// template-letter.docx, as the lowering pours it into story docx_s0:
//   0 "Quarterly letter"  (heading 1)     content 0..16
//   1 "Dear «Name»,"      (« » two bytes)  content 17..31
//   2 "Thank you for your order."          content 32..57
const STORY = "docx_s0";
const DEAR = { storyId: STORY, start: 17, end: 21 };
const THANK = { storyId: STORY, start: 32, end: 37 };

describe.skipIf(!docxPresent)(
  "doc headless — Word editing @feat:plugin-doc.edit-context",
  () => {
    let h: HeadlessHost;
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
      await command(WORD_COMMAND[name]);
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
        name: "template-letter.docx",
        bytes: fixture("template-letter.docx"),
        mimeType: "",
        newDocument: true,
      });
    }, 60_000);
    afterAll(() => h?.dispose());

    it("holds the document context and contributes the chrome in it", () => {
      expect(h.documentContext()).toEqual({
        pluginId: "media.paged.doc",
        type: "wordDocument",
      });
      expect(h.controlBarGroupsContributed().map((g) => g.id)).toEqual([
        "media.paged.doc.controlBar.home",
      ]);
      expect(h.statusItemsContributed().map((s) => s.id)).toEqual([
        "media.paged.doc.status.page",
        "media.paged.doc.status.words",
        "media.paged.doc.status.zoom",
      ]);
    });

    it("binds every shortcut scoped to the wordDocument context", () => {
      const bound = h.contributions
        .filter((c) => c.kind === "keybinding")
        .map(
          (c) => c.value as { key: string; command: string; scope?: unknown },
        );
      covers("keybinding:cmd+b→media.paged.doc.command.word.bold");
      covers("keybinding:cmd+i→media.paged.doc.command.word.italic");
      covers("keybinding:cmd+u→media.paged.doc.command.word.underline");
      covers("keybinding:cmd+=→media.paged.doc.command.word.subscript");
      covers("keybinding:cmd+shift+a→media.paged.doc.command.word.allCaps");
      covers("keybinding:cmd+shift+k→media.paged.doc.command.word.smallCaps");
      covers(
        "keybinding:cmd+space→media.paged.doc.command.word.clearCharacter",
      );
      covers("keybinding:cmd+shift+>→media.paged.doc.command.word.growFont");
      covers("keybinding:cmd+shift+<→media.paged.doc.command.word.shrinkFont");
      covers("keybinding:cmd+l→media.paged.doc.command.word.alignLeft");
      covers("keybinding:cmd+e→media.paged.doc.command.word.alignCenter");
      covers("keybinding:cmd+r→media.paged.doc.command.word.alignRight");
      covers("keybinding:cmd+j→media.paged.doc.command.word.justify");
      covers("keybinding:cmd+0→media.paged.doc.command.word.spaceBefore");
      covers(
        "keybinding:ctrl+shift+m→media.paged.doc.command.word.increaseIndent",
      );
      covers(
        "keybinding:cmd+shift+m→media.paged.doc.command.word.decreaseIndent",
      );
      covers("keybinding:cmd+alt+1→media.paged.doc.command.word.heading1");
      covers("keybinding:cmd+alt+2→media.paged.doc.command.word.heading2");
      covers("keybinding:cmd+alt+3→media.paged.doc.command.word.heading3");
      covers("keybinding:cmd+shift+l→media.paged.doc.command.word.bullets");
      covers("keybinding:tab→media.paged.doc.command.word.listLevelDown");
      covers("keybinding:shift+tab→media.paged.doc.command.word.listLevelUp");
      covers("keybinding:cmd+alt+c→media.paged.doc.command.word.copyFormat");
      covers("keybinding:cmd+alt+v→media.paged.doc.command.word.pasteFormat");
      expect(WORD_KEYS).toHaveLength(24);
      for (const k of WORD_KEYS) {
        expect(bound).toContainEqual(
          expect.objectContaining({
            key: k.key,
            command: k.command,
            scope: { editContext: "wordDocument" },
          }),
        );
      }
    });

    it("character commands toggle the selection's effective format", async () => {
      covers("command:media.paged.doc.command.word.bold");
      await run("bold");
      expect(await read("characterFontStyle")).toBe("Bold");
      covers("command:media.paged.doc.command.word.italic");
      await run("italic");
      expect(await read("characterFontStyle")).toBe("Bold Italic");
      await run("bold");
      expect(await read("characterFontStyle")).toBe("Italic");
      covers("command:media.paged.doc.command.word.underline");
      await run("underline");
      expect(await read("characterUnderline")).toBe(true);
      covers("command:media.paged.doc.command.word.strikethrough");
      await run("strikethrough");
      expect(await read("characterStrikethru")).toBe(true);
      covers("command:media.paged.doc.command.word.subscript");
      await run("subscript");
      expect(await read("characterPosition")).toBe("Subscript");
      covers("command:media.paged.doc.command.word.superscript");
      await run("superscript");
      expect(await read("characterPosition")).toBe("Superscript");
      covers("command:media.paged.doc.command.word.allCaps");
      await run("allCaps");
      expect(await read("characterCase")).toBe("AllCaps");
      covers("command:media.paged.doc.command.word.smallCaps");
      await run("smallCaps");
      expect(await read("characterCase")).toBe("SmallCaps");
      covers("command:media.paged.doc.command.word.growFont");
      const size = (await read("characterFontSize")) as number;
      await run("growFont");
      expect(await read("characterFontSize")).toBeGreaterThan(size);
      covers("command:media.paged.doc.command.word.shrinkFont");
      await run("shrinkFont");
      expect(await read("characterFontSize")).toBe(size);
      covers("command:media.paged.doc.command.word.clearCharacter");
      await run("clearCharacter");
      expect(await read("appliedCharacterStyle")).toBe(
        "CharacterStyle/$ID/[No character style]",
      );
    });

    it("a collapsed caret formats the word around it", async () => {
      await run("underline", { storyId: STORY, start: 34, end: 34 });
      h.setTextSelection({ storyId: STORY, start: 32, end: 37 });
      expect(await read("characterUnderline")).toBe(true);
    });

    it("paragraph commands set the paragraph", async () => {
      covers("command:media.paged.doc.command.word.alignCenter");
      covers("command:media.paged.doc.command.word.alignRight");
      covers("command:media.paged.doc.command.word.justify");
      covers("command:media.paged.doc.command.word.alignLeft");
      covers("command:media.paged.doc.command.word.lineSpacing2");
      covers("command:media.paged.doc.command.word.lineSpacing15");
      covers("command:media.paged.doc.command.word.lineSpacing1");
      for (const [name, value] of [
        ["alignCenter", "CenterAlign"],
        ["alignRight", "RightAlign"],
        ["justify", "LeftJustified"],
        ["alignLeft", "LeftAlign"],
      ] as const) {
        await run(name, THANK);
        expect(await read("paragraphJustification")).toBe(value);
      }
      covers("command:media.paged.doc.command.word.spaceBefore");
      await run("spaceBefore", THANK);
      expect(await read("paragraphSpaceBefore")).toBe(12);
      covers("command:media.paged.doc.command.word.increaseIndent");
      await run("increaseIndent", THANK);
      expect(await read("paragraphLeftIndent")).toBe(36);
      covers("command:media.paged.doc.command.word.decreaseIndent");
      await run("decreaseIndent", THANK);
      expect(await read("paragraphLeftIndent")).toBe(0);
      for (const [name, m] of [
        ["lineSpacing2", 2],
        ["lineSpacing15", 1.5],
        ["lineSpacing1", 1],
      ] as const) {
        await run(name, THANK);
        const size = (await read("characterFontSize")) as number;
        expect(await read("characterLeading")).toBeCloseTo(size * 1.2 * m, 1);
      }
    });

    it("lists: bullets, numbering and the list level", async () => {
      covers("command:media.paged.doc.command.word.bullets");
      await run("bullets", THANK);
      expect(await read("paragraphListType")).toBe("BulletList");
      covers("command:media.paged.doc.command.word.numbering");
      await run("numbering", THANK);
      expect(await read("paragraphListType")).toBe("NumberedList");
      covers("command:media.paged.doc.command.word.listLevelDown");
      await run("listLevelDown", THANK);
      expect(await read("paragraphNumberingLevel")).toBe(2);
      covers("command:media.paged.doc.command.word.listLevelUp");
      await run("listLevelUp", THANK);
      expect(await read("paragraphNumberingLevel")).toBe(1);
      await run("numbering", THANK);
      expect(await read("paragraphListType")).toBe("NoList");
    });

    it("styles: the headings and Normal by the document's own names", async () => {
      covers("command:media.paged.doc.command.word.heading1");
      await run("heading1");
      expect(await read("appliedParagraphStyle")).toBe(
        "ParagraphStyle/docx-Heading1",
      );
      // The document has no Heading 2 or 3: the command refuses and the
      // paragraph keeps its style.
      covers("command:media.paged.doc.command.word.heading2");
      covers("command:media.paged.doc.command.word.heading3");
      await run("heading2");
      await run("heading3");
      expect(await read("appliedParagraphStyle")).toBe(
        "ParagraphStyle/docx-Heading1",
      );
      covers("command:media.paged.doc.command.word.normal");
      await run("normal");
      expect(await read("appliedParagraphStyle")).toBe(
        "ParagraphStyle/docx-Normal",
      );
    });

    it("copy and paste formatting carry the character format", async () => {
      await run("bold", THANK);
      covers("command:media.paged.doc.command.word.copyFormat");
      await run("copyFormat", THANK);
      covers("command:media.paged.doc.command.word.pasteFormat");
      const kind = { storyId: STORY, start: 72, end: 76 };
      await run("pasteFormat", kind);
      expect(await read("characterFontStyle")).toBe("Bold");
    });

    it("counts the document's words and the selection's over the story text", async () => {
      const { countWords, rangeText, storyWords } =
        await import("../../src/word/word-count");
      const content = (await h.host.document.storyContent(STORY))!;
      // Quarterly letter · Dear Name · Thank you for your order ·
      // Apples · Pears · Plums · Kind regards
      expect(storyWords([content])).toBe(14);
      // "Dear «Name»," — the guillemets are two bytes each.
      expect(rangeText(content, 17, 31)).toBe("Dear «Name»,");
      expect(countWords(rangeText(content, 17, 31))).toBe(2);
    });
  },
);
