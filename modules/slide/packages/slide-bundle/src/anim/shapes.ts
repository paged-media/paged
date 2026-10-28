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

// The shapes on a slide's page, as animations name them (slide ADR 714).
// The importer writes each PowerPoint shape as one or more page items (an
// outline, a stroke-only detail, a text frame), all labelled with the
// shape's key (`<slide part>#<cNvPr id>`); a shape made in the editor has a
// `new:` key or none. A timing names a shape by the page item it became and
// by that key: the item wins while it is on the page, the key finds the
// shape on a duplicated slide (whose items have new ids).

import type {
  BundleHost,
  ElementId,
  SceneTreeNode,
} from "@paged-media/plugin-api";

import { LABEL_KEY } from "../object-model.js";
import type { Box, TargetRef } from "./model.js";

/** One page item, bottom first on its page. */
export interface PageItem {
  id: ElementId;
  /** Its shape key, or null. */
  key: string | null;
  /** Position among the page's top-level items, bottom first. */
  z: number;
  box: Box;
}

/** One shape: the items that share its key (or one unkeyed item). */
export interface PageShape {
  key: string | null;
  /** Every item of the shape, bottom first. */
  items: PageItem[];
  /** Its text frame, if it has one. */
  text: PageItem | null;
  /** Its items without the text frame (`p:bg`). */
  art: PageItem[];
  box: Box;
}

export interface PageShapes {
  pageId: string;
  /** Top-level items, bottom first. */
  items: PageItem[];
  shapes: PageShape[];
}

export const idOf = (e: ElementId): string =>
  typeof e.id === "string" ? e.id : JSON.stringify(e.id);

/** The shape key in an item's slide label, or null. */
export function shapeKeyOf(
  meta: SceneTreeNode["pluginMetadata"] | undefined,
): string | null {
  const raw = meta?.find((m) => m.key === LABEL_KEY)?.value;
  if (!raw) return null;
  try {
    const env = JSON.parse(raw) as { data?: { shape?: unknown } };
    const k = env.data?.shape;
    return typeof k === "string" && k !== "" ? k : null;
  } catch {
    return null;
  }
}

/** The page box of a geometry row (its bounds through its transform). */
export function boxOf(g: {
  bounds: readonly number[];
  itemTransform?: readonly number[] | null;
}): Box {
  const [top, left, bottom, right] = g.bounds;
  const [a, b, c, d, tx, ty] = g.itemTransform ?? [1, 0, 0, 1, 0, 0];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ]) {
    xs.push(a * x + c * y + tx);
    ys.push(b * x + d * y + ty);
  }
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function union(boxes: readonly Box[]): Box {
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w));
  const btm = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: r - x, h: btm - y };
}

/** Group a page's items into shapes by their keys. */
export function groupShapes(items: readonly PageItem[]): PageShape[] {
  const out: PageShape[] = [];
  const byKey = new Map<string, PageShape>();
  for (const it of items) {
    let s = it.key ? byKey.get(it.key) : undefined;
    if (!s) {
      s = { key: it.key, items: [], text: null, art: [], box: it.box };
      out.push(s);
      if (it.key) byKey.set(it.key, s);
    }
    s.items.push(it);
    if (it.id.kind === "textFrame" && !s.text) s.text = it;
    else s.art.push(it);
    s.box = union(s.items.map((i) => i.box));
  }
  return out;
}

/** Every page's top-level items and shapes: one tree read and one geometry
 *  read for the whole document. */
export async function pageShapes(
  host: BundleHost,
): Promise<Map<string, PageShapes>> {
  const rows: { id: ElementId; key: string | null }[] = [];
  const walk = (nodes: readonly SceneTreeNode[] | undefined) => {
    for (const n of nodes ?? []) {
      // A row with an id is a page item; its members are part of it (a
      // group is one layer with its members).
      if (n.id) rows.push({ id: n.id, key: shapeKeyOf(n.pluginMetadata) });
      else walk(n.children);
    }
  };
  walk(await host.document.tree());
  const out = new Map<string, PageShapes>();
  if (rows.length === 0) return out;
  const geometry = await host.document.elementGeometry(rows.map((r) => r.id));
  const byId = new Map(geometry.map((g) => [idOf(g.id), g]));
  for (const r of rows) {
    const g = byId.get(idOf(r.id));
    if (!g?.pageId) continue;
    let page = out.get(g.pageId);
    if (!page) {
      page = { pageId: g.pageId, items: [], shapes: [] };
      out.set(g.pageId, page);
    }
    page.items.push({
      id: r.id,
      key: r.key,
      z: page.items.length,
      box: boxOf(g as { bounds: number[]; itemTransform?: number[] | null }),
    });
  }
  for (const page of out.values()) page.shapes = groupShapes(page.items);
  return out;
}

/** The shape a target names on a page: its item while that is on the page,
 *  else the shape with its key. */
export function resolveTarget(
  t: TargetRef,
  page: PageShapes | undefined,
): PageShape | null {
  if (!page) return null;
  if (t.item) {
    const s = page.shapes.find((x) => x.items.some((i) => idOf(i.id) === t.item));
    if (s) return s;
  }
  if (t.key) {
    const s = page.shapes.find((x) => x.key === t.key);
    if (s) return s;
  }
  return null;
}

/** The target an effect added to `item` names: the item, its shape key
 *  and, for a shape from the deck, its spid (the key's last id). */
export function targetOf(page: PageShapes | undefined, item: ElementId): TargetRef {
  const id = idOf(item);
  const shape = page?.shapes.find((s) => s.items.some((i) => idOf(i.id) === id));
  const key = shape?.key ?? null;
  const spid = key && !key.startsWith("new:") ? (key.split(/[#/]/).pop() ?? "") : "";
  // The item a timing names is the shape's first non-text item (what the
  // importer names), else its text frame.
  const named = shape ? (shape.art[0] ?? shape.text ?? null) : null;
  return {
    spid: /^\d+$/.test(spid) ? spid : "",
    item: named ? idOf(named.id) : id,
    key,
  };
}
