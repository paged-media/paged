/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// Editor ADR 303 — Find & Replace, the pure half: the options a user sets
// as the engine's `FindSpec` (engine ADR 1021), where Find Next goes from
// the selection, a replacement's text for ONE hit (Word's `^p` `^t` `^l`
// `^&` `^^` and the groups), and a hit's context split around the match
// for the results list. No React, no client: the dialog, the results
// panel and the commands share it, and the unit tests read it directly.

import type { FindHit, FindMode, FindSpec } from "@paged-media/client";

/** What the user set in the dialog or the results panel. */
export interface FindOptions {
  find: string;
  replace: string;
  matchCase: boolean;
  wholeWord: boolean;
  /** Word's "Use wildcards", or a regular expression (InDesign's GREP). */
  mode: FindMode;
  /** Find by style: only paragraphs of this paragraph style. */
  paragraphStyle: string | null;
  /** Find by style: only runs of this character style. */
  characterStyle: string | null;
  /** Replace with style. */
  replaceParagraphStyle: string | null;
  replaceCharacterStyle: string | null;
  /** Search the caret's story only (InDesign's "Story"), else the document. */
  storyOnly: boolean;
}

export const DEFAULT_FIND_OPTIONS: FindOptions = {
  find: "",
  replace: "",
  matchCase: false,
  wholeWord: false,
  mode: "literal",
  paragraphStyle: null,
  characterStyle: null,
  replaceParagraphStyle: null,
  replaceCharacterStyle: null,
  storyOnly: false,
};

/** Word's special characters, in the order the Special menu lists them.
 *  `findOnly` ones cannot be put in by a replace (a page break is a
 *  paragraph attribute, not text). */
export const SPECIALS: ReadonlyArray<{
  code: string;
  name:
    | "paragraph"
    | "tab"
    | "lineBreak"
    | "pageBreak"
    | "anyCharacter"
    | "anyDigit"
    | "anyLetter"
    | "foundText";
  findOnly?: boolean;
  replaceOnly?: boolean;
}> = [
  { code: "^p", name: "paragraph" },
  { code: "^t", name: "tab" },
  { code: "^l", name: "lineBreak" },
  { code: "^m", name: "pageBreak", findOnly: true },
  { code: "^?", name: "anyCharacter", findOnly: true },
  { code: "^#", name: "anyDigit", findOnly: true },
  { code: "^$", name: "anyLetter", findOnly: true },
  { code: "^&", name: "foundText", replaceOnly: true },
];

/** The engine's `FindSpec` for `options` (`storyId` when searching one
 *  story). Absent fields stay absent so the wire defaults apply. */
export function findSpecOf(
  options: FindOptions,
  storyId: string | null = null,
): FindSpec {
  const spec: FindSpec = { find: options.find };
  if (options.mode !== "literal") spec.mode = options.mode;
  if (options.matchCase) spec.matchCase = true;
  if (options.wholeWord) spec.wholeWord = true;
  if (options.paragraphStyle) spec.paragraphStyle = options.paragraphStyle;
  if (options.characterStyle) spec.characterStyle = options.characterStyle;
  if (options.storyOnly && storyId) spec.storyId = storyId;
  return spec;
}

/** A selection-like range (content offsets). */
export interface CaretRange {
  storyId: string;
  start: number;
  end: number;
}

/** Whether `sel` is exactly `hit`. */
export function isHit(sel: CaretRange | null, hit: FindHit): boolean {
  return (
    !!sel &&
    sel.storyId === hit.storyId &&
    sel.start === hit.start &&
    sel.end === hit.end
  );
}

/**
 * The hit Find Next goes to from `sel`: the first in `sel`'s story that
 * starts at or after its end, else the first hit of the stories after it
 * (hits come in document story order), wrapping to the first hit. `-1`
 * without hits. `backwards` is Find Previous.
 */
export function nextHitIndex(
  hits: readonly FindHit[],
  sel: CaretRange | null,
  backwards = false,
): number {
  if (hits.length === 0) return -1;
  if (!sel) return backwards ? hits.length - 1 : 0;
  const order: string[] = [];
  for (const h of hits) if (!order.includes(h.storyId)) order.push(h.storyId);
  const storyRank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? -1 : i;
  };
  const own = storyRank(sel.storyId);
  if (!backwards) {
    const i = hits.findIndex((h) =>
      h.storyId === sel.storyId
        ? h.start >= sel.end && !(h.start === sel.start && h.end === sel.end)
        : own >= 0 && storyRank(h.storyId) > own,
    );
    return i < 0 ? 0 : i;
  }
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i]!;
    if (
      h.storyId === sel.storyId
        ? h.end <= sel.start && !isHit(sel, h)
        : own >= 0 && storyRank(h.storyId) < own
    ) {
      return i;
    }
  }
  return hits.length - 1;
}

/**
 * The text one hit is replaced with, as the engine's replace-all spells
 * it (engine ADR 1021): `^p` paragraph, `^t` tab, `^l` line break, `^&`
 * the found text, `^^` a caret; `$1`… (regex) or `\1`… (wildcards) a
 * group of the hit. `null` for `^m`, which a replace cannot put in.
 */
export function replacementFor(
  replace: string,
  hit: Pick<FindHit, "text" | "groups">,
  mode: FindMode,
): string | null {
  let out = "";
  for (let i = 0; i < replace.length; i++) {
    const c = replace[i]!;
    const next = replace[i + 1];
    if (c === "^" && next !== undefined) {
      i++;
      if (next === "p") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "l") out += "\u2028";
      else if (next === "&") out += hit.text;
      else if (next === "^") out += "^";
      else if (next === "m") return null;
      else out += c + next;
      continue;
    }
    const groupLead =
      mode === "regex" ? "$" : mode === "wildcards" ? "\\" : null;
    if (
      groupLead &&
      c === groupLead &&
      next !== undefined &&
      /[0-9]/.test(next)
    ) {
      i++;
      const g = hit.groups?.[Number(next) - 1];
      out += g ?? "";
      continue;
    }
    out += c;
  }
  return out;
}

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder();

/** A hit's context as before / match / after, for the results list
 *  (`contextOffset` counts UTF-8 bytes). Paragraph and line breaks in the
 *  context show as spaces. */
export function contextParts(
  hit: Pick<FindHit, "context" | "contextOffset" | "text">,
): {
  before: string;
  match: string;
  after: string;
} {
  const bytes = utf8.encode(hit.context);
  const at = Math.max(0, Math.min(bytes.length, hit.contextOffset));
  const before = utf8Decode.decode(bytes.slice(0, at));
  const rest = hit.context.slice(before.length);
  const match = rest.startsWith(hit.text)
    ? hit.text
    : rest.slice(0, hit.text.length);
  const flat = (s: string) =>
    s.replace(/[\n\u2028]/g, " ").replaceAll("\f", " ");
  return {
    before: flat(before),
    match: flat(match),
    after: flat(rest.slice(match.length)),
  };
}

/** The UTF-8 length of `s` (a replacement's length in caret offsets; one
 *  `\n` is one offset, as a paragraph break is). */
export function byteLength(s: string): number {
  return utf8.encode(s).length;
}

/** A page number the Go To field accepts: 1-based, within `pageCount`. */
export function pageIndexOf(input: string, pageCount: number): number | null {
  const n = Number(input.trim());
  if (!Number.isInteger(n) || n < 1 || n > pageCount) return null;
  return n - 1;
}
