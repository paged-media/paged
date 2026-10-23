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

// Conditional-format DATA BARS on a NATIVE placed table (Wave 9). The engine
// lowers each bar as a rect in the IR's own geometry (its column widths, its
// row heights); the native table is sized by the document's font metrics, so
// its columns differ. Each bar is mapped onto its table cell — same row,
// same column position, the bar's offset and length scaled by the cell's
// width ratio — and drawn as a page path (the paged.draw lane the tab-text
// fallback already uses), filled with the rule's colour, and sent one step
// BACKWARD so it sits under the table's text, as Excel layers it. The
// `backward` lands right under the frame because the frame is the topmost
// item when the bars are drawn (placement; a refresh deletes the old bars
// first) — a frame something else was later stacked on gets its bars under
// that item instead (a documented limit: there is no relative z door).
//
// PURE: content + widths + where the frame sits in, mutations out.

import type { Mutation, PageId } from "@paged-media/plugin-api";

import type { DataBarRect, IconRect, LoweredContent } from "./lowered";
import { columnOrder } from "./lower-to-table";
import {
  barSwatchOps,
  dataBarAxisOps,
  dataBarOps,
  iconOps,
} from "./lower-to-mutations";
import type { KnownSwatchIds } from "./palette";

/** The bars mapped onto the native table's geometry, in frame-content pt. */
export function tableDataBars(
  content: LoweredContent,
  widths: readonly number[],
): DataBarRect[] {
  const bars = content.databars ?? [];
  if (bars.length === 0) return [];
  const order = columnOrder(content);
  const colPos = new Map<number, number>();
  order.forEach((m, i) => colPos.set(m, i));
  const irW = new Map(content.cols.map((c) => [c.index, c.widthPt]));
  // IR x of each column (in table order) and the table's own x.
  const irX: number[] = [];
  const tX: number[] = [];
  let ix = 0;
  let tx = 0;
  order.forEach((m, i) => {
    irX.push(ix);
    tX.push(tx);
    ix += irW.get(m) ?? 0;
    tx += widths[i] ?? irW.get(m) ?? 0;
  });
  // Rows keep their IR heights in the table, so a bar's y carries over.
  const rowPos = new Map<number, number>();
  content.rows.forEach((r, i) => rowPos.set(r.index, i));
  const out: DataBarRect[] = [];
  for (const bar of bars) {
    const c = colPos.get(bar.col);
    const r = rowPos.get(bar.row);
    if (c === undefined || r === undefined || bar.w <= 0) continue;
    const ir = irW.get(order[c]) ?? 0;
    const k = ir > 0 ? (widths[c] ?? ir) / ir : 1;
    out.push({
      ...bar,
      x: tX[c] + (bar.x - irX[c]) * k,
      w: bar.w * k,
      ...(bar.axisX != null ? { axisX: tX[c] + (bar.axisX - irX[c]) * k } : {}),
    });
  }
  return out;
}

/** The icons mapped onto the native table: each keeps its offset from its
 *  cell's left edge (W2.4). */
export function tableIcons(
  content: LoweredContent,
  widths: readonly number[],
): IconRect[] {
  const icons = content.icons ?? [];
  if (icons.length === 0) return [];
  const order = columnOrder(content);
  const irW = new Map(content.cols.map((c) => [c.index, c.widthPt]));
  const shift = new Map<number, number>();
  let ix = 0;
  let tx = 0;
  order.forEach((m, i) => {
    shift.set(m, tx - ix);
    ix += irW.get(m) ?? 0;
    tx += widths[i] ?? irW.get(m) ?? 0;
  });
  return icons.flatMap((icon) => {
    const dx = shift.get(icon.col);
    if (dx === undefined) return [];
    return [
      {
        ...icon,
        x: icon.x + dx,
        shapes: icon.shapes.map((sh) => ({
          ...sh,
          points: sh.points.map(([x, y]) => [x + dx, y] as [number, number]),
        })),
      },
    ];
  });
}

/** The ops that draw a native table's data bars on its page: the bar-colour
 *  swatch mints (read-first discipline: `known` null mints nothing), then
 *  per bar its rect path, its fill and a `backward` step under the frame.
 *  `origin` is the frame's page-local top-left. Empty when there are none. */
export function tableDataBarOps(
  content: LoweredContent,
  widths: readonly number[],
  pageId: PageId,
  origin: [number, number],
  known?: KnownSwatchIds,
): Mutation[] {
  const bars = tableDataBars(content, widths);
  const icons = tableIcons(content, widths);
  if (bars.length === 0 && icons.length === 0) return [];
  const [top, left] = origin;
  const ops: Mutation[] = [
    ...barSwatchOps({ ...content, databars: bars, icons }, known),
  ];
  bars.forEach((bar, i) => {
    const drawn = dataBarOps(bar, pageId, top, left);
    if (drawn.length === 0) return;
    const handle = `bar${i}`;
    ops.push(
      drawn[0],
      { op: "bindCreated", args: { handle } },
      ...drawn.slice(1),
    );
    ops.push({
      op: "reorderElement",
      args: {
        elementId: { kind: "polygon", id: `$h:${handle}` },
        to: "backward",
      },
    });
    // W2.4: the axis of a range with negative values, over the bar.
    ops.push(...dataBarAxisOps(bar, pageId, top, left));
  });
  // W2.4: icon sets, drawn over the table.
  for (const icon of icons) ops.push(...iconOps(icon, pageId, top, left));
  return ops;
}
