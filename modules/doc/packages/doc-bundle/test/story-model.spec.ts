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

// Doc ADR 630 — the Story view's reading of the engine's story and the
// writes it makes; the Story Map's reading of the threads.

import { describe, expect, it } from "bun:test";

import {
  headingLevelOf,
  joinWithPrevious,
  listOf,
  outlineOf,
  paragraphWrite,
  storyBlocks,
  textEdit,
  utf8Length,
} from "../src/story/story-model";
import {
  nextOverset,
  previewText,
  storyMap,
} from "../src/story/story-map-model";

const para = (text: string, paragraphStyle?: string) => ({
  paragraphStyle,
  runs: [{ text }],
});

describe("story view blocks", () => {
  it("counts the engine's offsets: UTF-8 bytes and one mark per paragraph", () => {
    const blocks = storyBlocks({
      paragraphs: [para("Café", "ParagraphStyle/Heading1"), para("ab")],
    });
    expect(blocks.map((b) => [b.text, b.start, b.end])).toEqual([
      ["Café", 0, 5],
      ["ab", 6, 8],
    ]);
    expect(utf8Length("日本")).toBe(6);
    expect(utf8Length("😀")).toBe(4);
  });

  it("sets headings, list items and body text by their styles", () => {
    expect(headingLevelOf("ParagraphStyle/docx-Heading2")).toBe(2);
    expect(headingLevelOf("Heading 3")).toBe(3);
    expect(headingLevelOf("Title")).toBe(1);
    expect(headingLevelOf("ParagraphStyle/Body")).toBeNull();
    expect(listOf("ParagraphStyle/List Bullet")).toEqual({ ordered: false });
    expect(listOf("List Number 2")).toEqual({ ordered: true });
    expect(listOf("ParagraphStyle/Body")).toBeNull();
    const blocks = storyBlocks({
      paragraphs: [
        para("Intro", "Heading 1"),
        para("One", "List Bullet"),
        para("Text"),
        para("More", "Heading 2"),
      ],
    });
    expect(blocks.map((b) => b.shape.kind)).toEqual([
      "heading",
      "list",
      "body",
      "heading",
    ]);
    expect(outlineOf(blocks)).toEqual([
      { index: 0, level: 1, text: "Intro" },
      { index: 3, level: 2, text: "More" },
    ]);
  });

  it("marks the overset paragraph and every one after it", () => {
    const blocks = storyBlocks(
      { paragraphs: [para("a"), para("b"), para("c")] },
      1,
    );
    expect(blocks.map((b) => b.overset)).toEqual([false, true, true]);
  });
});

describe("story view writes", () => {
  it("replaces only what changed", () => {
    expect(textEdit("Hello world", "Hello brave world")).toEqual({
      from: 6,
      to: 6,
      insert: "brave ",
    });
    expect(textEdit("abc", "abc")).toBeNull();
    expect(textEdit("abcdef", "abef")).toEqual({ from: 2, to: 4, insert: "" });
  });

  it("writes one batch at the paragraph's byte offsets", () => {
    const [, second] = storyBlocks({
      paragraphs: [para("Ünï"), para("tea for two")],
    });
    expect(second!.start).toBe(6);
    expect(paragraphWrite("s1", second!, "tea for three")).toEqual({
      op: "batch",
      args: {
        ops: [
          { op: "deleteRange", args: { storyId: "s1", start: 15, end: 17 } },
          {
            op: "insertText",
            args: { storyId: "s1", offset: 15, text: "hree" },
          },
        ],
      },
    });
    // An insertion alone is one write; a newline is the engine's
    // paragraph break.
    expect(paragraphWrite("s1", second!, "tea\nfor two")).toEqual({
      op: "batch",
      args: {
        ops: [
          { op: "deleteRange", args: { storyId: "s1", start: 9, end: 10 } },
          { op: "insertText", args: { storyId: "s1", offset: 9, text: "\n" } },
        ],
      },
    });
    expect(paragraphWrite("s1", second!, "tea for two!")).toEqual({
      op: "insertText",
      args: { storyId: "s1", offset: 17, text: "!" },
    });
    expect(paragraphWrite("s1", second!, "tea for two")).toBeNull();
  });

  it("joins a paragraph to the one before by deleting the mark between them", () => {
    expect(joinWithPrevious("s1", { start: 6, index: 1 })).toEqual({
      op: "deleteRange",
      args: { storyId: "s1", start: 5, end: 6 },
    });
    expect(joinWithPrevious("s1", { start: 0, index: 0 })).toBeNull();
  });
});

describe("story map", () => {
  const stories = [
    { selfId: "fits", characterCount: 40, paragraphCount: 2 },
    { selfId: "loose", characterCount: 10, paragraphCount: 1 },
    {
      selfId: "over",
      characterCount: 900,
      paragraphCount: 9,
      overset: true,
      oversetAt: { paragraph: 7, line: 2 },
    },
    {
      selfId: "over2",
      characterCount: 300,
      paragraphCount: 3,
      overset: true,
      oversetAt: { paragraph: 2, line: 0 },
    },
  ];
  const chains = new Map([
    ["fits", ["f1"]],
    ["over", ["o1", "o2", "o3"]],
    ["over2", ["p1"]],
  ]);
  const pages = new Map([
    ["f1", { pageId: "pA", pageIndex: 0 }],
    ["o1", { pageId: "pA", pageIndex: 0 }],
    ["o2", { pageId: "pA", pageIndex: 0 }],
    ["o3", { pageId: "pB", pageIndex: 1 }],
    ["p1", { pageId: "pC", pageIndex: 2 }],
  ]);

  it("puts problems first: overset, then not placed, then stories that fit", () => {
    const map = storyMap(stories, chains, pages);
    expect(map.map((s) => s.storyId)).toEqual([
      "over",
      "over2",
      "loose",
      "fits",
    ]);
    const over = map[0]!;
    expect(over.frames.map((f) => f.frameId)).toEqual(["o1", "o2", "o3"]);
    expect(over.pages).toEqual([0, 1]);
    expect(over.oversetParagraph).toBe(7);
    expect(map[2]).toMatchObject({ disconnected: true, frames: [] });
  });

  it("walks the overset stories round the document", () => {
    const map = storyMap(stories, chains, pages);
    expect(nextOverset(map, null)?.storyId).toBe("over");
    expect(nextOverset(map, "over")?.storyId).toBe("over2");
    expect(nextOverset(map, "over2")?.storyId).toBe("over");
    expect(
      nextOverset(storyMap([stories[0]!], chains, pages), null),
    ).toBeNull();
  });

  it("previews a story's first words", () => {
    expect(previewText([para("Hello  big"), para("world")], 9)).toBe(
      "Hello bi…",
    );
  });
});
