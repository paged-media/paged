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

// Engine ADR 1011 — artboards: the editor's view of pages placed freely on
// the canvas. Pure geometry and the reads every artboard surface shares
// (the Artboard tool, the Artboards panel, export per artboard): where
// each board sits, its name, snapping a moved or resized board to the
// others' edges, and the rearrange-all grid. Mutations are the engine's
// `placePage` (where), `resizePage` (how big) and `movePage` (the order).

/** One artboard: a page with its place on the canvas. */
export interface Artboard {
  pageId: string;
  /** 1-based page index. */
  index: number;
  /** The board's name: its own (`ARTBOARD_META_KEY`), else a default. */
  name: string;
  /** Whether the name is the board's own. */
  named: boolean;
  /** Top-left on the canvas, pt. */
  x: number;
  y: number;
  /** Size, pt. */
  w: number;
  h: number;
  /** The page's GeometricBounds `[top, left, bottom, right]` (page-inner
   *  pt), what `resizePage` writes; null from an older engine. */
  bounds: [number, number, number, number] | null;
  /** Placed on the canvas (false: the default stacked slot). */
  placed: boolean;
}

/** The page metadata entry an artboard's name lives in (a Label on the
 *  page: it travels with the page through move, duplicate, `.paged` and
 *  an IDML round trip). Value: the plugin-metadata envelope
 *  `{"v":1,"data":{"name":"…"}}`. */
export const ARTBOARD_META_KEY = "x-paged:paged.artboard";

/** The default gap between boards, pt (the canvas stack's). */
export const ARTBOARD_GAP_PT = 24;

/** The smallest board, pt. */
export const MIN_ARTBOARD_PT = 18;

/** The shape of a `pages` collection item this module reads. */
export interface PageSummaryLike {
  selfId: string;
  index?: number;
  sizePt: readonly [number, number] | number[];
  canvasOriginPt?: readonly [number, number] | number[] | null;
  canvasPlaced?: boolean;
  boundsPt?: readonly [number, number, number, number] | number[] | null;
  pluginMetadata?: ReadonlyArray<{ key: string; value: string }> | null;
}

/** The name stored in a page's metadata, or null. */
export function artboardNameOf(page: PageSummaryLike): string | null {
  const entry = page.pluginMetadata?.find((e) => e.key === ARTBOARD_META_KEY);
  if (!entry) return null;
  try {
    const parsed = JSON.parse(entry.value) as { data?: { name?: unknown } };
    const name = parsed?.data?.name;
    return typeof name === "string" && name.trim() ? name : null;
  } catch {
    return null;
  }
}

/** The metadata envelope for a board's name. */
export function artboardNameEnvelope(name: string): string {
  return JSON.stringify({ v: 1, data: { name } });
}

/** The `setPageMetadata` mutation that names a board (an empty name
 *  removes the entry: the board takes its default name again). */
export function renameArtboardMutation(pageId: string, name: string) {
  const trimmed = name.trim();
  return {
    op: "setPageMetadata" as const,
    args: {
      page: pageId,
      key: ARTBOARD_META_KEY,
      value: trimmed ? artboardNameEnvelope(trimmed) : null,
    },
  };
}

/** The `placePage` mutation. */
export function placeArtboardMutation(
  pageId: string,
  at: readonly [number, number] | null,
) {
  return {
    op: "placePage" as const,
    args: {
      page: pageId,
      originPt: at ? ([round(at[0]), round(at[1])] as [number, number]) : null,
    },
  };
}

/** Quarter-point precision: the canvas has no use for float noise. */
function round(v: number): number {
  return Math.round(v * 4) / 4;
}

/**
 * The boards of a `pages` collection, in page order. `defaultName(i)`
 * names a board that has no name of its own (1-based index). Without
 * canvas origins (an older engine) the boards stack as the canvas does.
 */
export function artboardsOf(
  pages: readonly PageSummaryLike[],
  defaultName: (index: number) => string,
): Artboard[] {
  let y = 0;
  return pages.map((p, i) => {
    const [w, h] = [Number(p.sizePt[0]), Number(p.sizePt[1])];
    const origin = p.canvasOriginPt;
    const at: [number, number] = origin
      ? [Number(origin[0]), Number(origin[1])]
      : [0, y];
    y += h + ARTBOARD_GAP_PT;
    const own = artboardNameOf(p);
    const b = p.boundsPt;
    return {
      pageId: p.selfId,
      index: p.index ?? i + 1,
      name: own ?? defaultName(i + 1),
      named: own !== null,
      x: at[0],
      y: at[1],
      w,
      h,
      bounds: b
        ? [Number(b[0]), Number(b[1]), Number(b[2]), Number(b[3])]
        : null,
      placed: p.canvasPlaced ?? false,
    };
  });
}

/** A rectangle on the canvas, pt. */
export interface CanvasRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The handle a resize grabs: which edges move. */
export interface HandleEdges {
  left: boolean;
  right: boolean;
  top: boolean;
  bottom: boolean;
}

export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const HANDLE_IDS: readonly HandleId[] = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
];

export function edgesOf(id: HandleId): HandleEdges {
  return {
    left: id.includes("w"),
    right: id.includes("e"),
    top: id.includes("n"),
    bottom: id.includes("s"),
  };
}

/** Where handle `id` of `r` sits, pt. */
export function handlePoint(r: CanvasRect, id: HandleId): [number, number] {
  const e = edgesOf(id);
  const x = e.left ? r.x : e.right ? r.x + r.w : r.x + r.w / 2;
  const y = e.top ? r.y : e.bottom ? r.y + r.h : r.y + r.h / 2;
  return [x, y];
}

/** The handle of `r` within `tolPt` of `p`, or null. */
export function handleAt(
  r: CanvasRect,
  p: readonly [number, number],
  tolPt: number,
): HandleId | null {
  let best: HandleId | null = null;
  let bestD = tolPt;
  for (const id of HANDLE_IDS) {
    const [hx, hy] = handlePoint(r, id);
    const d = Math.max(Math.abs(hx - p[0]), Math.abs(hy - p[1]));
    if (d <= bestD) {
      best = id;
      bestD = d;
    }
  }
  return best;
}

/** The board containing canvas point `p` (the topmost: the last one). */
export function artboardAt(
  boards: readonly Artboard[],
  p: readonly [number, number],
): Artboard | null {
  for (let i = boards.length - 1; i >= 0; i--) {
    const b = boards[i];
    if (p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h)
      return b;
  }
  return null;
}

/** One axis' snap: the offset to add, and the guide coordinate (null: no
 *  snap). */
interface AxisSnap {
  delta: number;
  at: number | null;
}

function snapAxis(
  moving: readonly number[],
  targets: readonly number[],
  tol: number,
): AxisSnap {
  let best: AxisSnap = { delta: 0, at: null };
  let bestD = tol;
  for (const m of moving) {
    for (const t of targets) {
      const d = Math.abs(t - m);
      if (d <= bestD) {
        bestD = d;
        best = { delta: t - m, at: t };
      }
    }
  }
  return best;
}

/** The result of snapping a board: the snapped rect and the guide lines
 *  it snapped to (canvas x for vertical guides, y for horizontal). */
export interface SnappedRect {
  rect: CanvasRect;
  guideX: number | null;
  guideY: number | null;
}

function targetsOf(others: readonly CanvasRect[]) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const o of others) {
    xs.push(o.x, o.x + o.w / 2, o.x + o.w);
    ys.push(o.y, o.y + o.h / 2, o.y + o.h);
    // Abutting at the default gap reads as "next to it".
    xs.push(o.x - ARTBOARD_GAP_PT, o.x + o.w + ARTBOARD_GAP_PT);
    ys.push(o.y - ARTBOARD_GAP_PT, o.y + o.h + ARTBOARD_GAP_PT);
  }
  return { xs, ys };
}

/** Snap a MOVED board's edges and centre to the other boards' edges,
 *  centres and default-gap neighbours, within `tolPt`. */
export function snapMove(
  r: CanvasRect,
  others: readonly CanvasRect[],
  tolPt: number,
): SnappedRect {
  const { xs, ys } = targetsOf(others);
  // A board's own edge snaps to an edge; the gap targets pair with the
  // opposite edge (left edge to a neighbour's right + gap).
  const sx = snapAxis([r.x, r.x + r.w / 2, r.x + r.w], xs, tolPt);
  const sy = snapAxis([r.y, r.y + r.h / 2, r.y + r.h], ys, tolPt);
  return {
    rect: { ...r, x: r.x + sx.delta, y: r.y + sy.delta },
    guideX: sx.at,
    guideY: sy.at,
  };
}

/**
 * Resize `start` by dragging handle `id` by (`dx`, `dy`), the moving
 * edges snapped to the other boards, never smaller than
 * `MIN_ARTBOARD_PT`. The opposite edges stay put.
 */
export function resizeRect(
  start: CanvasRect,
  id: HandleId,
  dx: number,
  dy: number,
  others: readonly CanvasRect[],
  tolPt: number,
): SnappedRect {
  const e = edgesOf(id);
  const { xs, ys } = targetsOf(others);
  let left = start.x;
  let right = start.x + start.w;
  let top = start.y;
  let bottom = start.y + start.h;
  let guideX: number | null = null;
  let guideY: number | null = null;
  if (e.left) {
    const s = snapAxis([left + dx], xs, tolPt);
    left = Math.min(left + dx + s.delta, right - MIN_ARTBOARD_PT);
    guideX = s.at;
  }
  if (e.right) {
    const s = snapAxis([right + dx], xs, tolPt);
    right = Math.max(right + dx + s.delta, left + MIN_ARTBOARD_PT);
    guideX = s.at;
  }
  if (e.top) {
    const s = snapAxis([top + dy], ys, tolPt);
    top = Math.min(top + dy + s.delta, bottom - MIN_ARTBOARD_PT);
    guideY = s.at;
  }
  if (e.bottom) {
    const s = snapAxis([bottom + dy], ys, tolPt);
    bottom = Math.max(bottom + dy + s.delta, top + MIN_ARTBOARD_PT);
    guideY = s.at;
  }
  return {
    rect: { x: left, y: top, w: right - left, h: bottom - top },
    guideX,
    guideY,
  };
}

/**
 * The mutations that make board `b` the rect `to` with its content
 * staying where it is on the canvas: `resizePage` moves the page's edges
 * in its own coordinates (the content keeps its coordinates) and
 * `placePage` moves its top-left by the same amount. One batch, one undo
 * step. Null when nothing changes or the page bounds are unknown.
 */
export function resizeArtboardMutation(b: Artboard, to: CanvasRect) {
  if (!b.bounds) return null;
  const dl = to.x - b.x;
  const dt = to.y - b.y;
  if (dl === 0 && dt === 0 && to.w === b.w && to.h === b.h) return null;
  const [top, left] = b.bounds;
  // Edges to 1/100 pt: a preset's size (A4's 595.28) survives as typed.
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const bounds: [number, number, number, number] = [
    r2(top + dt),
    r2(left + dl),
    r2(top + dt + to.h),
    r2(left + dl + to.w),
  ];
  const ops: Array<Record<string, unknown>> = [
    { op: "resizePage", args: { pageId: b.pageId, bounds } },
  ];
  if (dl !== 0 || dt !== 0 || b.placed) {
    ops.push(placeArtboardMutation(b.pageId, [to.x, to.y]));
  }
  return { op: "batch" as const, args: { ops } };
}

/**
 * Rearrange every board into a grid of `columns` columns, `spacingPt`
 * apart, in page order, starting at the first board's place. Each row is
 * as tall as its tallest board; each column as wide as its widest.
 */
export function gridLayout(
  boards: readonly Artboard[],
  columns: number,
  spacingPt: number,
): Array<[number, number]> {
  const cols = Math.max(1, Math.floor(columns));
  const gap = Math.max(0, spacingPt);
  const colW: number[] = [];
  const rowH: number[] = [];
  boards.forEach((b, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    colW[c] = Math.max(colW[c] ?? 0, b.w);
    rowH[r] = Math.max(rowH[r] ?? 0, b.h);
  });
  const x0 = boards[0]?.x ?? 0;
  const y0 = boards[0]?.y ?? 0;
  return boards.map((_, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    let x = x0;
    for (let k = 0; k < c; k++) x += colW[k] + gap;
    let y = y0;
    for (let k = 0; k < r; k++) y += rowH[k] + gap;
    return [x, y];
  });
}

/** The batch that rearranges every board (one undo step). */
export function rearrangeMutation(
  boards: readonly Artboard[],
  columns: number,
  spacingPt: number,
) {
  const at = gridLayout(boards, columns, spacingPt);
  return {
    op: "batch" as const,
    args: { ops: boards.map((b, i) => placeArtboardMutation(b.pageId, at[i])) },
  };
}

/** Size presets for Artboard options, pt, in their natural orientation
 *  (the orientation control swaps width and height). */
export const ARTBOARD_PRESETS: ReadonlyArray<{
  id: string;
  label: string;
  w: number;
  h: number;
}> = [
  { id: "a4", label: "A4", w: 595.28, h: 841.89 },
  { id: "a3", label: "A3", w: 841.89, h: 1190.55 },
  { id: "a5", label: "A5", w: 419.53, h: 595.28 },
  { id: "letter", label: "Letter", w: 612, h: 792 },
  { id: "legal", label: "Legal", w: 612, h: 1008 },
  { id: "tabloid", label: "Tabloid", w: 792, h: 1224 },
  // Screen sizes at 1 px = 1 pt (Illustrator's web presets).
  { id: "hd", label: "1920 × 1080", w: 1920, h: 1080 },
  { id: "square", label: "1080 × 1080", w: 1080, h: 1080 },
  { id: "story", label: "1080 × 1920", w: 1080, h: 1920 },
];

/** A file name for a board's export: its name, made safe for a file
 *  system, unique among `taken` (which it extends). */
export function artboardFileName(
  name: string,
  ext: string,
  taken: Set<string>,
): string {
  const base =
    name
      .normalize("NFC")
      // eslint-disable-next-line no-control-regex -- control characters are what a file name must not carry
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "") || "artboard";
  let file = `${base}.${ext}`;
  for (let n = 2; taken.has(file.toLowerCase()); n++) {
    file = `${base} ${n}.${ext}`;
  }
  taken.add(file.toLowerCase());
  return file;
}
