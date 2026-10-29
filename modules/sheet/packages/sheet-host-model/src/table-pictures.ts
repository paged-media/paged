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

// W2.3 (sheet ADR 526) — the pictures of a placed range on the page: an
// image frame each over the native table, at its anchor cell (in the
// table's own column widths) plus its offset, the image placed by its
// `data:` URI. Drawing pictures stretch with the anchor; an image in a
// cell is fitted into the cell keeping its aspect ratio.

import type { Mutation, PageId } from "@paged-media/plugin-api";

import { nativeFxOps } from "./chart";
import type { LoweredContent, LoweredPicture } from "./lowered";
import { columnOrder } from "./lower-to-table";
import {
  normalizePaletteHex,
  swatchMintOps,
  type KnownSwatchIds,
} from "./palette";

/** A picture's page box `[top, left, bottom, right]` over a table whose
 *  content box starts at `origin` (`[top, left]`), or null when its anchor
 *  cell is not in the table. */
export function tablePictureBox(
  content: LoweredContent,
  widths: readonly number[],
  origin: [number, number],
  p: LoweredPicture,
): [number, number, number, number] | null {
  const order = columnOrder(content);
  const ci = order.indexOf(p.col);
  const ri = content.rows.findIndex((r) => r.index === p.row);
  if (ci < 0 || ri < 0) return null;
  const irW = new Map(content.cols.map((c) => [c.index, c.widthPt]));
  let x = 0;
  for (let i = 0; i < ci; i++) x += widths[i] ?? irW.get(order[i]!) ?? 0;
  let y = 0;
  for (let i = 0; i < ri; i++) y += content.rows[i]!.heightPt;
  const ir = irW.get(p.col) ?? 0;
  const k = ir > 0 ? (widths[ci] ?? ir) / ir : 1;
  const top = origin[0] + y + p.dy;
  const left = origin[1] + x + p.dx * k;
  return [top, left, top + p.hPt, left + p.wPt * (p.inCell ? k : 1)];
}

/** The ops that place `content`'s pictures over its table: per picture an
 *  `insertFrame` bound to a handle, its `placeImage`, and (sheet ADR 527)
 *  the opacity and effects its DrawingML asks for — their colours minted
 *  first as chart swatches the document lacks (`knownSwatchIds`, the same
 *  read-first ruling as every mint: `null`, a failed read, mints none). */
export function tablePictureOps(
  content: LoweredContent,
  widths: readonly number[],
  pageId: PageId,
  origin: [number, number],
  knownSwatchIds?: KnownSwatchIds,
): Mutation[] {
  const ops: Mutation[] = [];
  const hexes = new Set<string>();
  (content.pictures ?? []).forEach((p, i) => {
    const box = tablePictureBox(content, widths, origin, p);
    if (!box || box[2] <= box[0] || box[3] <= box[1]) return;
    const handle = `pic${i}`;
    ops.push(
      { op: "insertFrame", args: { pageId, bounds: box } },
      { op: "bindCreated", args: { handle } },
      {
        op: "placeImage",
        args: {
          elementId: `$h:${handle}`,
          uri: p.uri,
          fit: p.inCell ? "Proportionally" : "ContentToFrame",
        },
      },
      ...nativeFxOps(p.fx, 0, 0, undefined, false, {
        kind: "rectangle",
        id: `$h:${handle}`,
      }),
    );
    for (const c of [
      p.fx?.dropShadow?.color,
      p.fx?.innerShadow?.color,
      p.fx?.outerGlow?.color,
    ]) {
      const h = c == null ? null : normalizePaletteHex(c);
      if (h != null) hexes.add(h);
    }
  });
  return [...swatchMintOps("chart", [...hexes], knownSwatchIds), ...ops];
}

/** What the page cannot hold of `content`'s pictures, one line per kind. */
export function tablePictureLosses(content: LoweredContent): string[] {
  return [...new Set((content.pictures ?? []).flatMap((p) => p.losses ?? []))];
}
