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

// WP4.5 — the Info panel's arithmetic, kept pure so the unit lane proves
// it: the selection's box and angle from the engine's geometry, a pixel
// read out of a decoded snapshot, and the colour conversions a sampled
// display pixel allows (sRGB → hex and CIE L*a*b*, D50 as ICC's PCS).

import type { ElementGeometryItem } from "@paged-media/client";
import { rgbToLab } from "@paged-media/helpers";

export interface SelectionReadout {
  /** Top-left of the selection's axis-aligned box, page space, pt. */
  x: number;
  y: number;
  /** One item: its own width and height (scaled, not the rotated box's);
   *  several: the box's. */
  w: number;
  h: number;
  /** Degrees as the transform fields show them (the engine's
   *  decomposition), or null when several items disagree. */
  angle: number | null;
  /** How many items the readout covers (those on a page). */
  count: number;
}

type Affine = readonly [number, number, number, number, number, number];
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** The transform's rotation, as `decompose_transform` reads it: a
 *  mirroring matrix folds its reflection into X first. */
export function angleOf(m: Affine | null | undefined): number {
  const [a, b, c, d] = m ?? IDENTITY;
  const sign = a * d - b * c < 0 ? -1 : 1;
  const a2 = sign * a;
  const b2 = sign * b;
  if (a2 === 0 && b2 === 0) return 0;
  const deg = (Math.atan2(b2, a2) * 180) / Math.PI;
  return Math.abs(deg) < 1e-9 ? 0 : deg;
}

function scaleOf(m: Affine): [number, number] {
  const [a, b, c, d] = m;
  const sx = Math.hypot(a, b);
  const det = Math.abs(a * d - b * c);
  return [sx, sx === 0 ? 0 : det / sx];
}

/** The selection's position, size and angle. Items without a page (the
 *  pasteboard before placement) are left out; null when none remain. */
export function selectionReadout(
  items: ReadonlyArray<ElementGeometryItem>,
): SelectionReadout | null {
  const onPage = items.filter((g) => g.pageId);
  if (onPage.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const angles: number[] = [];
  for (const g of onPage) {
    const m = (g.itemTransform ?? IDENTITY) as Affine;
    const [top, left, bottom, right] = g.bounds;
    for (const [x, y] of [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ] as const) {
      const px = m[0] * x + m[2] * y + m[4];
      const py = m[1] * x + m[3] * y + m[5];
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
    angles.push(angleOf(m));
  }
  const same = angles.every((a) => Math.abs(a - angles[0]!) < 1e-6);
  if (onPage.length === 1) {
    const g = onPage[0]!;
    const m = (g.itemTransform ?? IDENTITY) as Affine;
    const [sx, sy] = scaleOf(m);
    const [top, left, bottom, right] = g.bounds;
    return {
      x: minX,
      y: minY,
      w: (right - left) * sx,
      h: (bottom - top) * sy,
      angle: angles[0]!,
      count: 1,
    };
  }
  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
    angle: same ? angles[0]! : null,
    count: onPage.length,
  };
}

/** A decoded RGBA raster (an `ImageData`'s shape). */
export interface Raster {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

/** The pixel of `raster` (a page drawn `width` px wide) under the page
 *  point, or null outside the page. */
export function samplePixel(
  raster: Raster,
  pageSizePt: readonly [number, number],
  pagePoint: readonly [number, number],
): [number, number, number, number] | null {
  const [pw, ph] = pageSizePt;
  const [x, y] = pagePoint;
  if (pw <= 0 || ph <= 0 || x < 0 || y < 0 || x > pw || y > ph) return null;
  const px = Math.min(raster.width - 1, Math.floor((x / pw) * raster.width));
  const py = Math.min(raster.height - 1, Math.floor((y / ph) * raster.height));
  const i = (py * raster.width + px) * 4;
  const d = raster.data;
  return [d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!];
}

/** `#rrggbb`. */
export function rgbHex(r: number, g: number, b: number): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** sRGB (0–255) → CIE L*a*b* under D50 (ICC's connection space; the
 *  conversion is `@paged-media/helpers`' `rgbToLab`). Rounded to one
 *  decimal. */
export function srgbToLab(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const lab = rgbToLab([r, g, b], "D50");
  const r1 = (v: number) => {
    const n = Math.round(v * 10) / 10;
    return Object.is(n, -0) ? 0 : n;
  };
  return [r1(lab.l), r1(lab.a), r1(lab.b)];
}

// ---- Text statistics (the Info panel's Text section) ----------------------

const WORDS: Intl.Segmenter | null =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "word" })
    : null;

/** The words in `text`: what `Intl.Segmenter` calls word-like (letters or
 *  digits), so punctuation and spaces never count and CJK text counts as the
 *  segmenter splits it. */
export function countWords(text: string): number {
  if (text === "") return 0;
  if (WORDS) {
    let n = 0;
    for (const s of WORDS.segment(text)) if (s.isWordLike) n++;
    return n;
  }
  return (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).length;
}

/** A story as the engine reports it (`requestStoryContent`). */
export interface StoryText {
  paragraphs: ReadonlyArray<{ runs: ReadonlyArray<{ text: string }> }>;
}

/** The story's paragraph texts. */
export const paragraphsOf = (story: StoryText): string[] =>
  story.paragraphs.map((p) => p.runs.map((r) => r.text).join(""));

/** Words and characters of whole stories (characters without paragraph
 *  breaks, spaces included). */
export function storyTotals(stories: readonly StoryText[]): {
  words: number;
  characters: number;
} {
  let words = 0;
  let characters = 0;
  for (const s of stories)
    for (const p of paragraphsOf(s)) {
      words += countWords(p);
      characters += [...p].length;
    }
  return { words, characters };
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** The text a content range of a story covers: UTF-8 byte offsets with one
 *  "\n" between paragraphs (the caret's convention). */
export function rangeText(
  story: StoryText,
  start: number,
  end: number,
): string {
  if (end <= start) return "";
  const bytes = utf8.encode(paragraphsOf(story).join("\n"));
  return utf8Decoder.decode(bytes.subarray(start, Math.min(end, bytes.length)));
}
