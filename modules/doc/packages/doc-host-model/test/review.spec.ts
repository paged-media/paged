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

// Doc ADR 613 — the pour's review step: tracked changes recorded and
// comment threads inserted after the text, in a step of their own.
import { describe, expect, it } from "bun:test";

import {
  buildStoryBlocks,
  mergeSectionContents,
  trackChangesMutation,
} from "../src/index.js";
import type { LoweredBlock, LoweredComment } from "../src/index.js";

type Op = { op: string; args: Record<string, unknown> };

const author = { author: "Author A", date: "2026-10-01T10:00:00Z" };

const blocks: LoweredBlock[] = [
  {
    kind: "paragraph",
    sourceIndex: 0,
    runs: [
      { text: "Before ", charStyleId: null, comments: ["docx-c0"] },
      {
        text: "new",
        charStyleId: null,
        change: { id: "docx-r1", kind: "insert", ...author },
        comments: ["docx-c0"],
      },
      {
        text: "old",
        charStyleId: null,
        change: { id: "docx-r2", kind: "delete", ...author },
      },
    ],
    markChange: { id: "docx-r3", kind: "deleteMark", ...author },
  },
  {
    kind: "paragraph",
    sourceIndex: 1,
    paraStyleId: "ParagraphStyle/p",
    propsChange: {
      change: { id: "docx-r4", kind: "paraProps", ...author },
      beforeParaStyleId: "ParagraphStyle/old",
    },
    runs: [
      {
        text: "Bold",
        charStyleId: "CharacterStyle/b",
        formatChange: {
          change: { id: "docx-r5", kind: "format", ...author },
          beforeCharStyleId: "CharacterStyle/plain",
        },
      },
    ],
  },
];

const comments: LoweredComment[] = [
  { id: "docx-c0", text: "Why?", author: "Author A" },
  {
    id: "docx-c1",
    parentId: "docx-c0",
    text: "Because.",
    author: "Author B",
    resolved: true,
  },
];

function pour(): Op[][] {
  let style = 0;
  let text = 0;
  return buildStoryBlocks(blocks, "s", { comments }).map((step) => {
    if (step.kind === "table") return [];
    const ops = step.mutations(text, style) as unknown as Op[];
    style += step.length;
    text += step.byteLength;
    return ops;
  });
}

describe("the review step (doc ADR 613)", () => {
  it("records the changes after the text, in a step of their own", () => {
    const steps = pour();
    expect(steps.length).toBe(2);
    expect(steps[0]!.some((o) => o.op === "recordChange")).toBe(false);
    const review = steps[1]!;
    const changes = review.filter((o) => o.op === "recordChange");
    expect(changes.map((o) => o.args)).toEqual([
      {
        storyId: "s",
        start: 7,
        end: 10,
        change: { kind: "insert", id: "docx-r1", ...author },
      },
      {
        storyId: "s",
        start: 10,
        end: 13,
        change: { kind: "delete", id: "docx-r2", ...author },
      },
      {
        storyId: "s",
        start: 13,
        end: 13,
        paragraph: 0,
        change: { kind: "deleteMark", id: "docx-r3", ...author },
      },
      {
        storyId: "s",
        start: 13,
        end: 17,
        change: {
          kind: "format",
          id: "docx-r5",
          ...author,
          beforeCharacterStyle: "CharacterStyle/plain",
        },
      },
      {
        storyId: "s",
        start: 13,
        end: 13,
        paragraph: 1,
        change: {
          kind: "paraProps",
          id: "docx-r4",
          ...author,
          beforeParagraphStyle: "ParagraphStyle/old",
        },
      },
    ]);
  });

  it("inserts each thread over its range, its replies after it", () => {
    const review = pour()[1]!;
    const threads = review.filter((o) => o.op !== "recordChange");
    expect(threads).toEqual([
      {
        op: "insertComment",
        args: {
          storyId: "s",
          start: 0,
          end: 10,
          comment: { id: "docx-c0", author: "Author A", text: "Why?" },
        },
      },
      {
        op: "replyComment",
        args: {
          parentId: "docx-c0",
          comment: {
            id: "docx-c1",
            author: "Author B",
            text: "Because.",
            resolved: true,
          },
        },
      },
    ]);
  });

  it("turns tracking on through the document property", () => {
    expect(trackChangesMutation()).toEqual({
      op: "set",
      args: {
        address: "doc",
        path: "documentTrackChanges",
        value: { type: "bool", value: true },
      },
    } as never);
  });

  it("joins every story's comments once for save-back", () => {
    const merged = mergeSectionContents(
      [
        { paragraphs: [{ runs: [{ text: "a" }] }], comments: [{ id: "c1" }] },
        {
          paragraphs: [{ runs: [{ text: "b" }] }],
          comments: [{ id: "c1" }, { id: "c2" }],
        },
      ],
      [1, 1],
    );
    expect(merged.comments?.map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});
