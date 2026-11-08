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

// Sheet ADR 530 — the shapes of a placed range on the page: a path per
// outline the engine evaluated (the preset and custom geometry, flipped and
// turned in Rust), at the shape's anchor cell in the table's own column
// widths plus its offset, painted by the DrawingML look the shared mapper
// lowered. Like the pictures and data bars, they are page art the table's
// refresh replaces.

import type {
  Mutation,
  PageId,
  PropertyPath,
  Value,
} from "@paged-media/plugin-api";
import { nativeFxColors, nativeFxOps } from "@paged-media/plugin-sdk";

import { chartGradientId, chartGradientMintOps } from "./chart";
import type { LoweredContent, LoweredShape, LoweredShapeItem } from "./lowered";
import { normalizePaletteHex, paletteSwatchId, swatchMintOps } from "./palette";
import type { KnownSwatchIds } from "./palette";
import { tablePictureBox } from "./table-pictures";

const CREATED = { kind: "polygon", id: "$created" } as const;
const NONE = "Swatch/None";

const chartColor = (hex: string): string =>
  paletteSwatchId("chart", normalizePaletteHex(hex) ?? "000000");

const colorRef = (id: string): Value => ({ type: "colorRef", value: id });

/** The page box `[top, left, bottom, right]` of a shape's anchor box, or
 *  null when its anchor cell is not in the table. */
export function tableShapeBox(
  content: LoweredContent,
  widths: readonly number[],
  origin: [number, number],
  s: LoweredShape,
): [number, number, number, number] | null {
  return tablePictureBox(content, widths, origin, {
    id: s.id,
    row: s.row,
    col: s.col,
    dx: s.dx,
    dy: s.dy,
    wPt: s.wPt,
    hPt: s.hPt,
    inCell: false,
    uri: "",
  });
}

/** The ops that create one contour set as a path and paint it. */
function itemOps(
  s: LoweredShape,
  item: LoweredShapeItem,
  pageId: PageId,
  left: number,
  top: number,
  link?: { handle: string; url: string },
): Mutation[] {
  const at = (p: [number, number]): [number, number] => [
    left + p[0],
    top + p[1],
  ];
  const specs = item.anchors.map((a) => ({
    anchor: at(a.anchor),
    left: at(a.left),
    right: at(a.right),
  }));
  const starts = item.subpathStarts ?? [];
  const first = starts.length > 1 ? specs.slice(0, starts[1]) : specs;
  const set = (path: PropertyPath, value: Value): Mutation => ({
    op: "setElementProperty",
    args: { elementId: CREATED, path, value },
  });
  const fx = s.fx;
  const ops: Mutation[] = [
    { op: "insertPath", args: { pageId, anchors: first, open: !item.closed } },
  ];
  if (link) ops.push({ op: "bindCreated", args: { handle: link.handle } });
  if (starts.length > 1) {
    ops.push(
      set("framePath", {
        type: "framePath",
        value: { anchors: specs, subpathStarts: starts },
      }),
    );
  }
  // Nothing the shape does not state: a path starts unfilled and unstroked.
  ops.push(set("frameFillColor", colorRef(NONE)));
  ops.push(set("frameStrokeColor", colorRef(NONE)));
  const painted = nativeFxOps(fx, {
    target: CREATED,
    color: chartColor,
    gradient: chartGradientId,
    filled: item.filled,
  });
  ops.push(...painted);
  // A contour the geometry marks unfilled or unstroked (a preset's detail
  // path) stays so over the shape's paint.
  if (!item.filled) ops.push(set("frameFillColor", colorRef(NONE)));
  if (!item.stroked) ops.push(set("frameStrokeColor", colorRef(NONE)));
  // The shape's click action: an item hyperlink (engine ADR 1026), on its
  // first path (the sheet ADR 531).
  if (link) {
    ops.push({
      op: "insertItemHyperlink",
      args: { item: `$h:${link.handle}`, url: link.url, name: s.id },
    } as unknown as Mutation);
  }
  return ops;
}

/** The ops that draw `content`'s shapes over its table: the colour and
 *  gradient swatches they paint with first (minted once, under the same
 *  read-first ruling as every mint: `null`, a failed read, mints none), then
 *  per shape one path per outline. */
export function tableShapeOps(
  content: LoweredContent,
  widths: readonly number[],
  pageId: PageId,
  origin: [number, number],
  knownSwatchIds?: KnownSwatchIds,
): Mutation[] {
  const drawn: Mutation[] = [];
  const hexes = new Set<string>();
  const gradients = new Map<
    string,
    NonNullable<LoweredShape["fx"]>["gradient"]
  >();
  (content.shapes ?? []).forEach((s, si) => {
    const box = tableShapeBox(content, widths, origin, s);
    if (!box) return;
    let linked = false;
    for (const item of s.items) {
      if (item.anchors.length < 2) continue;
      const link: { handle: string; url: string } | undefined =
        s.link && !linked ? { handle: `shp${si}`, url: s.link } : undefined;
      if (link) linked = true;
      drawn.push(...itemOps(s, item, pageId, box[1], box[0], link));
    }
    for (const c of nativeFxColors(s.fx, true)) {
      const h = normalizePaletteHex(c);
      if (h != null) hexes.add(h);
    }
    const g = s.fx?.gradient;
    if (g) gradients.set(chartGradientId(g), g);
  });
  if (drawn.length === 0) return [];
  return [
    ...swatchMintOps("chart", [...hexes], knownSwatchIds),
    ...chartGradientMintOps(
      [...gradients.values()].filter((g) => g != null),
      knownSwatchIds,
    ),
    ...drawn,
  ];
}

/** What the page cannot hold of `content`'s shapes, one line per kind. */
export function tableShapeLosses(content: LoweredContent): string[] {
  return [...new Set((content.shapes ?? []).flatMap((s) => s.losses ?? []))];
}
