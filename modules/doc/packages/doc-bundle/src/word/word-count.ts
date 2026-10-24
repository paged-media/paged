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

// Word count for the status bar (doc ADR 608): Unicode word segmentation
// over the story text the engine reports (`host.document.storyContent`),
// for the whole document and for the selection. A "word" is what
// `Intl.Segmenter` calls word-like (letters or digits), so punctuation and
// spaces never count, and CJK text counts as the segmenter splits it.

const SEGMENTER: Intl.Segmenter | null =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "word" })
    : null;

/** The words in `text`. */
export function countWords(text: string): number {
  if (text === "") return 0;
  if (SEGMENTER) {
    let n = 0;
    for (const s of SEGMENTER.segment(text)) if (s.isWordLike) n++;
    return n;
  }
  return (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).length;
}

/** A story as the engine reports it (`StoryContent`). */
export interface StoryText {
  paragraphs: ReadonlyArray<{ runs: ReadonlyArray<{ text: string }> }>;
}

/** The paragraph texts of a story. */
export function paragraphsOf(story: StoryText): string[] {
  return story.paragraphs.map((p) => p.runs.map((r) => r.text).join(""));
}

/** The words of whole stories (a document's sections). */
export function storyWords(stories: readonly StoryText[]): number {
  let n = 0;
  for (const s of stories) for (const p of paragraphsOf(s)) n += countWords(p);
  return n;
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * The text a CONTENT range of a story covers (UTF-8 byte offsets, one "\n"
 * between paragraphs: the caret's convention), with its paragraph breaks.
 */
export function rangeText(
  story: StoryText,
  start: number,
  end: number,
): string {
  if (end <= start) return "";
  const bytes = utf8.encode(paragraphsOf(story).join("\n"));
  return utf8Decoder.decode(bytes.subarray(start, Math.min(end, bytes.length)));
}
