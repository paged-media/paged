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
import type {
  Align,
  BorderLine,
  FillGradient,
  FillPattern,
  LoweredRun,
  LoweredStyle,
} from "./lowered";

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
  /** Filled polygons (W2.4 icons; without them icons are not drawn). */
  fill?(): void;
  closePath?(): void;
  /** Rotated text (W2.2; without it rotated text is drawn upright). */
  rotate?(angle: number): void;
  /** Gradient fills (W2.2; without them the mean colour is drawn). */
  createLinearGradient?(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): CanvasGradient;
  createRadialGradient?(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): CanvasGradient;
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
  /** Rich-text runs (W2.2). */
  runs?: LoweredRun[];
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

/** A font shorthand for a style at `size`. */
function fontOf(
  st: LoweredStyle | undefined,
  size: number,
  g: GridSvgOptions,
): string {
  const family = st?.fontName
    ? `"${st.fontName}", ${g.fontFamily}`
    : g.fontFamily;
  return `${st?.italic ? "italic " : ""}${st?.bold ? "bold " : ""}${size}px ${family}`;
}

/** The size a style draws at and its baseline shift (super/subscript draw
 *  at 65 % of the size, raised by a third / lowered by a seventh). */
function sizeOf(
  st: LoweredStyle | undefined,
  g: GridSvgOptions,
): { size: number; shift: number } {
  const base = st?.fontSizePt ?? g.fontSizePt;
  if (st?.vertAlign === "superscript")
    return { size: base * 0.65, shift: -base * 0.33 };
  if (st?.vertAlign === "subscript")
    return { size: base * 0.65, shift: base * 0.14 };
  return { size: base, shift: 0 };
}

/** Underline and strike-through of a drawn line of text from `x` to
 *  `x + w` at baseline `y`. */
function decorate(
  ctx: PaintContext,
  st: LoweredStyle | undefined,
  x: number,
  y: number,
  w: number,
  size: number,
  color: string,
): void {
  const lines: number[] = [];
  if (st?.underline) {
    lines.push(y + size * 0.12);
    if (st.underlineStyle?.startsWith("double")) lines.push(y + size * 0.24);
  }
  if (st?.strike) lines.push(y - size * 0.3);
  if (lines.length === 0) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(size / 16, 0.5);
  ctx.beginPath();
  for (const ly of lines) {
    ctx.moveTo(x, ly);
    ctx.lineTo(x + w, ly);
  }
  ctx.stroke();
}

/** Draw one box's text (see the text pass in `paintGridScene`). */
function paintBoxText(
  ctx: PaintContext,
  b: TextBox,
  st: LoweredStyle | undefined,
  styleOf: (key: number) => LoweredStyle | undefined,
  g: GridSvgOptions,
): void {
  let { size, shift } = sizeOf(st, g);
  ctx.font = fontOf(st, size, g);
  const color = st?.textRgb ?? g.textColor;
  ctx.fillStyle = color;
  const measure = ctx.measureText?.bind(ctx);
  const indent = st?.indentPt ?? 0;
  const align =
    b.align === "right" ? "right" : b.align === "center" ? "center" : "left";
  const innerW = Math.max(b.x1 - b.x0 - 2 * g.pad - indent, 1);
  // Shrink to fit: the font scaled down until the text fits the width.
  if (st?.shrink && measure && !b.wrap) {
    const w = measure(b.text).width;
    if (w > innerW) {
      size = Math.max((size * innerW) / w, 1);
      shift = (shift * innerW) / w;
      ctx.font = fontOf(st, size, g);
    }
  }
  const rot = st?.rotation ?? 0;
  if (rot > 0 && rot <= 180 && ctx.rotate) {
    // Counter-clockwise up to 90°, clockwise above (value − 90).
    const angle = ((rot <= 90 ? -rot : rot - 90) * Math.PI) / 180;
    ctx.translate((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
    ctx.rotate(angle);
    ctx.textAlign = "center";
    ctx.fillText(b.text, 0, size * 0.35 + shift);
    return;
  }
  if (b.fill !== undefined && b.text.includes("\t")) {
    // A repeat fill (`*x`): the part before the fill at the left edge, the
    // part after at the right edge, the character repeated between.
    paintFilled(ctx, b, b.fill, b.y1 - 3.5 + shift, g.pad);
    return;
  }
  const tx =
    align === "right"
      ? b.x1 - g.pad - indent
      : align === "center"
        ? (b.x0 + b.x1) / 2
        : b.x0 + g.pad + indent;
  const stacked = rot === 255;
  const lines = stacked
    ? b.text.split("\n")
    : b.wrap
      ? wrapLines(ctx, b.text, innerW)
      : [b.text];
  const lead = size * 1.2;
  const block = lead * (lines.length - 1);
  const vAlign = b.vAlign ?? st?.vAlign;
  // Excel's default vertical alignment is bottom.
  const firstY =
    (vAlign === "top"
      ? b.y0 + size + 1
      : vAlign === "center"
        ? (b.y0 + b.y1 + size * 0.7) / 2 - block / 2
        : b.y1 - 3.5 - block) + shift;
  // Rich-text runs on one line: each run in its own style, laid end to end.
  if (b.runs && b.runs.length > 0 && lines.length === 1 && measure) {
    const parts = b.runs.map((r) => {
      const rs = styleOf(r.styleKey);
      const z = sizeOf(rs, g);
      const sz = (z.size * size) / sizeOf(st, g).size;
      ctx.font = fontOf(rs, sz, g);
      return { r, rs, sz, sh: z.shift, w: measure(r.text).width };
    });
    const total = parts.reduce((a, p) => a + p.w, 0);
    let x =
      align === "right" ? tx - total : align === "center" ? tx - total / 2 : tx;
    ctx.textAlign = "left";
    for (const p of parts) {
      ctx.font = fontOf(p.rs, p.sz, g);
      const c = p.rs?.textRgb ?? g.textColor;
      ctx.fillStyle = c;
      ctx.fillText(p.r.text, x, firstY - shift + p.sh);
      decorate(ctx, p.rs, x, firstY - shift + p.sh, p.w, p.sz, c);
      x += p.w;
    }
    return;
  }
  ctx.textAlign = align;
  lines.forEach((line, i) => {
    const ty = firstY + i * lead;
    ctx.fillText(line, tx, ty);
    if ((st?.underline || st?.strike) && measure) {
      const w = measure(line).width;
      const ux =
        align === "right" ? tx - w : align === "center" ? tx - w / 2 : tx;
      decorate(ctx, st, ux, ty, w, size, color);
    }
  });
}

/** Fill a box with a gradient; false when the context cannot. */
function paintGradient(
  ctx: PaintContext,
  gr: FillGradient,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  let grad: CanvasGradient | undefined;
  if (gr.kind === "path" && ctx.createRadialGradient) {
    const cx = x + w * ((gr.left + (1 - gr.right)) / 2 || 0.5);
    const cy = y + h * ((gr.top + (1 - gr.bottom)) / 2 || 0.5);
    grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(w, h) / 2);
  } else if (ctx.createLinearGradient) {
    // xlsx degrees run clockwise from "left to right".
    const a = (gr.degree * Math.PI) / 180;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const dx = (Math.cos(a) * w) / 2;
    const dy = (Math.sin(a) * h) / 2;
    grad = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  }
  if (!grad) return false;
  for (const s of gr.stops)
    grad.addColorStop(Math.min(Math.max(s.position, 0), 1), s.rgb);
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);
  return true;
}

/** Draw one of the 18 xlsx fill patterns: the background, then the
 *  foreground marks on a 2 pt lattice (dots for the greys, lines for the
 *  stripes, both for the grids and trellises). */
function paintPattern(
  ctx: PaintContext,
  fp: FillPattern,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const fg = fp.fgRgb ?? "#000000";
  ctx.fillStyle = fp.bgRgb ?? "#ffffff";
  ctx.fillRect(x, y, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = fg;
  const p = fp.pattern;
  const dots = (sx: number, sy: number, d: number, stagger: boolean) => {
    for (let j = 0, yy = y; yy < y + h; j++, yy += sy) {
      const off = stagger && j % 2 === 1 ? sx / 2 : 0;
      for (let xx = x + off; xx < x + w; xx += sx) ctx.fillRect(xx, yy, d, d);
    }
  };
  if (p === "darkGray") {
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = fp.bgRgb ?? "#ffffff";
    dots(2, 2, 1, true);
  } else if (p === "mediumGray") dots(2, 1, 1, true);
  else if (p === "lightGray") dots(2, 2, 1, true);
  else if (p === "gray125") dots(4, 2, 1, true);
  else if (p === "gray0625") dots(4, 4, 1, true);
  else {
    const dark = p.startsWith("dark");
    ctx.strokeStyle = fg;
    ctx.lineWidth = dark ? 1 : 0.5;
    ctx.beginPath();
    const step = 2;
    const horiz = /Horizontal|Grid/.test(p);
    const vert = /Vertical|Grid/.test(p);
    const down = /Down|Trellis/.test(p);
    const up = /Up|Trellis/.test(p);
    if (horiz)
      for (let yy = y + step / 2; yy < y + h; yy += step) {
        ctx.moveTo(x, yy);
        ctx.lineTo(x + w, yy);
      }
    if (vert)
      for (let xx = x + step / 2; xx < x + w; xx += step) {
        ctx.moveTo(xx, y);
        ctx.lineTo(xx, y + h);
      }
    if (down)
      for (let d = -h; d < w; d += step) {
        ctx.moveTo(x + d, y);
        ctx.lineTo(x + d + h, y + h);
      }
    if (up)
      for (let d = 0; d < w + h; d += step) {
        ctx.moveTo(x + d, y);
        ctx.lineTo(x + d - h, y + h);
      }
    ctx.stroke();
  }
  ctx.restore();
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
      runs: cell.runs,
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

  // Cell fills from the style table: solid, the 18 patterns, gradients.
  for (const b of boxes) {
    const st = styleOf(b.styleKey);
    const fill = st?.fillRgb;
    if (!fill) continue;
    const [x, y, w, hh] = [b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0];
    if (st?.fillGradient && paintGradient(ctx, st.fillGradient, x, y, w, hh))
      continue;
    if (st?.fillPattern) {
      paintPattern(ctx, st.fillPattern, x, y, w, hh);
      continue;
    }
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, hh);
  }

  // Data bars under the text: solid or gradient, with their border and,
  // when the range holds negatives, the axis (W2.4).
  for (const bar of scene.databars ?? []) {
    let paint: string | CanvasGradient = bar.fill;
    if (bar.gradient && ctx.createLinearGradient && bar.w > 0) {
      const grad = bar.negative
        ? ctx.createLinearGradient(bar.x + bar.w, 0, bar.x, 0)
        : ctx.createLinearGradient(bar.x, 0, bar.x + bar.w, 0);
      grad.addColorStop(0, bar.fill);
      grad.addColorStop(1, "#ffffff");
      paint = grad;
    }
    ctx.fillStyle = paint;
    ctx.fillRect(bar.x, bar.y, bar.w, bar.h);
    if (bar.border && bar.w > 0) {
      ctx.strokeStyle = bar.border;
      ctx.lineWidth = 0.5;
      ctx.strokeRect(bar.x, bar.y, bar.w, bar.h);
    }
    if (bar.axisX != null) {
      ctx.strokeStyle = bar.axisColor ?? "#000000";
      ctx.lineWidth = 0.5;
      ctx.setLineDash?.([1, 1]);
      ctx.beginPath();
      ctx.moveTo(bar.axisX, bar.y);
      ctx.lineTo(bar.axisX, bar.y + bar.h);
      ctx.stroke();
      ctx.setLineDash?.([]);
    }
  }

  // Icon sets: the engine's polygons, filled (W2.4).
  if (ctx.fill) {
    for (const icon of scene.icons ?? []) {
      for (const sh of icon.shapes) {
        if (sh.points.length < 3) continue;
        ctx.fillStyle = sh.fill;
        ctx.beginPath();
        ctx.moveTo(sh.points[0][0], sh.points[0][1]);
        for (const [x, y] of sh.points.slice(1)) ctx.lineTo(x, y);
        ctx.closePath?.();
        ctx.fill();
      }
    }
  }

  // Sparklines (sheet ADR 519): the engine's primitives, at their cell.
  for (const sp of scene.sparklines ?? []) {
    for (const p of sp.prims) {
      if (p.kind === "rect" && p.fill) {
        ctx.fillStyle = p.fill;
        ctx.fillRect(sp.x + p.x, sp.y + p.y, p.w, p.h);
      } else if (p.kind === "line" && p.pts.length >= 2) {
        ctx.strokeStyle = p.stroke;
        ctx.lineWidth = p.strokeW;
        ctx.setLineDash?.([]);
        ctx.beginPath();
        p.pts.forEach(([x, y], i) =>
          i === 0
            ? ctx.moveTo(sp.x + x, sp.y + y)
            : ctx.lineTo(sp.x + x, sp.y + y),
        );
        ctx.stroke();
      }
    }
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
    // The diagonals (W2.2).
    edge(bl?.diagonalUp, false, b.x0, b.y1, b.x1, b.y0);
    edge(bl?.diagonalDown, false, b.x0, b.y0, b.x1, b.y1);
  }
  ctx.setLineDash?.([]);

  // Cell text, aligned in its box, clipped to the box (or to the empty
  // neighbours it overflows into), wrapped when the style says so; rotated,
  // stacked, indented, shrunk, struck through, super/subscript and rich-text
  // runs as the style and the runs say (W2.2).
  ctx.textBaseline = "alphabetic";
  for (const b of boxes) {
    if (!b.text) continue;
    const st = styleOf(b.styleKey);
    ctx.save();
    ctx.beginPath();
    ctx.rect(b.clipX0, b.y0, b.clipX1 - b.clipX0, b.y1 - b.y0);
    ctx.clip();
    paintBoxText(ctx, b, st, styleOf, g);
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

  // Hidden tracks: where the shown indices skip, Excel marks the boundary
  // in the heading with a double rule (the place to unhide).
  ctx.strokeStyle = h.text;
  ctx.lineWidth = 0.75;
  ctx.beginPath();
  for (const i of hiddenBoundaries(vp.colIndices, vp.frozenCols ?? 0)) {
    const x = ox + xs[i];
    ctx.moveTo(x - 1, 1);
    ctx.lineTo(x - 1, oy - 1);
    ctx.moveTo(x + 1, 1);
    ctx.lineTo(x + 1, oy - 1);
  }
  for (const i of hiddenBoundaries(vp.rowIndices, vp.frozenRows ?? 0)) {
    const y = oy + ys[i];
    ctx.moveTo(1, y - 1);
    ctx.lineTo(ox - 1, y - 1);
    ctx.moveTo(1, y + 1);
    ctx.lineTo(ox - 1, y + 1);
  }
  ctx.stroke();
}

/** The display positions `i` (1-based boundaries between track i-1 and i)
 *  where the shown sheet indices skip — hidden tracks lie between. The
 *  frozen/scrolled seam is a scroll, not a hide, and is left out. */
export function hiddenBoundaries(
  indices: readonly number[] | undefined,
  frozen: number,
): number[] {
  if (!indices) return [];
  const out: number[] = [];
  for (let i = 1; i < indices.length; i++) {
    if (i === frozen) continue;
    if (indices[i]! - indices[i - 1]! > 1) out.push(i);
  }
  return out;
}
