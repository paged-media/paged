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
  DEFAULT_GRID_SVG_OPTIONS,
  type GridScene,
  type GridSvgOptions,
} from "./grid";

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
   *  under a light wash (ADR 510); its sheet column index, or null. */
  partialCol?: number | null;
  grid?: Partial<GridSvgOptions>;
  heading?: Partial<HeadingStyle>;
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

  // Cell fills from the style table.
  const styleOf = (key: number) => scene.styles.find((s) => s.key === key);
  const colX = (c: number) => xs[c - vp.firstCol];
  const rowY = (r: number) => ys[r - vp.firstRow];
  for (const cell of scene.cells) {
    const st = styleOf(cell.styleKey ?? 0);
    if (!st?.fillRgb) continue;
    const x = colX(cell.col);
    const y = rowY(cell.row);
    if (x === undefined || y === undefined) continue;
    ctx.fillStyle = st.fillRgb;
    ctx.fillRect(
      x,
      y,
      xs[cell.col - vp.firstCol + 1] - x,
      ys[cell.row - vp.firstRow + 1] - y,
    );
  }

  // Data bars under the text.
  for (const bar of scene.databars ?? []) {
    ctx.fillStyle = bar.fill;
    ctx.fillRect(bar.x, bar.y, bar.w, bar.h);
  }

  // Gridlines.
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

  // Cell text, aligned and clipped to its cell.
  ctx.textBaseline = "alphabetic";
  for (const cell of scene.cells) {
    if (!cell.text) continue;
    const ci = cell.col - vp.firstCol;
    const ri = cell.row - vp.firstRow;
    const x0 = xs[ci];
    const x1 = xs[ci + 1];
    const y0 = ys[ri];
    const y1 = ys[ri + 1];
    if (
      x0 === undefined ||
      x1 === undefined ||
      y0 === undefined ||
      y1 === undefined
    )
      continue;
    const st = styleOf(cell.styleKey ?? 0);
    const size = st?.fontSizePt ?? g.fontSizePt;
    const family = st?.fontName
      ? `"${st.fontName}", ${g.fontFamily}`
      : g.fontFamily;
    ctx.font = `${st?.italic ? "italic " : ""}${st?.bold ? "bold " : ""}${size}px ${family}`;
    ctx.fillStyle = st?.textRgb ?? g.textColor;
    const align =
      cell.align === "right"
        ? "right"
        : cell.align === "center"
          ? "center"
          : "left";
    ctx.textAlign = align;
    const tx =
      align === "right"
        ? x1 - g.pad
        : align === "center"
          ? (x0 + x1) / 2
          : x0 + g.pad;
    // Excel's default vertical alignment is bottom.
    const ty =
      st?.vAlign === "top"
        ? y0 + size + 1
        : st?.vAlign === "center"
          ? (y0 + y1 + size * 0.7) / 2
          : y1 - 3.5;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.fillText(cell.text, tx, ty);
    ctx.restore();
  }

  // The partly visible track past the print edge (it does not reach the page).
  if (options.partialCol !== undefined && options.partialCol !== null) {
    ctx.fillStyle = "rgba(120,120,120,0.10)";
    ctx.fillRect(cellW, 0, Math.max(options.widthPt - ox - cellW, 0), cellH);
  }

  // Selection wash + outline, the fill handle, the fill-drag target.
  if (sel) {
    const x0 = colX(Math.max(sel.anchorCol, vp.firstCol));
    const y0 = rowY(Math.max(sel.anchorRow, vp.firstRow));
    const lastC =
      Math.min(sel.anchorCol + sel.cols, vp.firstCol + vp.cols) - vp.firstCol;
    const lastR =
      Math.min(sel.anchorRow + sel.rows, vp.firstRow + vp.rows) - vp.firstRow;
    const x1 = xs[lastC];
    const y1 = ys[lastR];
    if (
      x0 !== undefined &&
      y0 !== undefined &&
      x1 !== undefined &&
      y1 !== undefined &&
      x1 > x0 &&
      y1 > y0
    ) {
      ctx.fillStyle = g.selectionFill;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = g.selectionColor;
      ctx.lineWidth = g.selectionWidth;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.fillStyle = g.selectionColor;
      ctx.fillRect(x1 - 2.5, y1 - 2.5, 5, 5);
    }
  }
  const fp = scene.fillPreview ?? null;
  if (fp) {
    const x0 = colX(Math.max(fp.anchorCol, vp.firstCol));
    const y0 = rowY(Math.max(fp.anchorRow, vp.firstRow));
    const x1 =
      xs[Math.min(fp.anchorCol + fp.cols, vp.firstCol + vp.cols) - vp.firstCol];
    const y1 =
      ys[Math.min(fp.anchorRow + fp.rows, vp.firstRow + vp.rows) - vp.firstRow];
    if (
      x0 !== undefined &&
      y0 !== undefined &&
      x1 !== undefined &&
      y1 !== undefined
    ) {
      ctx.strokeStyle = g.selectionColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    }
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
    const c = vp.firstCol + i;
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
    const r = vp.firstRow + i;
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
