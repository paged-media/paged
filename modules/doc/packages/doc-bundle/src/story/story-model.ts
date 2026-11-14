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

// Doc ADR 630 — the Story view's reading of a story: the engine's story as
// it is (`host.document.storyContent`), shown as blocks of continuous text.
// There is no second text model: a block is a paragraph of the engine's
// story with its offsets, and an edit is the smallest `deleteRange` +
// `insertText` that turns the old paragraph text into the new one, written
// through `host.document.mutate`. Offsets are the engine's story offsets:
// UTF-8 bytes of the runs plus one `\n` per paragraph boundary (the
// `ContentSelection` addressing, `host.text.caret`'s convention). Pure: no
// React, no host.

import type { Mutation } from "@paged-media/plugin-api";

/** What the Story view reads of a story (the engine's `StoryContent`). */
export interface StoryParagraphs {
  paragraphs: ReadonlyArray<{
    paragraphStyle?: string;
    runs: ReadonlyArray<{ text: string }>;
  }>;
}

export type BlockKind =
  | { kind: "heading"; level: number }
  | { kind: "list"; ordered: boolean }
  | { kind: "body" };

/** One paragraph of the story, as the Story view shows it. */
export interface StoryBlock {
  /** The paragraph's index in the story. */
  index: number;
  /** Its text, without the paragraph mark. */
  text: string;
  /** Story offsets (UTF-8 bytes) of its text: `[start, end)`. The
   *  paragraph mark follows at `end`. */
  start: number;
  end: number;
  /** The applied paragraph style's id, if any. */
  style: string | null;
  /** How the view sets it: a heading of a level, a list item, body text. */
  shape: BlockKind;
  /** The paragraph is past the story's last frame (overset): it does not
   *  print until the thread has room for it. */
  overset: boolean;
}

/** UTF-8 length of `text`: the engine's story offsets count bytes. */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** The style's name as words: `ParagraphStyle/docx-Heading2` → `Heading2`. */
function styleWords(style: string): string {
  return style
    .split("/")
    .pop()!
    .replace(/^docx-/i, "");
}

/** A heading's level from a paragraph style id or name ("Heading 2",
 *  `ParagraphStyle/Heading2`, "Title"), else null. */
export function headingLevelOf(
  style: string | null | undefined,
): number | null {
  if (!style) return null;
  const words = styleWords(style).replace(/[_-]+/g, " ").trim();
  if (/^title$/i.test(words)) return 1;
  const m = /^(?:heading|h|überschrift)\s*(\d)?$/i.exec(words);
  if (!m) return null;
  return Math.min(Math.max(m[1] ? Number(m[1]) : 1, 1), 6);
}

/** A list paragraph by its style ("List Bullet", "List Number 2",
 *  "Bulleted", "Numbered"), else null. */
export function listOf(
  style: string | null | undefined,
): { ordered: boolean } | null {
  if (!style) return null;
  const words = styleWords(style).replace(/[_-]+/g, " ");
  if (
    /number|numbered|ordered|enumerat/i.test(words) &&
    /list|number/i.test(words)
  )
    return { ordered: true };
  if (/bullet|list/i.test(words)) return { ordered: false };
  return null;
}

/**
 * The story as blocks, with offsets: each paragraph's run text, then one
 * paragraph mark. `oversetParagraph` is the first paragraph the engine
 * could not lay out (`StorySummary.oversetAt.paragraph`), when the story
 * oversets; that paragraph and every one after it are marked.
 */
export function storyBlocks(
  content: StoryParagraphs,
  oversetParagraph: number | null = null,
): StoryBlock[] {
  const out: StoryBlock[] = [];
  let offset = 0;
  content.paragraphs.forEach((p, index) => {
    const text = p.runs.map((r) => r.text).join("");
    const style = p.paragraphStyle ?? null;
    const level = headingLevelOf(style);
    const list = level === null ? listOf(style) : null;
    const bytes = utf8Length(text);
    out.push({
      index,
      text,
      start: offset,
      end: offset + bytes,
      style,
      shape:
        level !== null
          ? { kind: "heading", level }
          : list
            ? { kind: "list", ordered: list.ordered }
            : { kind: "body" },
      overset: oversetParagraph !== null && index >= oversetParagraph,
    });
    offset += bytes + 1;
  });
  return out;
}

/** The headings of the story, for the view's structure navigation. */
export function outlineOf(
  blocks: readonly StoryBlock[],
): Array<{ index: number; level: number; text: string }> {
  return blocks.flatMap((b) =>
    b.shape.kind === "heading"
      ? [{ index: b.index, level: b.shape.level, text: b.text }]
      : [],
  );
}

/** The smallest replacement that turns `before` into `after`: the common
 *  head and tail stay, the middle is replaced. Null when equal. */
export function textEdit(
  before: string,
  after: string,
): { from: number; to: number; insert: string } | null {
  if (before === after) return null;
  let head = 0;
  const max = Math.min(before.length, after.length);
  while (head < max && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < max - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  // Never split a surrogate pair.
  if (head > 0 && /[\uD800-\uDBFF]/.test(before[head - 1]!)) head--;
  if (tail > 0 && /[\uDC00-\uDFFF]/.test(before[before.length - tail]!)) tail--;
  return {
    from: head,
    to: before.length - tail,
    insert: after.slice(head, after.length - tail),
  };
}

/**
 * The write that turns `block`'s text into `next` in the engine's story:
 * one batch of `deleteRange` and `insertText` (one undo step). A newline in
 * `next` is a paragraph break (the engine splits the paragraph, as Enter on
 * the canvas does). Null when nothing changed.
 */
export function paragraphWrite(
  storyId: string,
  block: Pick<StoryBlock, "start" | "text">,
  next: string,
): Mutation | null {
  const edit = textEdit(block.text, next.replace(/\r\n?/g, "\n"));
  if (!edit) return null;
  const ops: Mutation[] = [];
  const from = block.start + utf8Length(block.text.slice(0, edit.from));
  const to = block.start + utf8Length(block.text.slice(0, edit.to));
  if (to > from)
    ops.push({
      op: "deleteRange",
      args: { storyId, start: from, end: to },
    } as Mutation);
  if (edit.insert)
    ops.push({
      op: "insertText",
      args: { storyId, offset: from, text: edit.insert },
    } as Mutation);
  return ops.length === 1
    ? ops[0]!
    : ({ op: "batch", args: { ops } } as Mutation);
}

/** Join `block` to the paragraph before it: delete the paragraph mark
 *  between them. Null for the first paragraph. */
export function joinWithPrevious(
  storyId: string,
  block: Pick<StoryBlock, "start" | "index">,
): Mutation | null {
  if (block.index === 0 || block.start === 0) return null;
  return {
    op: "deleteRange",
    args: { storyId, start: block.start - 1, end: block.start },
  } as Mutation;
}
