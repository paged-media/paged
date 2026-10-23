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

// The frame surface's painter (sheet ADR 510, extensions ADR 334): a
// GridScene drawn onto a Canvas2D context, with Excel's row and column
// headings INSIDE the frame. Pure: it reads the scene and draws; the
// windowing, the selection and every value come from the engine. The
// coordinate space is frame-content points (the surface scales the
// context by pxPerPt × devicePixelRatio before calling).

import {
  cellRect,
  colAt,
  colPos,
  DEFAULT_GRID_SVG_OPTIONS,
  fillHandleRect,
  rowAt,
  selectionRect,
  type GridScene,
  type GridSvgOptions,
} from "./grid";
import type { Align, BorderLine, LoweredStyle } from "./lowered";

/** The part of CanvasRenderingContext2D the painter uses (so a test can
 *  record the calls). */
export interface PaintContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  beginPath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  /** Text measurement (a real canvas has it): needed to wrap text and to
   *  draw underlines; without it wrapped text is drawn on one line. */
  measureText?(text: string): { width: number };
  /** Dash pattern for dashed/dotted borders (a real canvas has it). */
  setLineDash?(segments: number[]): void;
}

/** Heading strip sizes and colours. */
export interface HeadingStyle {
  /** Column-heading strip height, pt. */
  colHeightPt: number;
  fontSizePt: number;
  fontFamily: string;
  background: string;
  activeBackground: string;
  text: string;
  activeText: string;
  rule: string;
}

export const DEFAULT_HEADING_STYLE: HeadingStyle = {
  colHeightPt: 16,
  fontSizePt: 8.5,
  fontFamily: "sans-serif",
  background: "#f3f3f1",
  activeBackground: "#dfe7f1",
  text: "#5b5b57",
  activeText: "#1f4f8a",
  rule: "#c9c9c4",
};

/** The row-heading strip width for a window starting at `topRow` (0-based):
 *  wide enough for the row numbers a few screens further down, so it does
 *  not change width on every scroll step. */
export function rowHeadingWidthPt(
  topRow: number,
  style: HeadingStyle = DEFAULT_HEADING_STYLE,
): number {
  const digits = String(topRow + 200).length;
  return Math.max(26, 8 + digits * style.fontSizePt * 0.62);
}

/** 0-based column index → letters (0 → A, 26 → AA). */
export function columnLetters(index: number): string {
  let n = index;
  let label = "";
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

export interface PaintOptions {
  /** Draw the heading strips (true while editing). */
  headings: boolean;
  /** Row-heading strip width (pt); see {@link rowHeadingWidthPt}. */
  rowHeadingWidthPt: number;
  /** The surface's full size (pt); the background fills it. */
  widthPt: number;
  heightPt: number;
  /** The first track past the print edge that is partly visible is drawn
   *  under a light wash (ADR 510); its sheet column index, or null. Absent:
   *  the scene's own `viewport.partialCol`. */
  partialCol?: number | null;
  grid?: Partial<GridSvgOptions>;
  heading?: Partial<HeadingStyle>;
}

/** One text box to draw: a cell or a merged area. */
interface TextBox {
  text: string;
  /** The repeat-fill character (`text` holds a TAB where it stands). */
  fill?: string;
  align: Align;
  styleKey: number;
  wrap: boolean;
  vAlign?: string;
  /** The box (viewport-local pt). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The horizontal extent the text may be drawn in (overflow). */
  clipX0: number;
  clipX1: number;
}

/** Canvas dash pattern for an xlsx border style. */
function dashFor(style: string): number[] {
  if (style.includes("dashDotDot")) return [3, 1, 1, 1, 1, 1];
  if (style.includes("dashDot")) return [3, 1, 1, 1];
  if (style.includes("ashed")) return [3, 1.5];
  if (style === "dotted" || style === "hair") return [1, 1];
  return [];
}

/** Split `text` into lines that fit `width` (word wrap, Excel-like: break
 *  at spaces, hard breaks on newlines, an over-long word stays whole). */
function wrapLines(ctx: PaintContext, text: string, width: number): string[] {
  const measure = ctx.measureText?.bind(ctx);
  if (!measure) return [text.replace(/\n/g, " ")];
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next).width > width) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** One line of a repeat-filled cell (`*x` in its number format): `head` at
 *  the left edge, `tail` right-aligned at the right edge, `fill` repeated in
 *  the free width between (as many whole copies as fit, as Excel draws). */
function paintFilled(
  ctx: PaintContext,
  b: TextBox,
  fill: string,
  y: number,
  pad: number,
): void {
  const tab = b.text.indexOf("\t");
  const head = b.text.slice(0, tab);
  const tail = b.text.slice(tab + 1);
  const x0 = b.x0 + pad;
  const x1 = b.x1 - pad;
  ctx.textAlign = "left";
  ctx.fillText(head, x0, y);
  ctx.textAlign = "right";
  ctx.fillText(tail, x1, y);
  const measure = ctx.measureText?.bind(ctx);
  if (!measure || fill === " ") return;
  const unit = measure(fill).width;
  const from = x0 + measure(head).width;
  const to = x1 - measure(tail).width;
  if (unit <= 0 || to - from < unit) return;
  const n = Math.floor((to - from) / unit);
  ctx.textAlign = "left";
  ctx.fillText(fill.repeat(n), from, y);
}

/** Draw `scene` onto `ctx` in frame-content points. */
export function paintGridScene(
  ctx: PaintContext,
  scene: GridScene,
  options: PaintOptions,
): void {
  const g: GridSvgOptions = { ...DEFAULT_GRID_SVG_OPTIONS, ...options.grid };
  const h: HeadingStyle = { ...DEFAULT_HEADING_STYLE, ...options.heading };
  const vp = scene.viewport;
  const xs = vp.xOffsets;
  const ys = vp.yOffsets;
  const cellW = xs[xs.length - 1] ?? 0;
  const cellH = ys[ys.length - 1] ?? 0;
  const ox = options.headings ? options.rowHeadingWidthPt : 0;
  const oy = options.headings ? h.colHeightPt : 0;
  const sel = scene.selection ?? null;
  const inSelCols = (c: number) =>
    sel !== null && c >= sel.anchorCol && c < sel.anchorCol + sel.cols;
  const inSelRows = (r: number) =>
    sel !== null && r >= sel.anchorRow && r < sel.anchorRow + sel.rows;
  const styleOf = (key: number): LoweredStyle | undefined =>
    scene.styles[key]?.key === key
      ? scene.styles[key]
      : scene.styles.find((s) => s.key === key);

  // Background: the cells are opaque over the frame's page content.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, options.widthPt, options.heightPt);

  ctx.save();
  ctx.translate(ox, oy);
  ctx.beginPath();
  ctx.rect(
    0,
    0,
    Math.max(options.widthPt - ox, 0),
    Math.max(options.heightPt - oy, 0),
  );
  ctx.clip();

  // The boxes to paint: every shown cell, then every merged area.
  const boxes: TextBox[] = [];
  for (const cell of scene.cells) {
    const r = cellRect(vp, cell.row, cell.col);
    if (!r) continue;
    const [x, y, w, hh] = r;
    let clipX0 = x;
    let clipX1 = x + w;
    if (cell.overflowTo !== undefined) {
      const to = colPos(vp, cell.overflowTo);
      if (to >= 0 && cell.overflowTo > cell.col) clipX1 = xs[to + 1];
      if (to >= 0 && cell.overflowTo < cell.col) clipX0 = xs[to];
    }
    boxes.push({
      text: cell.text,
      fill: cell.fill,
      align: cell.align,
      styleKey: cell.styleKey ?? 0,
      wrap: cell.wrap ?? false,
      vAlign: cell.vAlign,
      x0: x,
      y0: y,
      x1: x + w,
      y1: y + hh,
      clipX0,
      clipX1,
    });
  }
  for (const m of scene.merges ?? []) {
    boxes.push({
      text: m.text,
      fill: m.fill,
      align: m.align,
      styleKey: m.styleKey,
      wrap: m.wrap ?? false,
      vAlign: m.vAlign,
      x0: m.x,
      y0: m.y,
      x1: m.x + m.w,
      y1: m.y + m.h,
      clipX0: m.x,
      clipX1: m.x + m.w,
    });
  }

  // Cell fills from the style table.
  for (const b of boxes) {
    const fill = styleOf(b.styleKey)?.fillRgb;
    if (!fill) continue;
    ctx.fillStyle = fill;
    ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
  }

  // Data bars under the text.
  for (const bar of scene.databars ?? []) {
    ctx.fillStyle = bar.fill;
    ctx.fillRect(bar.x, bar.y, bar.w, bar.h);
  }

  // Gridlines (the engine already broke them around merged areas). A
  // filled cell covers the gridlines along its edges, as in Excel.
  ctx.strokeStyle = g.gridColor;
  ctx.lineWidth = g.gridWidth;
  ctx.beginPath();
  for (const r of scene.gridlines.h) {
    ctx.moveTo(r.from, r.at);
    ctx.lineTo(r.to, r.at);
  }
  for (const r of scene.gridlines.v) {
    ctx.moveTo(r.at, r.from);
    ctx.lineTo(r.at, r.to);
  }
  ctx.stroke();

  // Cell borders: the per-edge lines (style, weight, colour) when the style
  // carries them, else the presence flags as a thin dark line.
  const edge = (
    line: BorderLine | undefined,
    flag: boolean | undefined,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ) => {
    if (!line && !flag) return;
    ctx.strokeStyle = line?.rgb ?? g.textColor;
    ctx.lineWidth = line?.weightPt ?? 0.75;
    ctx.setLineDash?.(line ? dashFor(line.style) : []);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };
  for (const b of boxes) {
    const st = styleOf(b.styleKey);
    if (!st) continue;
    const bl = st.borderLines;
    edge(bl?.top, st.borderTop, b.x0, b.y0, b.x1, b.y0);
    edge(bl?.bottom, st.borderBottom, b.x0, b.y1, b.x1, b.y1);
    edge(bl?.left, st.borderLeft, b.x0, b.y0, b.x0, b.y1);
    edge(bl?.right, st.borderRight, b.x1, b.y0, b.x1, b.y1);
  }
  ctx.setLineDash?.([]);

  // Cell text, aligned in its box, clipped to the box (or to the empty
  // neighbours it overflows into), wrapped when the style says so.
  ctx.textBaseline = "alphabetic";
  for (const b of boxes) {
    if (!b.text) continue;
    const st = styleOf(b.styleKey);
    const size = st?.fontSizePt ?? g.fontSizePt;
    const family = st?.fontName
      ? `"${st.fontName}", ${g.fontFamily}`
      : g.fontFamily;
    ctx.font = `${st?.italic ? "italic " : ""}${st?.bold ? "bold " : ""}${size}px ${family}`;
    const color = st?.textRgb ?? g.textColor;
    ctx.fillStyle = color;
    const align =
      b.align === "right" ? "right" : b.align === "center" ? "center" : "left";
    ctx.textAlign = align;
    const tx =
      align === "right"
        ? b.x1 - g.pad
        : align === "center"
          ? (b.x0 + b.x1) / 2
          : b.x0 + g.pad;
    const lines = b.wrap
      ? wrapLines(ctx, b.text, Math.max(b.x1 - b.x0 - 2 * g.pad, 1))
      : [b.text];
    const lead = size * 1.2;
    const block = lead * (lines.length - 1);
    const vAlign = b.vAlign ?? st?.vAlign;
    // Excel's default vertical alignment is bottom.
    const firstY =
      vAlign === "top"
        ? b.y0 + size + 1
        : vAlign === "center"
          ? (b.y0 + b.y1 + size * 0.7) / 2 - block / 2
          : b.y1 - 3.5 - block;
    ctx.save();
    ctx.beginPath();
    ctx.rect(b.clipX0, b.y0, b.clipX1 - b.clipX0, b.y1 - b.y0);
    ctx.clip();
    if (b.fill !== undefined && b.text.includes("\t")) {
      // A repeat fill (`*x`): the part before the fill at the left edge, the
      // part after at the right edge, the character repeated between.
      paintFilled(ctx, b, b.fill, firstY, g.pad);
      ctx.restore();
      continue;
    }
    lines.forEach((line, i) => {
      const ty = firstY + i * lead;
      ctx.fillText(line, tx, ty);
      if (st?.underline && ctx.measureText) {
        const w = ctx.measureText(line).width;
        const ux =
          align === "right" ? tx - w : align === "center" ? tx - w / 2 : tx;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(size / 16, 0.5);
        ctx.beginPath();
        ctx.moveTo(ux, ty + size * 0.12);
        ctx.lineTo(ux + w, ty + size * 0.12);
        ctx.stroke();
      }
    });
    ctx.restore();
  }

  // The frozen split: a heavier rule after the pinned tracks.
  const fz = scene.freeze ?? null;
  if (fz) {
    ctx.strokeStyle = g.freezeColor;
    ctx.lineWidth = g.freezeWidth;
    ctx.beginPath();
    if ((vp.frozenRows ?? 0) > 0) {
      ctx.moveTo(0, fz.frozenHeightPt);
      ctx.lineTo(cellW, fz.frozenHeightPt);
    }
    if ((vp.frozenCols ?? 0) > 0) {
      ctx.moveTo(fz.frozenWidthPt, 0);
      ctx.lineTo(fz.frozenWidthPt, cellH);
    }
    ctx.stroke();
  }

  // The partly visible track past the print edge (it does not reach the page).
  const partialCol =
    options.partialCol !== undefined ? options.partialCol : vp.partialCol;
  if (partialCol !== undefined && partialCol !== null) {
    ctx.fillStyle = "rgba(120,120,120,0.10)";
    ctx.fillRect(cellW, 0, Math.max(options.widthPt - ox - cellW, 0), cellH);
  }

  // Selection wash + outline, the fill handle, the fill-drag target.
  const sr = selectionRect(scene);
  if (sr) {
    const [x0, y0, w, hh] = sr;
    ctx.fillStyle = g.selectionFill;
    ctx.fillRect(x0, y0, w, hh);
    ctx.strokeStyle = g.selectionColor;
    ctx.lineWidth = g.selectionWidth;
    ctx.strokeRect(x0, y0, w, hh);
    const knob = fillHandleRect(scene);
    if (knob) {
      ctx.fillStyle = g.selectionColor;
      ctx.fillRect(knob[0], knob[1], knob[2], knob[3]);
    }
  }
  const fp = scene.fillPreview
    ? selectionRect({ ...scene, selection: scene.fillPreview })
    : null;
  if (fp) {
    ctx.strokeStyle = g.selectionColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(fp[0], fp[1], fp[2], fp[3]);
  }
  ctx.restore();

  if (!options.headings) return;

  // Column headings across the top, row headings down the left, the
  // select-all corner where they meet. Active tracks are highlighted.
  ctx.font = `${h.fontSizePt}px ${h.fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = h.background;
  ctx.fillRect(0, 0, options.widthPt, oy);
  ctx.fillRect(0, 0, ox, options.heightPt);
  for (let i = 0; i < vp.cols; i++) {
    const c = colAt(vp, i);
    const x0 = ox + xs[i];
    const x1 = ox + xs[i + 1];
    if (inSelCols(c)) {
      ctx.fillStyle = h.activeBackground;
      ctx.fillRect(x0, 0, x1 - x0, oy);
    }
    ctx.fillStyle = inSelCols(c) ? h.activeText : h.text;
    ctx.fillText(columnLetters(c), (x0 + x1) / 2, oy / 2);
  }
  for (let i = 0; i < vp.rows; i++) {
    const r = rowAt(vp, i);
    const y0 = oy + ys[i];
    const y1 = oy + ys[i + 1];
    if (inSelRows(r)) {
      ctx.fillStyle = h.activeBackground;
      ctx.fillRect(0, y0, ox, y1 - y0);
    }
    ctx.fillStyle = inSelRows(r) ? h.activeText : h.text;
    ctx.fillText(String(r + 1), ox / 2, (y0 + y1) / 2);
  }
  ctx.strokeStyle = h.rule;
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(0, oy);
  ctx.lineTo(options.widthPt, oy);
  ctx.moveTo(ox, 0);
  ctx.lineTo(ox, options.heightPt);
  for (let i = 1; i <= vp.cols; i++) {
    ctx.moveTo(ox + xs[i], 0);
    ctx.lineTo(ox + xs[i], oy);
  }
  for (let i = 1; i <= vp.rows; i++) {
    ctx.moveTo(0, oy + ys[i]);
    ctx.lineTo(ox, oy + ys[i]);
  }
  ctx.stroke();
}
