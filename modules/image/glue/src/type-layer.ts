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

// TYPE LAYERS (WP5.10, image ADR 474): the source of a type layer and the
// one function that turns it into pixels — through the ENGINE
// (`host.render.story`, extensions ADR 342), so the text is laid out by
// paged-text's composer with the document's fonts, wraps, justifies and
// hyphenates exactly as a text frame on the page does. The image module
// shapes no text of its own for a type layer.
//
// UNITS. A source measures everything in canvas pixels. The story is
// drawn at `72 · k` dpi with every length divided by `k`, so one engine
// point is `1 / k` of a canvas pixel and the image comes back at canvas
// resolution; `k` grows past 1 only so a large frame stays near the page
// (`MAX_FRAME_PT`).

import type {
  BundleHost,
  RenderStory,
  RenderStoryParagraph,
  RenderStoryRun,
} from "@paged-media/plugin-api";

import type { TypeRenderPixels } from "./engine";

/** Mirrors image-js `layers::type_layer::TypeSource` (serde camelCase). */
export interface TypeSource {
  /** Paragraphs separated by `\n`; a forced line break is U+2028. */
  text: string;
  runs: TypeRun[];
  paragraphs: TypeParagraph[];
  frame: TypeFrame;
  warp: TypeWarp;
  antialias?: string;
}

export type TypeFrame =
  | { kind: "point"; x: number; y: number }
  | { kind: "box"; x: number; y: number; width: number; height: number };

export interface TypeRun {
  /** UTF-16 code units of `text`. */
  length: number;
  font: string;
  style?: string | null;
  postscript?: string | null;
  /** Canvas px. */
  size: number;
  color: [number, number, number];
  tracking?: number;
  leading?: number | null;
  baselineShift?: number;
  horizontalScale?: number;
  verticalScale?: number;
  underline?: boolean;
  strikethrough?: boolean;
  ligatures?: boolean;
  caps?: "normal" | "smallCaps" | "allCaps";
  position?: "normal" | "superscript" | "subscript";
  fauxBold?: boolean;
  fauxItalic?: boolean;
}

export type TypeAlign =
  | "left"
  | "center"
  | "right"
  | "justifyLeft"
  | "justifyCenter"
  | "justifyRight"
  | "justifyAll";

export interface TypeParagraph {
  align: TypeAlign;
  hyphenate?: boolean;
  firstLineIndent?: number;
  leftIndent?: number;
  rightIndent?: number;
  spaceBefore?: number;
  spaceAfter?: number;
}

/** Photoshop's fifteen Warp Text styles (paged-warp's names). */
export const WARP_STYLES = [
  "none",
  "arc",
  "arcLower",
  "arcUpper",
  "arch",
  "bulge",
  "shellLower",
  "shellUpper",
  "flag",
  "wave",
  "fish",
  "rise",
  "fishEye",
  "inflate",
  "squeeze",
  "twist",
] as const;
export type WarpStyle = (typeof WARP_STYLES)[number];

export interface TypeWarp {
  style: WarpStyle;
  /** −1 to 1 (Photoshop's −100 % to 100 %). */
  bend: number;
  horizontal: number;
  vertical: number;
  rotateVertical?: boolean;
}

export const NO_WARP: TypeWarp = {
  style: "none",
  bend: 0,
  horizontal: 0,
  vertical: 0,
};

/** The largest frame side, in engine pt, a story is drawn at (beyond it
 *  the dpi grows instead). */
export const MAX_FRAME_PT = 1000;

const JUSTIFICATION: Record<TypeAlign, string> = {
  left: "LeftAlign",
  center: "CenterAlign",
  right: "RightAlign",
  justifyLeft: "LeftJustified",
  justifyCenter: "CenterJustified",
  justifyRight: "RightJustified",
  justifyAll: "FullyJustified",
};

/** A fresh one-run, one-paragraph source. */
export function newTypeSource(
  text: string,
  frame: TypeFrame,
  run: Omit<TypeRun, "length">,
  align: TypeAlign = "left",
): TypeSource {
  return {
    text,
    runs: [{ ...run, length: utf16Length(text) }],
    paragraphs: [{ align, hyphenate: true }],
    frame,
    warp: { ...NO_WARP },
  };
}

export function utf16Length(s: string): number {
  return s.length;
}

/** The runs, cut to `text`, the last one stretched over the rest — so a
 *  text edit keeps every run's style. */
export function fitRuns(runs: readonly TypeRun[], text: string): TypeRun[] {
  const total = utf16Length(text);
  const out: TypeRun[] = [];
  let left = total;
  for (const r of runs) {
    if (left <= 0) break;
    const n = Math.min(r.length, left);
    if (n <= 0) continue;
    out.push({ ...r, length: n });
    left -= n;
  }
  if (out.length === 0) {
    const base = runs[0] ?? DEFAULT_RUN;
    return [{ ...base, length: total }];
  }
  out[out.length - 1]!.length += left;
  return out;
}

export const DEFAULT_RUN: TypeRun = {
  length: 0,
  font: "Myriad Pro",
  style: "Regular",
  size: 48,
  color: [0, 0, 0],
};

/** The largest run size (px), for the point-type frame. */
function maxSize(runs: readonly TypeRun[]): number {
  return Math.max(1, ...runs.map((r) => r.size));
}

/** Where the frame the engine lays the text out in sits on the canvas
 *  (px), and the first baseline for point type. Point type has no width:
 *  it gets one wide enough for its longest paragraph, placed so the
 *  anchor is the alignment point of the first line. */
export function layoutBox(src: TypeSource): {
  left: number;
  top: number;
  width: number;
  height: number;
  firstBaseline: number | null;
} {
  const f = src.frame;
  if (f.kind === "box") {
    return {
      left: f.x,
      top: f.y,
      width: f.width,
      height: f.height,
      firstBaseline: null,
    };
  }
  const size = maxSize(src.runs);
  const paras = src.text.split("\n");
  const lines = src.text.split(/\n|\u2028/).length;
  const longest = Math.max(1, ...paras.map((p) => p.length));
  const spread = Math.max(
    1,
    ...src.runs.map(
      (r) =>
        (r.horizontalScale ?? 1) * (1 + Math.max(0, r.tracking ?? 0) / 1000),
    ),
  );
  // Generous: no face is wider than an em per character, and the frame
  // only has to be wide enough never to wrap.
  const width = Math.ceil(longest * size * spread + 2 * size);
  const leading = Math.max(size * 1.2, ...src.runs.map((r) => r.leading ?? 0));
  const firstBaseline = Math.ceil(size * 1.25);
  const height = Math.ceil(firstBaseline + (lines - 1) * leading + size);
  const align = src.paragraphs[0]?.align ?? "left";
  const left =
    align === "center" || align === "justifyCenter"
      ? f.x - width / 2
      : align === "right" || align === "justifyRight"
        ? f.x - width
        : f.x;
  return { left, top: f.y - firstBaseline, width, height, firstBaseline };
}

/** The scale `k` (canvas px per engine pt) a source is drawn at. */
export function drawScale(src: TypeSource): number {
  const b = layoutBox(src);
  return Math.max(1, Math.max(b.width, b.height) / MAX_FRAME_PT);
}

/** The story the engine draws for `src`: its frame at the origin, every
 *  length in engine pt (canvas px / `k`). */
export function storyOf(src: TypeSource, k: number): RenderStory {
  const b = layoutBox(src);
  const paraTexts = src.text.split("\n");
  const runs = fitRuns(src.runs, src.text);
  // Walk the runs over the text, cutting at paragraph marks.
  const paragraphs: RenderStoryParagraph[] = paraTexts.map((_, i) => {
    const p = src.paragraphs[i] ?? src.paragraphs.at(-1) ?? { align: "left" };
    return {
      runs: [],
      justification: JUSTIFICATION[p.align] ?? "LeftAlign",
      ...(p.hyphenate !== undefined ? { hyphenation: p.hyphenate } : {}),
      ...(p.firstLineIndent ? { firstLineIndent: p.firstLineIndent / k } : {}),
      ...(p.leftIndent ? { leftIndent: p.leftIndent / k } : {}),
      ...(p.rightIndent ? { rightIndent: p.rightIndent / k } : {}),
      ...(p.spaceBefore ? { spaceBefore: p.spaceBefore / k } : {}),
      ...(p.spaceAfter ? { spaceAfter: p.spaceAfter / k } : {}),
    };
  });
  let para = 0;
  let at = 0;
  for (const r of runs) {
    let piece = src.text.slice(at, at + r.length);
    at += r.length;
    const parts = piece.split("\n");
    parts.forEach((text, j) => {
      if (j > 0) para++;
      if (text.length > 0 && paragraphs[para]) {
        paragraphs[para]!.runs.push(storyRun(r, text, k));
      }
    });
    piece = "";
  }
  // An empty paragraph still has a line: a run with no text keeps its
  // size.
  paragraphs.forEach((p, i) => {
    if (p.runs.length === 0) {
      const r = runs[Math.min(i, runs.length - 1)] ?? DEFAULT_RUN;
      p.runs.push(storyRun(r, "", k));
    }
  });
  return {
    bounds: [0, 0, b.height / k, b.width / k],
    paragraphs,
    ...(b.firstBaseline !== null ? { firstBaseline: b.firstBaseline / k } : {}),
  };
}

function storyRun(r: TypeRun, text: string, k: number): RenderStoryRun {
  const caps =
    r.caps === "allCaps"
      ? "AllCaps"
      : r.caps === "smallCaps"
        ? "SmallCaps"
        : undefined;
  const position =
    r.position === "superscript"
      ? "Superscript"
      : r.position === "subscript"
        ? "Subscript"
        : undefined;
  return {
    text,
    font: r.font,
    ...(r.style ? { fontStyle: r.style } : {}),
    pointSize: r.size / k,
    ...(r.leading ? { leading: r.leading / k } : {}),
    fillRgb: r.color,
    ...(r.tracking ? { tracking: r.tracking } : {}),
    ...(r.baselineShift ? { baselineShift: r.baselineShift / k } : {}),
    ...(r.horizontalScale !== undefined && r.horizontalScale !== 1
      ? { horizontalScale: r.horizontalScale * 100 }
      : {}),
    ...(r.verticalScale !== undefined && r.verticalScale !== 1
      ? { verticalScale: r.verticalScale * 100 }
      : {}),
    ...(r.underline ? { underline: true } : {}),
    ...(r.strikethrough ? { strikethru: true } : {}),
    ...(r.ligatures === false ? { ligatures: false } : {}),
    ...(caps ? { capitalization: caps } : {}),
    ...(position ? { position } : {}),
  };
}

/**
 * Lay out and draw `src` through the engine, on page `pageId` (any page
 * of the document: the story is drawn alone, the document is not
 * changed). `null` when the host has no story door, or nothing is drawn
 * (an empty text): the caller keeps the layer's pixels as they are.
 */
export async function renderTypeSource(
  host: BundleHost,
  pageId: string,
  src: TypeSource,
): Promise<TypeRenderPixels | null> {
  if (!host.supports("render.story@1")) return null;
  const k = drawScale(src);
  const story = storyOf(src, k);
  const b = layoutBox(src);
  // Margin: an italic's overhang, a descender below a box's last line.
  const marginPt = Math.ceil(maxSize(src.runs) / k);
  const shot = await host.render.story(pageId, story, {
    dpi: Math.min(2400, 72 * k),
    format: "rgba",
    marginPt,
  });
  if (!shot?.rgba) return null;
  return {
    rgba: shot.rgba,
    x: Math.round(b.left + shot.region.x * k),
    y: Math.round(b.top + shot.region.y * k),
    width: shot.widthPx,
    height: shot.heightPx,
  };
}

/** A transparent 1 × 1 render at the frame: what an empty text draws. */
export function emptyRender(src: TypeSource): TypeRenderPixels {
  return {
    rgba: new Uint8Array(4),
    x: Math.round(src.frame.x),
    y: Math.round(src.frame.y),
    width: 1,
    height: 1,
  };
}

/** Does canvas point `(x, y)` fall on `src`'s text (its layout box,
 *  grown by half the size)? The type tool's hit test. */
export function hitsType(src: TypeSource, x: number, y: number): boolean {
  const b = layoutBox(src);
  const pad = maxSize(src.runs) / 2;
  if (src.frame.kind === "point") {
    // A point frame is wide on purpose; hit the text's likely extent.
    const size = maxSize(src.runs);
    const longest = Math.max(1, ...src.text.split("\n").map((p) => p.length));
    const w = longest * size * 0.6;
    const align = src.paragraphs[0]?.align ?? "left";
    const left =
      align === "center" || align === "justifyCenter"
        ? src.frame.x - w / 2
        : align === "right" || align === "justifyRight"
          ? src.frame.x - w
          : src.frame.x;
    return (
      x >= left - pad &&
      x <= left + w + pad &&
      y >= b.top - pad &&
      y <= b.top + b.height + pad
    );
  }
  return (
    x >= b.left - pad &&
    x <= b.left + b.width + pad &&
    y >= b.top - pad &&
    y <= b.top + b.height + pad
  );
}
