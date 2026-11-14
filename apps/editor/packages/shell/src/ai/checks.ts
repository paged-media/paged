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

// Editor ADR 1234 — the assistant's DETERMINISTIC checks: Inspect and
// Propose without a model, on this device. Each reads the document through
// the object model (read-only) and proposes ordinary property writes with
// the value before and after; the same document gives the same proposal.
//
//   smallText      text smaller than a size (optionally only paragraphs
//                  whose style's name contains a word, "Caption"): raise it
//                  to that size — the strategy's "captions smaller than
//                  8 pt" example;
//   contrast       text whose colour has less than 4.5:1 contrast with its
//                  frame's fill (3:1 at 18 pt and up, WCAG 2.2): the darker
//                  or lighter of Black and Paper, whichever reads better;
//   altText        a placed image without alternative text: the user writes
//                  it (the item needs a value), kept as the frame's
//                  `x-paged:alt` label;
//   sizeOverrides  consistency: text whose size overrides its paragraph
//                  style's: clear the override, so the style governs.

import type { ShellObjectsSurface } from "../catalog/object-model-types";
import type { ChangeItem } from "./change-set";

/** What the checks read through. */
export interface InspectDoors {
  objects: Pick<ShellObjectsSurface, "query" | "get">;
  /** A swatch's display colour (`#rrggbb`), or null. */
  colorHex(swatch: string): Promise<string | null>;
  /** The text frames a story flows through (their addresses). */
  framesOf(storyId: string): Promise<string[]>;
}

/** Which objects a check looks at: the whole document, or the selection's
 *  frames (and the stories that flow through them). */
export interface CheckScope {
  frames: readonly string[] | null;
}

export type CheckId = "smallText" | "contrast" | "altText" | "sizeOverrides";

export const CHECK_IDS: readonly CheckId[] = [
  "smallText",
  "contrast",
  "altText",
  "sizeOverrides",
];

export interface CheckParams {
  /** smallText: the smallest size allowed (pt). */
  minSize?: number;
  /** smallText: only paragraphs whose style name contains this. */
  styleContains?: string;
}

/** The words the checks put into their items (the caller's locale). */
export interface CheckWords {
  smaller(size: number, min: number): string;
  contrast(ratio: number, need: number): string;
  noAltText(): string;
  overrides(size: number, style: number, name: string): string;
  image(address: string): string;
}

// ─────────────────────────────────────────────── reading helpers

type Read = Awaited<ReturnType<ShellObjectsSurface["get"]>>;

/** A read's plain value: a number for a length or a number, the string for
 *  a ref or a text, `mixed`, or null. */
export function plain(v: Read): unknown {
  if (v.kind === "mixed") return "mixed";
  if (v.kind !== "value") return null;
  const value = v.value as unknown;
  if (value && typeof value === "object" && "value" in (value as object))
    return (value as { value: unknown }).value;
  return value;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** `[start, end)` of every non-empty paragraph of `text`. */
export function paragraphRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (i === text.length || c === "\r" || c === "\n" || c === " ") {
      if (i > start) out.push([start, i]);
      start = i + 1;
    }
  }
  return out;
}

const storyIdOf = (address: string) =>
  /^story:(.+)$/.exec(address)?.[1] ?? address;

const range = (story: string, s: number, e: number) =>
  `storyRange:${story}@${s}..${e}`;

/** The runs of `[s, e)` over which `path` is one value, splitting a mixed
 *  range in halves (at most `budget` reads). */
async function uniformRuns(
  objects: InspectDoors["objects"],
  story: string,
  s: number,
  e: number,
  path: string,
  budget: { reads: number },
): Promise<Array<{ s: number; e: number; value: unknown }>> {
  if (budget.reads <= 0) return [];
  budget.reads -= 1;
  const value = plain(await objects.get(range(story, s, e), path));
  if (value !== "mixed" || e - s <= 1) return [{ s, e, value }];
  const mid = Math.floor((s + e) / 2);
  return [
    ...(await uniformRuns(objects, story, s, mid, path, budget)),
    ...(await uniformRuns(objects, story, mid, e, path, budget)),
  ];
}

/** Adjacent runs with one value, merged. */
function merged<T extends { s: number; e: number; value: unknown }>(
  runs: T[],
): T[] {
  const out: T[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && last.e === r.s && last.value === r.value) last.e = r.e;
    else out.push({ ...r });
  }
  return out;
}

/** The stories in scope, with their text. */
async function storiesIn(
  doors: InspectDoors,
  scope: CheckScope,
): Promise<Array<{ id: string; text: string }>> {
  const all = await doors.objects.query("story").catch(() => [] as string[]);
  const out: Array<{ id: string; text: string }> = [];
  const frames = scope.frames ? new Set(scope.frames) : null;
  for (const address of all) {
    const id = storyIdOf(address);
    if (frames) {
      const through = await doors.framesOf(id).catch(() => [] as string[]);
      if (!through.some((f) => frames.has(f))) continue;
    }
    const text = plain(await doors.objects.get(`story:${id}`, "text"));
    if (typeof text === "string" && text.length > 0) out.push({ id, text });
  }
  return out;
}

const snippet = (text: string, s: number, e: number) => {
  const t = text.slice(s, e).trim();
  return t.length > 40 ? `${t.slice(0, 39)}…` : t;
};

const itemId = () => `chg_${Math.random().toString(36).slice(2, 10)}`;

// ─────────────────────────────────────────────────── the checks

async function smallText(
  doors: InspectDoors,
  scope: CheckScope,
  params: CheckParams,
  words: CheckWords,
): Promise<ChangeItem[]> {
  const min = params.minSize ?? 8;
  const want = params.styleContains?.trim().toLowerCase() ?? "";
  const items: ChangeItem[] = [];
  for (const story of await storiesIn(doors, scope)) {
    for (const [s, e] of paragraphRanges(story.text)) {
      if (want) {
        const style = plain(
          await doors.objects.get(
            range(story.id, s, e),
            "appliedParagraphStyle",
          ),
        );
        if (typeof style !== "string" || !style.toLowerCase().includes(want))
          continue;
      }
      const budget = { reads: 32 };
      const runs = merged(
        await uniformRuns(
          doors.objects,
          story.id,
          s,
          e,
          "characterFontSize",
          budget,
        ),
      );
      for (const run of runs) {
        const size = num(run.value);
        if (size === null || size >= min) continue;
        items.push({
          id: itemId(),
          address: range(story.id, run.s, run.e),
          path: "characterFontSize",
          subject: snippet(story.text, run.s, run.e),
          before: size,
          after: min,
          reason: words.smaller(size, min),
          rule: "smallText",
        });
      }
    }
  }
  return items;
}

/** WCAG 2.2 relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 1;
  const n = parseInt(m[1]!, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** The contrast ratio of two colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

const NONE = /(^|\/)none$/i;

async function contrast(
  doors: InspectDoors,
  scope: CheckScope,
  _params: CheckParams,
  words: CheckWords,
): Promise<ChangeItem[]> {
  const items: ChangeItem[] = [];
  for (const story of await storiesIn(doors, scope)) {
    const frames = await doors.framesOf(story.id).catch(() => [] as string[]);
    const fill = frames[0]
      ? plain(await doors.objects.get(frames[0], "frameFillColor"))
      : null;
    // No fill: the paper shows through.
    const background =
      typeof fill === "string" && fill && !NONE.test(fill)
        ? ((await doors.colorHex(fill)) ?? "#ffffff")
        : "#ffffff";
    const blackOnIt = contrastRatio("#000000", background);
    const whiteOnIt = contrastRatio("#ffffff", background);
    const better = blackOnIt >= whiteOnIt ? "Color/Black" : "Color/Paper";
    for (const [s, e] of paragraphRanges(story.text)) {
      const budget = { reads: 24 };
      const colours = merged(
        await uniformRuns(
          doors.objects,
          story.id,
          s,
          e,
          "characterFillColor",
          budget,
        ),
      );
      for (const run of colours) {
        if (typeof run.value !== "string" || NONE.test(run.value)) continue;
        const hex = await doors.colorHex(run.value);
        if (!hex) continue;
        const size = num(
          plain(
            await doors.objects.get(
              range(story.id, run.s, run.e),
              "characterFontSize",
            ),
          ),
        );
        const need = size !== null && size >= 18 ? 3 : 4.5;
        const ratio = contrastRatio(hex, background);
        if (ratio >= need || run.value === better) continue;
        items.push({
          id: itemId(),
          address: range(story.id, run.s, run.e),
          path: "characterFillColor",
          subject: snippet(story.text, run.s, run.e),
          before: run.value,
          after: better,
          reason: words.contrast(Math.round(ratio * 10) / 10, need),
          rule: "contrast",
        });
      }
    }
  }
  return items;
}

/** The label the alternative text is kept in. */
export const ALT_TEXT_LABEL = "x-paged:alt";

async function altText(
  doors: InspectDoors,
  scope: CheckScope,
  _params: CheckParams,
  words: CheckWords,
): Promise<ChangeItem[]> {
  const items: ChangeItem[] = [];
  const candidates = scope.frames
    ? [...scope.frames]
    : (
        await Promise.all(
          ["rectangle", "oval", "polygon"].map((k) =>
            doors.objects.query(k).catch(() => [] as string[]),
          ),
        )
      ).flat();
  for (const address of candidates) {
    const uri = plain(await doors.objects.get(address, "imageUri"));
    if (typeof uri !== "string" || uri.length === 0) continue;
    const labels = plain(await doors.objects.get(address, "labels"));
    const existing =
      labels && typeof labels === "object"
        ? (labels as Record<string, unknown>)[ALT_TEXT_LABEL]
        : undefined;
    if (typeof existing === "string" && existing.length > 0) continue;
    items.push({
      id: itemId(),
      address,
      path: ALT_TEXT_LABEL,
      subject: words.image(uri.split(/[\\/]/).pop() ?? address),
      before: null,
      after: "",
      reason: words.noAltText(),
      rule: "altText",
      write: { kind: "label", key: ALT_TEXT_LABEL },
      needsValue: true,
    });
  }
  return items;
}

async function sizeOverrides(
  doors: InspectDoors,
  scope: CheckScope,
  _params: CheckParams,
  words: CheckWords,
): Promise<ChangeItem[]> {
  const items: ChangeItem[] = [];
  const styleSize = new Map<string, number | null>();
  for (const story of await storiesIn(doors, scope)) {
    for (const [s, e] of paragraphRanges(story.text)) {
      const style = plain(
        await doors.objects.get(range(story.id, s, e), "appliedParagraphStyle"),
      );
      if (typeof style !== "string" || !style) continue;
      if (!styleSize.has(style)) {
        const v = num(
          plain(
            await doors.objects.get(
              `style:paragraph/${style}`,
              "characterFontSize",
            ),
          ),
        );
        styleSize.set(style, v);
      }
      const governed = styleSize.get(style) ?? null;
      if (governed === null) continue;
      const runs = merged(
        await uniformRuns(doors.objects, story.id, s, e, "characterFontSize", {
          reads: 32,
        }),
      );
      for (const run of runs) {
        const size = num(run.value);
        if (size === null || Math.abs(size - governed) < 0.01) continue;
        items.push({
          id: itemId(),
          address: range(story.id, run.s, run.e),
          path: "characterFontSize",
          subject: snippet(story.text, run.s, run.e),
          before: size,
          // A cleared override reads the style's size again.
          after: null,
          reason: words.overrides(
            size,
            governed,
            style.replace(/^ParagraphStyle\//, ""),
          ),
          rule: "sizeOverrides",
        });
      }
    }
  }
  return items;
}

const CHECKS: Record<
  CheckId,
  (
    d: InspectDoors,
    s: CheckScope,
    p: CheckParams,
    w: CheckWords,
  ) => Promise<ChangeItem[]>
> = { smallText, contrast, altText, sizeOverrides };

/** Run the checks `ids` over `scope`: their proposals, in check order. */
export async function runChecks(
  ids: readonly CheckId[],
  doors: InspectDoors,
  scope: CheckScope,
  params: CheckParams,
  words: CheckWords,
): Promise<ChangeItem[]> {
  const out: ChangeItem[] = [];
  for (const id of ids)
    out.push(...(await CHECKS[id](doors, scope, params, words)));
  return out;
}
