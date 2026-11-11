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
// outline the engine evaluated (the preset and custom geometry, flipped in
// Rust), at the shape's anchor cell in the table's own column widths plus
// its offset, painted by the DrawingML look the shared mapper lowered.
//
// Engine ADR 1096 — a preset item is the engine's live preset: the path is
// inserted as the engine draws the preset and given it (`frameShapePreset`)
// in the same batch, its rotation is the item's transform, so the host's
// tools resize it as a preset and its adjust handles work. Unlike the
// pictures and data bars, a shape is created ONCE and kept: every item
// carries a stamp (the plugin's metadata: the sheet shape's id, the item,
// a hash of what the workbook drew) and a refresh leaves a stamped shape as
// the user edited it. It is drawn again only when the workbook's shape
// changed (its hash), created when it is missing and removed when the
// workbook no longer has it.

import type {
  ElementId,
  Mutation,
  PageId,
  PropertyPath,
  Value,
} from "@paged-media/plugin-api";
import { nativeFxColors, nativeFxOps } from "@paged-media/plugin-sdk";

import { BINDING_KEY, contentHash } from "./binding";
import { chartGradientId, chartGradientMintOps } from "./chart";
import type { LoweredContent, LoweredShape, LoweredShapeItem } from "./lowered";
import { normalizePaletteHex, paletteSwatchId, swatchMintOps } from "./palette";
import type { KnownSwatchIds } from "./palette";
import { tablePictureBox } from "./table-pictures";

const CREATED = { kind: "polygon", id: "$created" } as const;
const NONE = "Swatch/None";

/** The batch handle prefix of a shape item: `minted` names the items a
 *  batch created by it, so they are told from the bars and pictures. */
export const SHAPE_HANDLE_PREFIX = "sheetShape_";

const chartColor = (hex: string): string =>
  paletteSwatchId("chart", normalizePaletteHex(hex) ?? "000000");

const colorRef = (id: string): Value => ({ type: "colorRef", value: id });

/** The stamp a shape item carries (the plugin's metadata, `{v: 1, shape}`;
 *  no `data`, so no binding reader takes it for a placed frame). */
export interface ShapeStamp {
  /** The workbook shape's id (`<drawing part>#<anchor index>`). */
  id: string;
  /** The item's index in the shape's items. */
  item: number;
  /** A hash of the shape as the workbook drew it. */
  hash: string;
  /** The sheet (index) it was drawn from. */
  sheet?: number;
  /** The table frame it was drawn over, once known. */
  table?: string;
}

/** The metadata value of `stamp`. */
export function shapeStampValue(stamp: ShapeStamp): string {
  return JSON.stringify({ v: 1, shape: stamp });
}

/** The stamp in a metadata value, or null when it holds none. */
export function parseShapeStamp(value: string): ShapeStamp | null {
  try {
    const env = JSON.parse(value) as { v?: unknown; shape?: unknown };
    if (env.v !== 1 || typeof env.shape !== "object" || env.shape === null)
      return null;
    const s = env.shape as Record<string, unknown>;
    if (
      typeof s.id !== "string" ||
      typeof s.item !== "number" ||
      typeof s.hash !== "string"
    )
      return null;
    return {
      id: s.id,
      item: s.item,
      hash: s.hash,
      ...(typeof s.sheet === "number" ? { sheet: s.sheet } : {}),
      ...(typeof s.table === "string" ? { table: s.table } : {}),
    };
  } catch {
    return null;
  }
}

/** A hash of a shape as the workbook draws it (its place in its cell, its
 *  outline, its look): a refresh draws a kept shape again only when this
 *  changed. */
export function shapeHash(s: LoweredShape): string {
  return contentHash(s);
}

/** A shape already on the page: its items' elements and its stamp. */
export interface PlacedShape {
  id: string;
  hash: string;
  items: ElementId[];
  /** The table frame its stamp names, if any. */
  table?: string;
}

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

/** Where a shape item is drawn: its page, the anchor box's page-local
 *  top-left, and the page's origin in its spread (the coordinates the
 *  raw writes — `framePath`, `frameShapePreset`, `frameTransform` — take;
 *  `insertPath` takes page coordinates). */
interface ItemPlace {
  pageId: PageId;
  left: number;
  top: number;
  pageOrigin: [number, number];
}

/** The ops that create one contour set as a path and paint it. */
function itemOps(
  s: LoweredShape,
  item: LoweredShapeItem,
  at: ItemPlace,
  handle: string,
  stamp: ShapeStamp,
  link?: string,
): Mutation[] {
  const { pageId, left, top } = at;
  const [ox, oy] = at.pageOrigin;
  const onPage = (p: [number, number]): [number, number] => [
    left + p[0],
    top + p[1],
  ];
  const inSpread = (p: [number, number]): [number, number] => [
    left + ox + p[0],
    top + oy + p[1],
  ];
  const specs = (to: typeof onPage) =>
    item.anchors.map((a) => ({
      anchor: to(a.anchor),
      left: to(a.left),
      right: to(a.right),
    }));
  const starts = item.subpathStarts ?? [];
  const page = specs(onPage);
  const first = starts.length > 1 ? page.slice(0, starts[1]) : page;
  const set = (path: PropertyPath, value: Value): Mutation => ({
    op: "setElementProperty",
    args: { elementId: CREATED, path, value },
  });
  const fx = s.fx;
  const ops: Mutation[] = [
    { op: "insertPath", args: { pageId, anchors: first, open: !item.closed } },
    { op: "bindCreated", args: { handle } },
  ];
  if (starts.length > 1) {
    ops.push(
      set("framePath", {
        type: "framePath",
        value: { anchors: specs(inSpread), subpathStarts: starts },
      }),
    );
  }
  // Engine ADR 1096 — the item is the preset it was drawn from, its box
  // where the anchors are (the anchors already are what it draws, so the
  // engine only records it).
  if (item.preset) {
    const [fx0, fy0, w, h] = item.preset.frame;
    const [x, y] = inSpread([fx0, fy0]);
    ops.push(
      set("frameShapePreset", {
        type: "text",
        value: JSON.stringify({ ...item.preset, frame: [x, y, w, h] }),
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
  // A live preset's rotation: the item's transform about the anchor box's
  // centre, in spread coordinates.
  if (s.transform) {
    const [a, b, c, d, e, f] = s.transform;
    const [tx, ty] = [left + ox, top + oy];
    ops.push(
      set("frameTransform", {
        type: "transform",
        value: [a, b, c, d, e + tx - a * tx - c * ty, f + ty - b * tx - d * ty],
      }),
    );
  }
  // Office's line ends (engine ADR 1093, amendment 2), and the nearest
  // InDesign arrowhead beside them for a writer without Office's (IDML).
  if (item.startArrowhead) {
    ops.push(
      set("frameStrokeStartArrowhead", {
        type: "text",
        value: item.startArrowhead,
      }),
    );
  }
  if (item.endArrowhead) {
    ops.push(
      set("frameStrokeEndArrowhead", {
        type: "text",
        value: item.endArrowhead,
      }),
    );
  }
  if (item.startHead) {
    ops.push(
      set("frameStrokeStartOfficeHead", {
        type: "text",
        value: JSON.stringify(item.startHead),
      }),
    );
  }
  if (item.endHead) {
    ops.push(
      set("frameStrokeEndOfficeHead", {
        type: "text",
        value: JSON.stringify(item.endHead),
      }),
    );
  }
  ops.push({
    op: "setPluginMetadata",
    args: {
      elementId: CREATED,
      key: BINDING_KEY,
      value: shapeStampValue(stamp),
    },
  } as Mutation);
  // The shape's click action: an item hyperlink (engine ADR 1026), on its
  // first path (the sheet ADR 531).
  if (link) {
    ops.push({
      op: "insertItemHyperlink",
      args: { item: `$h:${handle}`, url: link, name: s.id },
    } as unknown as Mutation);
  }
  return ops;
}

/** How {@link tableShapeOps} treats the shapes already on the page. */
export interface TableShapeOptions {
  /** The page's origin in its spread (`PageSummary.pageOrigin`); `[0, 0]`
   *  when not known. */
  pageOrigin?: [number, number];
  /** The shapes of this table already on the page, by workbook shape id:
   *  kept as they are unless the workbook's shape changed. */
  placed?: ReadonlyMap<string, PlacedShape>;
  /** The table frame the shapes are drawn over (stamped on new items, and
   *  on kept items that do not name it yet). */
  table?: string;
  /** The sheet (index) they are drawn from. */
  sheet?: number;
}

/** The ops that draw `content`'s shapes over its table: the colour and
 *  gradient swatches they paint with first (minted once, under the same
 *  read-first ruling as every mint: `null`, a failed read, mints none), then
 *  per shape one path per outline. A shape in `opts.placed` whose hash is
 *  unchanged is kept (no op, or its stamp completed with the table); one
 *  whose hash changed is removed and drawn again; a placed shape the
 *  content no longer has is removed. */
export function tableShapeOps(
  content: LoweredContent,
  widths: readonly number[],
  pageId: PageId,
  origin: [number, number],
  knownSwatchIds?: KnownSwatchIds,
  opts: TableShapeOptions = {},
): Mutation[] {
  const drawn: Mutation[] = [];
  const kept: Mutation[] = [];
  const removed: Mutation[] = [];
  const hexes = new Set<string>();
  const gradients = new Map<
    string,
    NonNullable<LoweredShape["fx"]>["gradient"]
  >();
  const placed = opts.placed ?? new Map<string, PlacedShape>();
  const shown = new Set<string>();
  const remove = (p: PlacedShape) => {
    for (const id of p.items)
      removed.push({ op: "deleteFrame", args: { frameId: id.id as string } });
  };
  (content.shapes ?? []).forEach((s, si) => {
    const box = tableShapeBox(content, widths, origin, s);
    if (!box) return;
    shown.add(s.id);
    const hash = shapeHash(s);
    const before = placed.get(s.id);
    if (before && before.hash === hash) {
      // Kept as the user left it; its stamp learns the table it is over.
      if (opts.table !== undefined && before.table !== opts.table) {
        before.items.forEach((element, item) => {
          kept.push({
            op: "setPluginMetadata",
            args: {
              elementId: element,
              key: BINDING_KEY,
              value: shapeStampValue({
                id: s.id,
                item,
                hash,
                ...(opts.sheet !== undefined ? { sheet: opts.sheet } : {}),
                table: opts.table,
              }),
            },
          } as Mutation);
        });
      }
      return;
    }
    if (before) remove(before);
    const at: ItemPlace = {
      pageId,
      left: box[1],
      top: box[0],
      pageOrigin: opts.pageOrigin ?? [0, 0],
    };
    let linked = false;
    let any = false;
    s.items.forEach((item, k) => {
      if (item.anchors.length < 2) return;
      const link = s.link && !linked ? s.link : undefined;
      if (link) linked = true;
      any = true;
      drawn.push(
        ...itemOps(
          s,
          item,
          at,
          `${SHAPE_HANDLE_PREFIX}${si}_${k}`,
          {
            id: s.id,
            item: k,
            hash,
            ...(opts.sheet !== undefined ? { sheet: opts.sheet } : {}),
            ...(opts.table !== undefined ? { table: opts.table } : {}),
          },
          link,
        ),
      );
    });
    if (!any) return;
    for (const c of nativeFxColors(s.fx, true)) {
      const h = normalizePaletteHex(c);
      if (h != null) hexes.add(h);
    }
    const g = s.fx?.gradient;
    if (g) gradients.set(chartGradientId(g), g);
  });
  for (const [id, p] of placed) if (!shown.has(id)) remove(p);
  if (drawn.length === 0) return [...removed, ...kept];
  return [
    ...removed,
    ...kept,
    ...swatchMintOps("chart", [...hexes], knownSwatchIds),
    ...chartGradientMintOps(
      [...gradients.values()].filter((g) => g != null),
      knownSwatchIds,
    ),
    ...drawn,
  ];
}

/** The shapes of a table already on the page, from the scene tree's items
 *  and their stamps: those stamped with `table`, and those stamped with no
 *  table but drawn from `sheet` (a table placed in one batch could not name
 *  its frame yet), by workbook shape id. An item a shape has twice keeps
 *  the first. */
export function placedShapesIn(
  roots: readonly SceneNode[],
  table: string,
  sheet?: number,
): Map<string, PlacedShape> {
  const out = new Map<string, PlacedShape>();
  const walk = (nodes: readonly SceneNode[]) => {
    for (const n of nodes) {
      const entry = n.id
        ? n.pluginMetadata?.find((m) => m.key === BINDING_KEY)
        : undefined;
      const stamp = entry ? parseShapeStamp(entry.value) : null;
      if (
        n.id &&
        stamp &&
        (stamp.table === table ||
          (stamp.table === undefined &&
            (sheet === undefined ||
              stamp.sheet === undefined ||
              stamp.sheet === sheet)))
      ) {
        const p = out.get(stamp.id) ?? {
          id: stamp.id,
          hash: stamp.hash,
          items: [],
          ...(stamp.table !== undefined ? { table: stamp.table } : {}),
        };
        if (p.items[stamp.item] === undefined) p.items[stamp.item] = n.id;
        // Items stamped by different drawings of the shape: drawn again.
        if (p.hash !== stamp.hash) p.hash = "";
        out.set(stamp.id, p);
      }
      if (n.children) walk(n.children);
    }
  };
  walk(roots);
  for (const p of out.values()) p.items = p.items.filter((i) => i != null);
  return out;
}

/** A scene-tree row as {@link placedShapesIn} reads it. */
export interface SceneNode {
  id?: ElementId | null;
  pluginMetadata?: { key: string; value: string }[];
  children?: SceneNode[];
}

/** Engine ADR 1096 — what a shape item's live preset on the page asks the
 *  workbook to write (`SheetEngine.setShapePreset`): its workbook shape id,
 *  the preset's name and adjust values. Null for an item that is not the
 *  shape's first, a `frameShapePreset` that is empty (the path was
 *  reshaped: the workbook keeps its geometry) or not a preset. */
export function shapePresetWrite(
  stamp: ShapeStamp,
  presetText: string,
): { id: string; name: string; adjusts: [string, string][] } | null {
  if (stamp.item !== 0 || presetText.trim() === "") return null;
  try {
    const p = JSON.parse(presetText) as {
      name?: unknown;
      adjusts?: unknown;
    };
    if (typeof p.name !== "string") return null;
    const adjusts = Array.isArray(p.adjusts)
      ? (p.adjusts as unknown[]).filter(
          (a): a is [string, string] =>
            Array.isArray(a) &&
            a.length === 2 &&
            typeof a[0] === "string" &&
            typeof a[1] === "string",
        )
      : [];
    return { id: stamp.id, name: p.name, adjusts };
  } catch {
    return null;
  }
}

/** What the page cannot hold of `content`'s shapes, one line per kind. */
export function tableShapeLosses(content: LoweredContent): string[] {
  return [...new Set((content.shapes ?? []).flatMap((s) => s.losses ?? []))];
}
