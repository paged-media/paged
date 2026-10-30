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

// Extensions ADR 348 (C4) — the pure half of `host.text`'s selection
// doors. Two offset spaces meet here. The text selection is in CONTENT
// offsets (UTF-8 bytes of the paragraph text, one synthetic "\n" between
// paragraphs: what the caret, `insertText` and `deleteRange` count), while
// the engine's story-range address (`setElementProperty` on a
// `storyRange`, `RequestGet` on `storyRange:`) counts CHARACTERS with no
// paragraph separator. Passing one as the other formats the wrong text
// from the second paragraph on, so every write converts here.

/** The text of a story's paragraphs, in body order. */
export type ParagraphTexts = readonly string[];

/** The paragraph texts of a `StoryContent`-shaped value. */
export function paragraphTexts(content: {
  paragraphs: ReadonlyArray<{ runs: ReadonlyArray<{ text: string }> }>;
}): string[] {
  return content.paragraphs.map((p) => p.runs.map((r) => r.text).join(""));
}

const utf8 = new TextEncoder();

/** Characters (Unicode scalar values, as the engine counts) in `s`. */
function charCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** The characters of `s` whose UTF-8 encoding fits in `bytes` bytes (a
 *  byte inside a character counts that character as not reached). */
function charsInBytes(s: string, bytes: number): number {
  let used = 0;
  let n = 0;
  for (const ch of s) {
    const w = utf8.encode(ch).length;
    if (used + w > bytes) break;
    used += w;
    n++;
  }
  return n;
}

/** A content offset as a story character offset (the engine's
 *  `content_offset_to_char`, mirrored). */
export function contentToChar(paras: ParagraphTexts, offset: number): number {
  let consumed = 0;
  let chars = 0;
  for (let i = 0; i < paras.length; i++) {
    if (i > 0) {
      if (offset <= consumed) return chars;
      consumed += 1;
    }
    const text = paras[i]!;
    const len = utf8.encode(text).length;
    if (offset <= consumed + len)
      return chars + charsInBytes(text, offset - consumed);
    consumed += len;
    chars += charCount(text);
  }
  return chars;
}

/** A story character offset as a content offset: the inverse of
 *  {@link contentToChar} (the engine's `char_to_content_offset`). A
 *  character at a paragraph's end is that paragraph's end, not the next
 *  one's start. */
export function charToContent(paras: ParagraphTexts, at: number): number {
  let consumed = 0;
  let chars = 0;
  for (let i = 0; i < paras.length; i++) {
    if (i > 0) consumed += 1;
    const text = paras[i]!;
    const n = charCount(text);
    if (at <= chars + n) {
      const head = [...text].slice(0, Math.max(0, at - chars)).join("");
      return consumed + utf8.encode(head).length;
    }
    consumed += utf8.encode(text).length;
    chars += n;
  }
  return consumed;
}

/** The paragraph spans in character space: `[start, end)` per paragraph. */
export function paragraphSpans(paras: ParagraphTexts): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let at = 0;
  for (const p of paras) {
    const n = charCount(p);
    out.push([at, at + n]);
    at += n;
  }
  return out;
}

/** The paragraph a CONTENT offset stands in (the caret's paragraph). */
export function paragraphAtContent(
  paras: ParagraphTexts,
  offset: number,
): number {
  let consumed = 0;
  for (let i = 0; i < paras.length; i++) {
    const len = utf8.encode(paras[i]!).length;
    if (offset <= consumed + len) return i;
    consumed += len + 1;
  }
  return Math.max(0, paras.length - 1);
}

const WORD_SEGMENTER: Intl.Segmenter | null =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "word" })
    : null;

/**
 * The word around a collapsed caret, in character space, or null when the
 * caret stands between words (a space, a paragraph edge with nothing
 * word-like next to it). Word formats the whole word when B is pressed
 * with the caret inside one; at a word's end it formats that word.
 */
export function wordAroundCaret(
  paras: ParagraphTexts,
  contentOffset: number,
): [number, number] | null {
  const pi = paragraphAtContent(paras, contentOffset);
  const text = paras[pi] ?? "";
  const spans = paragraphSpans(paras);
  const base = spans[pi]?.[0] ?? 0;
  const local = contentToChar(paras, contentOffset) - base;
  // Segment by UTF-16 index, report in characters.
  const chars = [...text];
  const segments: Array<{ start: number; end: number; word: boolean }> = [];
  if (WORD_SEGMENTER) {
    for (const s of WORD_SEGMENTER.segment(text)) {
      const start = charCount(text.slice(0, s.index));
      segments.push({
        start,
        end: start + charCount(s.segment),
        word: s.isWordLike === true,
      });
    }
  } else {
    let i = 0;
    while (i < chars.length) {
      const word = /[\p{L}\p{N}_]/u.test(chars[i]!);
      let j = i + 1;
      while (j < chars.length && /[\p{L}\p{N}_]/u.test(chars[j]!) === word) j++;
      segments.push({ start: i, end: j, word });
      i = j;
    }
  }
  const hit =
    segments.find((s) => s.word && s.start < local && local < s.end) ??
    segments.find((s) => s.word && s.end === local) ??
    segments.find((s) => s.word && s.start === local);
  return hit ? [base + hit.start, base + hit.end] : null;
}

/**
 * The character range a READ of a collapsed caret looks at: the character
 * before it, or the one after it at a paragraph's start; in an empty
 * paragraph the empty range at it (the engine reads the paragraph there).
 */
export function caretReadRange(
  paras: ParagraphTexts,
  contentOffset: number,
): [number, number] {
  const pi = paragraphAtContent(paras, contentOffset);
  const [ps, pe] = paragraphSpans(paras)[pi] ?? [0, 0];
  if (ps === pe) return [ps, ps];
  const at = contentToChar(paras, contentOffset);
  return at > ps ? [at - 1, at] : [at, at + 1];
}

/** The character range of every paragraph the CONTENT range touches,
 *  whole; null when they hold no characters (empty paragraphs). */
export function paragraphsRange(
  paras: ParagraphTexts,
  startContent: number,
  endContent: number,
): [number, number] | null {
  const spans = paragraphSpans(paras);
  const a = spans[paragraphAtContent(paras, startContent)];
  const b = spans[paragraphAtContent(paras, endContent)];
  if (!a || !b || a[0] === b[1]) return null;
  return [a[0], b[1]];
}
