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

// Horizontal cell alignment on a native table (Wave 9). The engine resolves
// every cell's alignment in Rust (an explicit style wins; otherwise Excel's
// General rule — numbers right, booleans/errors centred, text left) and the
// lowered cell carries it — but the table lane poured bare text, so every
// number in a placed table sat flush LEFT.
//
// A table cell's paragraph has no direct property door (`paragraphJustification`
// addresses a story range, which cannot reach into a cell), but `applyStyle`
// takes a cell qualifier with `scope: "paragraph"`. So the two non-default
// alignments become two document PARAGRAPH STYLES at fixed ids (justification
// only), minted once with the swatch/character-style discipline (read first,
// mint only the absent ids, mint NOTHING on a failed read), and applied to the
// cell's paragraph. Left / General need nothing: they are the default.
//
// PURE: content in, mutations out.

import type { Mutation, PropertyPath, Value } from "@paged-media/plugin-api";

import type {
  Align,
  LoweredCell,
  LoweredContent,
  LoweredStyle,
} from "./lowered";
import { columnOrder } from "./lower-to-table";
import { textOffsetLength } from "./table-refresh";

/** InDesign's "no paragraph style" — what a left-aligned cell resets to. */
export const NO_PARAGRAPH_STYLE = "ParagraphStyle/$ID/[No paragraph style]";

/** The paragraph style (id, name, IDML justification) per non-default
 *  alignment. */
export const ALIGN_PARAGRAPH_STYLES: Readonly<
  Partial<Record<Align, { id: string; name: string; justification: string }>>
> = {
  center: {
    id: "ParagraphStyle/paged.sheet align center",
    name: "Sheet · align center",
    justification: "CenterAlign",
  },
  right: {
    id: "ParagraphStyle/paged.sheet align right",
    name: "Sheet · align right",
    justification: "RightAlign",
  },
};

/** One paragraph style a cell needs: its id, display name and the
 *  facets it sets (`setStyleProperty` path + value). */
export interface CellParagraphStyle {
  id: string;
  name: string;
  props: { path: PropertyPath; value: Value }[];
}

/** The gap (pt) between a repeat-fill's right tab stop and the cell's right
 *  edge, so the tab never wraps the line (a native cell has no inset). */
export const FILL_TAB_GAP_PT = 1;

/** FNV-1a, 32-bit, hex — a short stable content address. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The paragraph style a cell needs, or null (left/general, no fill, no
 *  indent: the default paragraph). Alignment alone keeps the fixed ids of
 *  `ALIGN_PARAGRAPH_STYLES`; a repeat fill (a right tab stop at the cell's
 *  inner width with the fill character as its leader — the text carries a
 *  TAB there, ruling `sheet.format.padding`) or an indent mints a
 *  content-addressed style. */
export function cellParagraphStyle(
  cell: LoweredCell,
  widthPt: number,
  style?: LoweredStyle,
): CellParagraphStyle | null {
  const indent = style?.indentPt ?? 0;
  const fill = cell.fill !== undefined && cell.text.includes("\t");
  const align = fill ? "left" : cell.align;
  const fixed = ALIGN_PARAGRAPH_STYLES[align];
  if (!fill && indent === 0) {
    return fixed
      ? {
          id: fixed.id,
          name: fixed.name,
          props: [
            {
              path: "paragraphJustification",
              value: { type: "text", value: fixed.justification },
            },
          ],
        }
      : null;
  }
  const props: CellParagraphStyle["props"] = [];
  const parts: string[] = [];
  if (fixed) {
    props.push({
      path: "paragraphJustification",
      value: { type: "text", value: fixed.justification },
    });
    parts.push(`align ${align}`);
  }
  if (indent > 0) {
    // Excel indents from the edge the text is aligned to.
    const path: PropertyPath =
      align === "right" ? "paragraphRightIndent" : "paragraphLeftIndent";
    props.push({ path, value: { type: "length", value: indent } });
    parts.push(`indent ${indent}`);
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
      },
    });
    parts.push(`fill ${leader ?? "space"} ${position}`);
  }
  const key = JSON.stringify(props);
  return {
    id: `ParagraphStyle/paged.sheet ${fnv(key)}`,
    name: `Sheet · ${parts.join(" · ")}`,
    props,
  };
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

/** The paragraph style of every populated cell (null = the default), keyed
 *  `row:col` at TABLE positions. */
export function cellParagraphStyles(
  content: LoweredContent,
): Map<string, { style: CellParagraphStyle | null; text: string }> {
  const colPos = new Map<number, number>();
  columnOrder(content).forEach((m, i) => colPos.set(m, i));
  const widths = cellWidths(content);
  const styleByKey = new Map((content.styles ?? []).map((s) => [s.key, s]));
  const out = new Map<
    string,
    { style: CellParagraphStyle | null; text: string }
  >();
  content.rows.forEach((row, r) => {
    for (const cell of row.cells) {
      const c = colPos.get(cell.col);
      if (c === undefined || cell.text.length === 0) continue;
      const style = cell.styleKey ? styleByKey.get(cell.styleKey) : undefined;
      out.set(`${r}:${c}`, {
        style: cellParagraphStyle(
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

/** The paragraph style id each populated cell's paragraph should carry, keyed
 *  `row:col` at TABLE positions (`NO_PARAGRAPH_STYLE` for the default). */
export function cellAlignMap(
  content: LoweredContent,
): Map<string, { style: string; text: string }> {
  const out = new Map<string, { style: string; text: string }>();
  for (const [k, v] of cellParagraphStyles(content)) {
    out.set(k, { style: v.style?.id ?? NO_PARAGRAPH_STYLE, text: v.text });
  }
  return out;
}

/** Whether any populated cell needs a non-default paragraph (a caller skips
 *  the paragraph-style read when none does). */
export function needsAlignStyles(content: LoweredContent): boolean {
  for (const { style } of cellAlignMap(content).values()) {
    if (style !== NO_PARAGRAPH_STYLE) return true;
  }
  return false;
}

/** createParagraphStyle + its facets for every paragraph style the content
 *  uses and the document lacks. `knownStyleIds === null` (the read failed)
 *  mints nothing — the cells then keep the default paragraph, the batch
 *  still lands. */
export function cellAlignStyleMints(
  content: LoweredContent,
  knownStyleIds: ReadonlySet<string> | null,
): Mutation[] {
  if (knownStyleIds === null) return [];
  const ops: Mutation[] = [];
  const minted = new Set<string>();
  for (const { style } of cellParagraphStyles(content).values()) {
    if (!style || knownStyleIds.has(style.id) || minted.has(style.id)) continue;
    minted.add(style.id);
    ops.push({
      op: "createParagraphStyle",
      args: { selfId: style.id, name: style.name },
    });
    for (const p of style.props) {
      ops.push({
        op: "setStyleProperty",
        args: {
          collection: "paragraph",
          styleId: style.id,
          path: p.path,
          value: p.value,
        },
      });
    }
  }
  return ops;
}

/** applyStyle (cell-qualified, paragraph scope) for each populated cell —
 *  all of them, or only `cells`. Left/general cells are skipped unless
 *  `includeDefault` (a refresh resets a cell that LOST its alignment).
 *  `known` (the document's paragraph styles; null = unread/failed) drops
 *  applies naming a style that neither exists nor is minted alongside. */
export function cellAlignApplies(
  content: LoweredContent,
  storyId: string,
  tableId: string,
  opts: {
    cells?: ReadonlySet<string>;
    includeDefault?: boolean;
    available?: ReadonlySet<string>;
  } = {},
): Mutation[] {
  const ops: Mutation[] = [];
  for (const [key, { style, text }] of cellAlignMap(content)) {
    if (opts.cells && !opts.cells.has(key)) continue;
    if (style === NO_PARAGRAPH_STYLE && !opts.includeDefault) continue;
    if (
      style !== NO_PARAGRAPH_STYLE &&
      opts.available &&
      !opts.available.has(style)
    )
      continue;
    const [row, col] = key.split(":").map(Number);
    ops.push({
      op: "applyStyle",
      args: {
        storyId,
        start: 0,
        end: textOffsetLength(text),
        style,
        scope: "paragraph",
        cell: { tableId, row, col },
      },
    });
  }
  return ops;
}

/** The cells a refresh must re-align: the alignment changed, or the text was
 *  re-poured into a cell whose new alignment is not the default. */
export function cellsNeedingRealign(
  prev: LoweredContent,
  next: LoweredContent,
): Set<string> {
  const a = cellAlignMap(prev);
  const out = new Set<string>();
  for (const [k, v] of cellAlignMap(next)) {
    const old = a.get(k);
    if ((old?.style ?? NO_PARAGRAPH_STYLE) !== v.style) out.add(k);
    else if (old?.text !== v.text && v.style !== NO_PARAGRAPH_STYLE) out.add(k);
  }
  return out;
}
