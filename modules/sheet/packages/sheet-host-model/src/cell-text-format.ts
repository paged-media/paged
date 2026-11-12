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

// Cell TEXT formatting on a native table (Wave 4, Wave 9, W2.2; engine ADR
// 1098). The table lane pours bare text; a bold header, a 9 pt footnote row,
// a red negative, a right-aligned number, an indent or a repeat fill are the
// cell's DIRECT formatting, and that is what they become: `setElementProperty`
// on the cell-qualified `storyRange` (the cell's own paragraphs, cell-local
// offsets), one op per facet. No style is minted for them. What the
// workbook names as a document style (sheet ADR 518: a document character or
// paragraph style) is applied as that style, its extra facets direct on top.
//
// A refresh resets a cell exactly: it writes EVERY facet this module
// controls, the cell's value or the cleared one (the engine clears a text
// field on "", a length on null, a colour on null; underline and
// strike-through take false, their visible default), and re-applies the
// document style or the "no style" one.
//
// PURE: content in, mutations out.

import type {
  ElementId,
  Mutation,
  PropertyPath,
  Value,
} from "@paged-media/plugin-api";

import type {
  Align,
  LoweredCell,
  LoweredContent,
  LoweredStyle,
} from "./lowered";
import { columnOrder } from "./lower-to-table";
import { styleProps, type StyleProp } from "./lower-to-mutations";

/** InDesign's "no character style" — what an unformatted cell resets to. */
export const NO_CHARACTER_STYLE = "CharacterStyle/$ID/[No character style]";

/** InDesign's "no paragraph style" — what a default cell resets to. */
export const NO_PARAGRAPH_STYLE = "ParagraphStyle/$ID/[No paragraph style]";

/** The character facets a cell's text takes (`styleProps`), each with the
 *  value that clears it. */
export const CHARACTER_FACET_CLEARS: Readonly<Record<string, Value>> = {
  characterFontStyle: { type: "text", value: "" },
  characterFontFamily: { type: "text", value: "" },
  characterFontSize: { type: "length", value: null },
  characterUnderline: { type: "bool", value: false },
  characterFillColor: { type: "colorRef", value: null },
  characterStrikethru: { type: "bool", value: false },
  characterPosition: { type: "text", value: "" },
};

/** The paragraph facets a cell's paragraph takes, each with its clear. */
export const PARAGRAPH_FACET_CLEARS: Readonly<Record<string, Value>> = {
  paragraphJustification: { type: "text", value: "" },
  paragraphLeftIndent: { type: "length", value: null },
  paragraphRightIndent: { type: "length", value: null },
  paragraphTabStops: { type: "tabStops", value: [] } as unknown as Value,
};

/** IDML justification per non-default alignment (left/general need none). */
const JUSTIFICATION: Partial<Record<Align, string>> = {
  center: "CenterAlign",
  right: "RightAlign",
};

/** The gap (pt) between a repeat-fill's right tab stop and the cell's right
 *  edge, so the tab never wraps the line (a native cell has no inset). */
export const FILL_TAB_GAP_PT = 1;

/** A cell's (or a run's) text format: a document style to apply, and the
 *  direct properties on top. */
export interface CellTextFormat {
  docStyle?: string;
  props: StyleProp[];
}

/** A table cell (`TextCellAddr`). */
type CellAddr = { tableId: string; row: number; col: number };

/** The engine counts a range in characters (Unicode scalar values). */
function charLength(s: string): number {
  return [...s].length;
}

const isEmpty = (f: CellTextFormat | null | undefined): boolean =>
  !f || (!f.docStyle && f.props.length === 0);

/** The character format per style key; keys whose style carries no
 *  character facet map to no entry. */
export function cellCharacterFormats(
  content: LoweredContent,
): Map<number, CellTextFormat> {
  const out = new Map<number, CellTextFormat>();
  for (const style of content.styles ?? []) {
    if (style.key === 0) continue;
    // A document character style is applied as it is (sheet ADR 518): the
    // cell's concrete font is its xlsx fallback, not an override.
    if (style.docCharStyle) {
      out.set(style.key, { docStyle: style.docCharStyle, props: [] });
      continue;
    }
    const props = styleProps(style);
    if (props.length > 0) out.set(style.key, { props });
  }
  return out;
}

/** One populated cell's character formatting, keyed `row:col` at TABLE
 *  positions: the cell's format, or one per rich-text run (W2.2). */
interface CellCharacterEntry {
  format: CellTextFormat | null;
  text: string;
  runs?: { format: CellTextFormat | null; text: string }[];
}

export function cellCharacterFormatMap(
  content: LoweredContent,
): Map<string, CellCharacterEntry> {
  const formats = cellCharacterFormats(content);
  const colPos = new Map<number, number>();
  columnOrder(content).forEach((m, i) => colPos.set(m, i));
  const of = (key?: number) => (key ? (formats.get(key) ?? null) : null);
  const out = new Map<string, CellCharacterEntry>();
  content.rows.forEach((row, r) => {
    for (const cell of row.cells) {
      const c = colPos.get(cell.col);
      if (c === undefined || cell.text.length === 0) continue;
      out.set(`${r}:${c}`, {
        format: of(cell.styleKey),
        text: cell.text,
        ...(cell.runs
          ? {
              runs: cell.runs.map((run) => ({
                format: of(run.styleKey),
                text: run.text,
              })),
            }
          : {}),
      });
    }
  });
  return out;
}

/** Whether any populated cell carries character formatting. */
export function hasCellCharacterFormats(content: LoweredContent): boolean {
  for (const e of cellCharacterFormatMap(content).values()) {
    if (!isEmpty(e.format) || e.runs?.some((r) => !isEmpty(r.format)))
      return true;
  }
  return false;
}

/** The cell-qualified story range element of `[start, end)` in a cell. */
function cellRange(
  storyId: string,
  cell: CellAddr,
  start: number,
  end: number,
): ElementId {
  return { kind: "storyRange", id: { story_id: storyId, start, end, cell } };
}

/** The ops that give `[start, end)` of a cell the format `f`. `reset`
 *  writes every facet in `clears` (the value or its clear) and always
 *  re-applies a style (the document's, or `noStyle`). */
function formatOps(
  storyId: string,
  cell: CellAddr,
  start: number,
  end: number,
  f: CellTextFormat | null,
  scope: "character" | "paragraph",
  clears: Readonly<Record<string, Value>>,
  noStyle: string,
  reset: boolean,
): Mutation[] {
  const ops: Mutation[] = [];
  if (f?.docStyle || reset) {
    ops.push({
      op: "applyStyle",
      args: {
        storyId,
        start,
        end,
        style: f?.docStyle ?? noStyle,
        scope,
        cell,
      },
    });
  }
  const set = (path: string, value: Value): Mutation => ({
    op: "setElementProperty",
    args: {
      elementId: cellRange(storyId, cell, start, end),
      path: path as PropertyPath,
      value,
    },
  });
  const own = new Map((f?.props ?? []).map((p) => [p.path as string, p]));
  if (reset) {
    for (const [path, clear] of Object.entries(clears))
      ops.push(set(path, own.get(path)?.value ?? clear));
  } else {
    for (const p of own.values()) ops.push(set(p.path, p.value));
  }
  return ops;
}

/** The character formatting ops for each populated cell — all of them, or
 *  only `cells` (`row:col` keys). A fresh pour writes only formatted cells;
 *  `reset` (a refresh) rewrites every facet of the listed cells, so a cell
 *  that LOST its formatting comes back to the default. */
export function cellCharacterFormatOps(
  content: LoweredContent,
  storyId: string,
  tableId: string,
  opts: { cells?: ReadonlySet<string>; reset?: boolean } = {},
): Mutation[] {
  const reset = opts.reset ?? false;
  const ops: Mutation[] = [];
  for (const [key, e] of cellCharacterFormatMap(content)) {
    if (opts.cells && !opts.cells.has(key)) continue;
    const [row, col] = key.split(":").map(Number);
    const cell = { tableId, row, col };
    const pieces = e.runs ?? [{ format: e.format, text: e.text }];
    let start = 0;
    for (const piece of pieces) {
      const end = start + charLength(piece.text);
      if (end > start && (reset || !isEmpty(piece.format))) {
        ops.push(
          ...formatOps(
            storyId,
            cell,
            start,
            end,
            piece.format,
            "character",
            CHARACTER_FACET_CLEARS,
            NO_CHARACTER_STYLE,
            reset,
          ),
        );
      }
      start = end;
    }
  }
  return ops;
}

/** The cells a refresh must re-format: the format changed, or the text was
 *  re-poured into a cell where either the old or the new text is formatted
 *  (re-poured text may inherit the old run's format). A table with no cell
 *  formatting on either side needs none. */
export function cellsNeedingRestyle(
  prev: LoweredContent,
  next: LoweredContent,
): Set<string> {
  const a = cellCharacterFormatMap(prev);
  const sig = (e?: CellCharacterEntry) =>
    JSON.stringify([e?.format ?? null, e?.runs?.map((r) => r.format) ?? null]);
  const formatted = (e?: CellCharacterEntry) =>
    !!e && (!isEmpty(e.format) || !!e.runs?.some((r) => !isEmpty(r.format)));
  const out = new Set<string>();
  for (const [k, v] of cellCharacterFormatMap(next)) {
    const old = a.get(k);
    if (sig(old) !== sig(v) && (formatted(old) || formatted(v))) out.add(k);
    else if (old?.text !== v.text && (formatted(old) || formatted(v)))
      out.add(k);
  }
  return out;
}

// ------------------------------------------------------------- paragraphs

/** The paragraph format a cell needs, or null (left/general, no fill, no
 *  indent, no document style: the default paragraph). A repeat fill is a
 *  right tab stop at the cell's inner width with the fill character as its
 *  leader (the text carries a TAB there, ruling `sheet.format.padding`). */
export function cellParagraphFormat(
  cell: LoweredCell,
  widthPt: number,
  style?: LoweredStyle,
): CellTextFormat | null {
  const indent = style?.indentPt ?? 0;
  const fill = cell.fill !== undefined && cell.text.includes("\t");
  const align = fill ? "left" : cell.align;
  const justification = JUSTIFICATION[align];
  const doc = style?.docParaStyle ?? undefined;
  const props: StyleProp[] = [];
  if (justification) {
    props.push({
      path: "paragraphJustification",
      value: { type: "text", value: justification },
    });
  }
  if (indent > 0) {
    // Excel indents from the edge the text is aligned to.
    const path: PropertyPath =
      align === "right" ? "paragraphRightIndent" : "paragraphLeftIndent";
    props.push({ path, value: { type: "length", value: indent } });
  }
  if (fill) {
    const position =
      Math.round(Math.max(widthPt - FILL_TAB_GAP_PT, 0) * 100) / 100;
    const leader = cell.fill === " " ? null : (cell.fill ?? null);
    props.push({
      path: "paragraphTabStops",
      value: {
        type: "tabStops",
        value: [{ position, alignment: "RightAlign", leader }],
      } as unknown as Value,
    });
  }
  if (!doc && props.length === 0) return null;
  return { ...(doc ? { docStyle: doc } : {}), props };
}

/** Each lowered cell's width (pt): its column's, or the sum of a merged
 *  area's columns at its anchor. Keyed `row:col` in model coordinates. */
function cellWidths(content: LoweredContent): Map<string, number> {
  const widthOf = new Map(content.cols.map((c) => [c.index, c.widthPt]));
  const out = new Map<string, number>();
  for (const m of content.merges) {
    let w = 0;
    for (let c = m.col; c < m.col + m.colSpan; c++) w += widthOf.get(c) ?? 0;
    out.set(`${m.row}:${m.col}`, w);
  }
  for (const row of content.rows) {
    for (const cell of row.cells) {
      const k = `${row.index}:${cell.col}`;
      if (!out.has(k)) out.set(k, widthOf.get(cell.col) ?? 0);
    }
  }
  return out;
}

/** The paragraph format of every populated cell (null = the default), keyed
 *  `row:col` at TABLE positions. */
export function cellParagraphFormats(
  content: LoweredContent,
): Map<string, { format: CellTextFormat | null; text: string }> {
  const colPos = new Map<number, number>();
  columnOrder(content).forEach((m, i) => colPos.set(m, i));
  const widths = cellWidths(content);
  const styleByKey = new Map((content.styles ?? []).map((s) => [s.key, s]));
  const out = new Map<
    string,
    { format: CellTextFormat | null; text: string }
  >();
  content.rows.forEach((row, r) => {
    for (const cell of row.cells) {
      const c = colPos.get(cell.col);
      if (c === undefined || cell.text.length === 0) continue;
      const style = cell.styleKey ? styleByKey.get(cell.styleKey) : undefined;
      out.set(`${r}:${c}`, {
        format: cellParagraphFormat(
          cell,
          widths.get(`${row.index}:${cell.col}`) ?? 0,
          style,
        ),
        text: cell.text,
      });
    }
  });
  return out;
}

/** The paragraph formatting ops for each populated cell — all, or only
 *  `cells`. Default cells are skipped unless `reset` (a refresh rewrites
 *  every paragraph facet of the listed cells). */
export function cellParagraphFormatOps(
  content: LoweredContent,
  storyId: string,
  tableId: string,
  opts: { cells?: ReadonlySet<string>; reset?: boolean } = {},
): Mutation[] {
  const reset = opts.reset ?? false;
  const ops: Mutation[] = [];
  for (const [key, { format, text }] of cellParagraphFormats(content)) {
    if (opts.cells && !opts.cells.has(key)) continue;
    if (!reset && isEmpty(format)) continue;
    const [row, col] = key.split(":").map(Number);
    ops.push(
      ...formatOps(
        storyId,
        { tableId, row, col },
        0,
        charLength(text),
        format,
        "paragraph",
        PARAGRAPH_FACET_CLEARS,
        NO_PARAGRAPH_STYLE,
        reset,
      ),
    );
  }
  return ops;
}

/** The cells a refresh must re-format: the paragraph format changed, or the
 *  text was re-poured into a cell whose new format is not the default. */
export function cellsNeedingRealign(
  prev: LoweredContent,
  next: LoweredContent,
): Set<string> {
  const a = cellParagraphFormats(prev);
  const out = new Set<string>();
  for (const [k, v] of cellParagraphFormats(next)) {
    const old = a.get(k);
    if (JSON.stringify(old?.format ?? null) !== JSON.stringify(v.format))
      out.add(k);
    else if (old?.text !== v.text && !isEmpty(v.format)) out.add(k);
  }
  return out;
}
