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

// Doc ADR 608 — Word's formatting verbs as values (format.ts), the word
// count (word-count.ts) and every Word command's write (commands.ts), over
// a recording host.text: what each command reads and what it writes.

import { describe, expect, it } from "bun:test";

import type {
  BundleHost,
  TextPropertyRead,
  TextPropertyWrite,
} from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import {
  NO_CHARACTER_STYLE,
  runWordCommand,
  WORD_COMMAND,
  WORD_KEYS,
  type WordCommandName,
} from "../src/word/commands";
import {
  alignmentOf,
  isBold,
  leadingFor,
  lineSpacingOf,
  stepFontSize,
  steppedIndent,
  styleBoxOrder,
  styleNamed,
  toggledFontStyle,
} from "../src/word/format";
import { countWords, rangeText, storyWords } from "../src/word/word-count";

describe("Word's formatting verbs (format.ts)", () => {
  it("Bold and Italic toggle a font style, keeping the other", () => {
    expect(toggledFontStyle("Regular", "Bold")).toBe("Bold");
    expect(toggledFontStyle("", "Bold")).toBe("Bold");
    expect(toggledFontStyle(null, "Italic")).toBe("Italic");
    expect(toggledFontStyle("Italic", "Bold")).toBe("Bold Italic");
    expect(toggledFontStyle("Bold Italic", "Bold")).toBe("Italic");
    expect(toggledFontStyle("Bold", "Bold")).toBe("Regular");
    // Mixed takes the attribute on, as Word does.
    expect(toggledFontStyle("mixed", "Bold")).toBe("Bold");
    expect(isBold("Semibold")).toBe(false);
  });
  it("steps sizes along Word's list", () => {
    expect(stepFontSize(11, 1)).toBe(12);
    expect(stepFontSize(10.5, -1)).toBe(10);
    expect(stepFontSize(72, 1)).toBe(80);
    expect(stepFontSize(80, -1)).toBe(72);
    expect(stepFontSize(13, -1)).toBe(12);
  });
  it("indents by half an inch on the grid, never below zero", () => {
    expect(steppedIndent(0, 1)).toBe(36);
    expect(steppedIndent(36, -1)).toBe(0);
    expect(steppedIndent(10, 1)).toBe(36);
    expect(steppedIndent(10, -1)).toBe(0);
    expect(steppedIndent(0, -1)).toBe(0);
  });
  it("reads alignments and line spacing back", () => {
    expect(alignmentOf("CenterAlign")).toBe("center");
    expect(alignmentOf("LeftJustified")).toBe("justify");
    expect(alignmentOf("")).toBeNull();
    expect(leadingFor(10, 1.5)).toBe(18);
    expect(lineSpacingOf(18, 10)).toBe(1.5);
    expect(lineSpacingOf(13, 10)).toBeNull();
  });
  it("offers the document's styles first, never the generated ones", () => {
    const styles = [
      {
        selfId: "ParagraphStyle/$ID/[No paragraph style]",
        name: "$ID/[No paragraph style]",
      },
      { selfId: "ParagraphStyle/docx-Default", name: "docx defaults" },
      { selfId: "ParagraphStyle/docx-Heading1", name: "heading 1" },
      { selfId: "ParagraphStyle/docx-Normal", name: "Normal" },
      { selfId: "ParagraphStyle/docx-auto-p1", name: "docx direct format 1" },
    ];
    expect(styleBoxOrder(styles).map((s) => s.selfId)).toEqual([
      "ParagraphStyle/docx-Heading1",
      "ParagraphStyle/docx-Normal",
      "ParagraphStyle/$ID/[No paragraph style]",
      "ParagraphStyle/docx-Default",
    ]);
    expect(styleNamed(styles, "Heading 1")?.selfId).toBe(
      "ParagraphStyle/docx-Heading1",
    );
    expect(styleNamed(styles, "Heading 2")).toBeNull();
  });
});

describe("word count (word-count.ts)", () => {
  it("counts word-like segments, not punctuation", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("Hello, world — it's 2026!")).toBe(4);
    expect(countWords("  ")).toBe(0);
  });
  it("counts stories and content ranges", () => {
    const story = {
      paragraphs: [
        { runs: [{ text: "Grüße an " }, { text: "alle" }] },
        { runs: [{ text: "zwei Wörter" }] },
      ],
    };
    expect(storyWords([story])).toBe(5);
    // "Grüße" is 7 bytes; the paragraph break is one.
    expect(rangeText(story, 0, 7)).toBe("Grüße");
    expect(rangeText(story, 0, 16)).toBe("Grüße an alle\n");
  });
});

/** A recording host.text: `values` answers the reads; writes and style
 *  applications are recorded. */
function textHost(values: Record<string, TextPropertyRead> = {}) {
  const writes: TextPropertyWrite[][] = [];
  const styles: Array<[string, string]> = [];
  const mutations: Array<{ op: string; args: Record<string, unknown> }> = [];
  const opened: unknown[][] = [];
  const focus: string[] = [];
  const host = {
    log: { warn() {}, info() {}, debug() {}, error() {} },
    supports: () => true,
    shell: { openPanel: (...a: unknown[]) => void opened.push(a) },
    objects: {
      async get() {
        return { kind: "value", value: false };
      },
    },
    text: {
      selection: () => ({ storyId: "s", start: 0, end: 4 }),
      characterRange: async () => ({ storyId: "s", start: 0, end: 4 }),
      async properties(paths: string[]) {
        const out: Record<string, TextPropertyRead> = {};
        for (const p of paths) if (values[p]) out[p] = values[p]!;
        return out;
      },
      async format(props: TextPropertyWrite[]) {
        writes.push(props);
        return { applied: true };
      },
      async applyStyle(scope: string, id: string) {
        styles.push([scope, id]);
        return { applied: true };
      },
    },
    document: {
      async collection(name: string) {
        if (name === "swatches")
          return [{ selfId: "Color/u9", name: "Yellow" }];
        if (name === "numberingLists") return [];
        return [
          { selfId: "ParagraphStyle/docx-Heading1", name: "heading 1" },
          { selfId: "ParagraphStyle/docx-Normal", name: "Normal" },
        ];
      },
      async mutate(m: { op: string; args: Record<string, unknown> }) {
        mutations.push(m);
        return { applied: true, createdId: null };
      },
    },
  } as unknown as BundleHost;
  return { host, writes, styles, mutations, opened, focus };
}

type Rec = ReturnType<typeof textHost>;

const v = (value: unknown): TextPropertyRead => ({ value: value as never });

/** What each command writes against a plain selection (bold and regular
 *  text, 10 pt, no list, no indent). */
const EXPECTED: Record<
  WordCommandName,
  (w: TextPropertyWrite[][], s: Array<[string, string]>, r: Rec) => void
> = {
  bold: (w) =>
    expect(w[0]).toEqual([
      { path: "characterFontStyle", value: { type: "text", value: "Bold" } },
    ]),
  italic: (w) =>
    expect(w[0]![0]!.value).toEqual({ type: "text", value: "Italic" }),
  underline: (w) =>
    expect(w[0]).toEqual([
      { path: "characterUnderline", value: { type: "bool", value: true } },
    ]),
  strikethrough: (w) => expect(w[0]![0]!.path).toBe("characterStrikethru"),
  subscript: (w) =>
    expect(w[0]![0]!.value).toEqual({ type: "text", value: "Subscript" }),
  superscript: (w) =>
    expect(w[0]![0]!.value).toEqual({ type: "text", value: "Superscript" }),
  allCaps: (w) =>
    expect(w[0]![0]!.value).toEqual({ type: "text", value: "AllCaps" }),
  smallCaps: (w) =>
    expect(w[0]![0]!.value).toEqual({ type: "text", value: "SmallCaps" }),
  clearCharacter: (_w, s) =>
    expect(s).toEqual([["character", NO_CHARACTER_STYLE]]),
  growFont: (w) =>
    expect(w[0]![0]!.value).toEqual({ type: "length", value: 10.5 }),
  shrinkFont: (w) =>
    expect(w[0]![0]!.value).toEqual({ type: "length", value: 9 }),
  alignLeft: (w) =>
    expect(w[0]![0]!.value).toEqual({ type: "text", value: "LeftAlign" }),
  alignCenter: (w) =>
    expect(w[0]![0]!.value).toEqual({ type: "text", value: "CenterAlign" }),
  alignRight: (w) =>
    expect(w[0]![0]!.value).toEqual({ type: "text", value: "RightAlign" }),
  justify: (w) =>
    expect(w[0]![0]!.value).toEqual({ type: "text", value: "LeftJustified" }),
  spaceBefore: (w) =>
    expect(w[0]![0]!.value).toEqual({ type: "length", value: 12 }),
  increaseIndent: (w) =>
    expect(w[0]![0]!.value).toEqual({ type: "length", value: 36 }),
  decreaseIndent: (w) =>
    expect(w[0]![0]!.value).toEqual({ type: "length", value: 0 }),
  heading1: (_w, s) =>
    expect(s).toEqual([["paragraph", "ParagraphStyle/docx-Heading1"]]),
  heading2: (w, s) => expect([w, s]).toEqual([[], []]),
  heading3: (w, s) => expect([w, s]).toEqual([[], []]),
  normal: (_w, s) =>
    expect(s).toEqual([["paragraph", "ParagraphStyle/docx-Normal"]]),
  bullets: (w) =>
    expect(w[0]![0]!.value).toEqual({ type: "text", value: "BulletList" }),
  numbering: (w) =>
    expect(w[0]![0]!.value).toEqual({ type: "text", value: "NumberedList" }),
  listLevelDown: (w, _s, r) => {
    expect(w).toEqual([]);
    expect(r.mutations).toEqual([
      {
        op: "setListLevel",
        args: { storyId: "s", start: 0, end: 4, delta: 1 },
      },
    ]);
  },
  listLevelUp: (_w, _s, r) => expect(r.mutations[0]!.args.delta).toBe(-1),
  copyFormat: (w) => expect(w).toEqual([]),
  pasteFormat: (w) => expect(w).toEqual([]),
  lineSpacing1: (w) =>
    expect(w[0]).toEqual([
      {
        path: "characterLeading",
        value: { type: "length", value: 12 },
        extent: "paragraphs",
      },
    ]),
  lineSpacing15: (w) =>
    expect(w[0]![0]!.value).toEqual({ type: "length", value: 18 }),
  lineSpacing2: (w) =>
    expect(w[0]![0]!.value).toEqual({ type: "length", value: 24 }),
  doubleUnderline: (w) =>
    expect(w[0]).toEqual([
      {
        path: "characterUnderlineType",
        value: { type: "text", value: "double" },
      },
    ]),
  hidden: (w) =>
    expect(w[0]).toEqual([
      { path: "characterHidden", value: { type: "bool", value: true } },
    ]),
  highlight: (w) =>
    expect(w[0]).toEqual([
      {
        path: "characterHighlightColor",
        value: { type: "colorRef", value: "Color/u9" },
      },
    ]),
  shading: (w) =>
    expect(w[0]!.map((x) => x.path)).toEqual([
      "paragraphShadingOn",
      "paragraphShadingColor",
      "paragraphShadingTint",
    ]),
  borderBottom: (w) =>
    expect(w[0]![1]).toEqual({
      path: "paragraphRuleBelow",
      value: {
        type: "paragraphRule",
        value: { on: true, weight: 0.5, color: "Color/Black", offset: 4 },
      },
    }),
  borderBox: (w) =>
    expect(w[0]![1]).toEqual({
      path: "paragraphBorderOn",
      value: { type: "bool", value: true },
    }),
  borderNone: (w) =>
    expect(w[0]!.map((x) => x.path)).toEqual([
      "paragraphBorderOn",
      "paragraphRuleBelow",
    ]),
  showHidden: (_w, _s, r) =>
    expect(r.mutations).toEqual([
      {
        op: "set",
        args: {
          address: "doc",
          path: "documentShowHiddenText",
          value: { type: "bool", value: true },
        },
      },
    ]),
  clearParagraph: (w) =>
    expect(w[0]![0]).toEqual({
      path: "paragraphJustification",
      value: { type: "text", value: "" },
    }),
  restartNumbering: (_w, _s, r) =>
    expect(r.mutations[0]).toEqual({
      op: "restartNumbering",
      args: { storyId: "s", start: 0, end: 4, startAt: 1 },
    }),
  continueNumbering: (_w, _s, r) =>
    expect(r.mutations[0]!.args.continueNumbering).toBe(true),
  listOutline: (w, _s, r) => {
    expect(r.mutations[0]!.op).toBe("createNumberingList");
    expect(w[0]![0]).toEqual({
      path: "paragraphAppliedNumberingList",
      value: { type: "text", value: "NumberingList/word-preset-outline" },
    });
  },
  listLegal: (w) =>
    expect(w[0]![0]!.value).toEqual({
      type: "text",
      value: "NumberingList/word-preset-legal",
    }),
  listBullets: (w) =>
    expect(w[0]![1]!.value).toEqual({ type: "text", value: "BulletList" }),
  styleUpdate: (_w, _s, r) => expect(r.mutations[0]!.op).toBe("batch"),
  styleModify: (_w, _s, r) =>
    expect(r.opened).toEqual([
      [
        "paged.style-options",
        { target: "style:paragraph/ParagraphStyle/docx-Normal" },
      ],
    ]),
  styleNew: (_w, _s, r) =>
    expect(r.mutations[0]).toEqual({
      op: "createParagraphStyle",
      args: { name: "Style 1", basedOn: "ParagraphStyle/docx-Normal" },
    }),
  applyStyles: (_w, _s, r) => expect(r.focus).toEqual(["style box"]),
};

describe("every Word command's write (commands.ts)", () => {
  it("each command writes what Word's command does to the selection", async () => {
    covers("command:media.paged.doc.command.word.bold");
    covers("command:media.paged.doc.command.word.italic");
    covers("command:media.paged.doc.command.word.underline");
    covers("command:media.paged.doc.command.word.strikethrough");
    covers("command:media.paged.doc.command.word.subscript");
    covers("command:media.paged.doc.command.word.superscript");
    covers("command:media.paged.doc.command.word.allCaps");
    covers("command:media.paged.doc.command.word.smallCaps");
    covers("command:media.paged.doc.command.word.clearCharacter");
    covers("command:media.paged.doc.command.word.growFont");
    covers("command:media.paged.doc.command.word.shrinkFont");
    covers("command:media.paged.doc.command.word.alignLeft");
    covers("command:media.paged.doc.command.word.alignCenter");
    covers("command:media.paged.doc.command.word.alignRight");
    covers("command:media.paged.doc.command.word.justify");
    covers("command:media.paged.doc.command.word.spaceBefore");
    covers("command:media.paged.doc.command.word.increaseIndent");
    covers("command:media.paged.doc.command.word.decreaseIndent");
    covers("command:media.paged.doc.command.word.heading1");
    covers("command:media.paged.doc.command.word.heading2");
    covers("command:media.paged.doc.command.word.heading3");
    covers("command:media.paged.doc.command.word.normal");
    covers("command:media.paged.doc.command.word.bullets");
    covers("command:media.paged.doc.command.word.numbering");
    covers("command:media.paged.doc.command.word.listLevelDown");
    covers("command:media.paged.doc.command.word.listLevelUp");
    covers("command:media.paged.doc.command.word.copyFormat");
    covers("command:media.paged.doc.command.word.pasteFormat");
    covers("command:media.paged.doc.command.word.lineSpacing1");
    covers("command:media.paged.doc.command.word.lineSpacing15");
    covers("command:media.paged.doc.command.word.lineSpacing2");
    covers("command:media.paged.doc.command.word.doubleUnderline");
    covers("command:media.paged.doc.command.word.hidden");
    covers("command:media.paged.doc.command.word.highlight");
    covers("command:media.paged.doc.command.word.shading");
    covers("command:media.paged.doc.command.word.borderBottom");
    covers("command:media.paged.doc.command.word.borderBox");
    covers("command:media.paged.doc.command.word.borderNone");
    covers("command:media.paged.doc.command.word.showHidden");
    covers("command:media.paged.doc.command.word.clearParagraph");
    covers("command:media.paged.doc.command.word.restartNumbering");
    covers("command:media.paged.doc.command.word.continueNumbering");
    covers("command:media.paged.doc.command.word.listOutline");
    covers("command:media.paged.doc.command.word.listLegal");
    covers("command:media.paged.doc.command.word.listBullets");
    covers("command:media.paged.doc.command.word.styleUpdate");
    covers("command:media.paged.doc.command.word.styleModify");
    covers("command:media.paged.doc.command.word.styleNew");
    covers("command:media.paged.doc.command.word.applyStyles");
    for (const name of Object.keys(WORD_COMMAND) as WordCommandName[]) {
      const { host, writes, styles, ...rest } = textHost({
        characterFontStyle: v("Regular"),
        characterFontSize: v(10),
        characterUnderline: v(false),
        paragraphLeftIndent: v(0),
        paragraphSpaceBefore: v(0),
        paragraphListType: v("NoList"),
        paragraphNumberingLevel: v(1),
        appliedParagraphStyle: v("ParagraphStyle/docx-Normal"),
        characterHighlightColor: v("Swatch/None"),
        paragraphShadingOn: v(false),
        characterHidden: v(false),
      });
      const rec = { host, writes, styles, ...rest };
      await runWordCommand(host, name, {
        copied: null,
        focusStyleBox: () => void rec.focus.push("style box"),
      });
      EXPECTED[name](writes, styles, rec);
    }
  });

  it("copy then paste formatting writes the copied character format", async () => {
    const { host, writes } = textHost({
      characterFontFamily: v("Calibri"),
      characterFontStyle: v("Bold"),
      characterFontSize: "mixed",
    });
    const state = { copied: null };
    await runWordCommand(host, "copyFormat", state);
    await runWordCommand(host, "pasteFormat", state);
    expect(writes[0]).toEqual([
      {
        path: "characterFontFamily",
        value: { type: "text", value: "Calibri" },
      },
      { path: "characterFontStyle", value: { type: "text", value: "Bold" } },
    ]);
  });

  it("every shortcut names a command, and none takes a reserved host key", () => {
    const ids = new Set(Object.values(WORD_COMMAND));
    for (const k of WORD_KEYS) {
      expect(ids.has(k.command as never)).toBe(true);
      expect(["cmd+s", "cmd+p", "cmd+\\", "cmd+shift+p"]).not.toContain(k.key);
    }
  });
});
