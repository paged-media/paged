/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// WP4.4 — the reads Align and Transform Each plan from, through the
// canvas client: each target's transformed box in SPREAD space and its
// page (`elementGeometry`), a group's stored transform
// (`elementProperties`), and every page's spread-space box and margins
// (the `pages` collection, WP2.7). The writes go through `host.objects`
// (transform-targets.ts).

import type { ElementId } from "@paged-media/client";
import { parseAddress, toElementId } from "@paged-media/plugin-sdk";

import type { AlignPage } from "./align-plan";
import {
  transformBounds,
  type Affine,
  type Bounds,
  type SpreadTarget,
} from "./transform-targets";

/** The slice of the canvas client these reads use. */
export interface SpreadReadClient {
  elementGeometry(ids: ElementId[]): Promise<
    ReadonlyArray<{
      id: ElementId;
      pageId?: string | null;
      spreadId?: string | null;
      bounds: readonly number[];
      itemTransform?: readonly number[] | null;
      pageOrigin?: readonly number[] | null;
    }>
  >;
  elementProperties(id: ElementId): Promise<{
    entries: ReadonlyArray<{
      path: string;
      value?: { type: string; value?: unknown } | null;
    }>;
  } | null>;
  collection<T>(name: "pages"): Promise<readonly T[]>;
}

/** The page fields Align reads (`PageSummary`). */
interface PageRow {
  selfId: string;
  sizePt: [number, number];
  pageOrigin?: [number, number] | null;
  spreadId?: string | null;
  marginTopPt?: number;
  marginLeftPt?: number;
  marginBottomPt?: number;
  marginRightPt?: number;
}

const key = (id: ElementId) => `${id.kind}:${JSON.stringify(id.id)}`;

const affineOf = (v: unknown): Affine | null =>
  Array.isArray(v) && v.length === 6 && v.every((n) => typeof n === "number")
    ? (v as unknown as Affine)
    : null;

/** Read `addresses` as spread-space targets; an address that names no
 *  page item, or that answers no geometry, is left out. `elementIdOf`
 *  resolves an address the grammar alone cannot (`frame:<id>`). */
export async function readSpreadTargets(
  client: SpreadReadClient,
  addresses: readonly string[],
  elementIdOf?: (address: string) => ElementId | null,
): Promise<SpreadTarget[]> {
  const ids: Array<{ address: string; id: ElementId }> = [];
  for (const address of addresses) {
    const parsed = parseAddress(address);
    const id =
      (parsed ? toElementId(parsed) : null) ?? elementIdOf?.(address) ?? null;
    if (id && id.kind !== "storyRange") ids.push({ address, id });
  }
  if (ids.length === 0) return [];
  // Page items and groups in two calls, as draw does: an engine that
  // refuses a group there costs the page items nothing.
  const items = ids.filter((t) => t.id.kind !== "group");
  const groups = ids.filter((t) => t.id.kind === "group");
  const read = async (list: typeof ids) =>
    list.length > 0
      ? await client.elementGeometry(list.map((t) => t.id)).catch(() => [])
      : [];
  const geometry = new Map(
    [...(await read(items)), ...(await read(groups))].map((g) => [
      key(g.id),
      g,
    ]),
  );
  const out: SpreadTarget[] = [];
  for (const { address, id } of ids) {
    const g = geometry.get(key(id));
    if (!g || g.bounds.length !== 4) continue;
    const t = affineOf(g.itemTransform);
    const o = g.pageOrigin;
    const composed: Affine | null =
      o && o.length === 2 && (o[0] !== 0 || o[1] !== 0)
        ? (() => {
            const m = t ?? ([1, 0, 0, 1, 0, 0] as const);
            return [m[0], m[1], m[2], m[3], m[4] + o[0]!, m[5] + o[1]!];
          })()
        : t;
    const target: SpreadTarget = {
      address,
      box: transformBounds(g.bounds as unknown as Bounds, composed),
      pageId: g.pageId ?? null,
      spreadId: g.spreadId ?? null,
      composed,
    };
    if (id.kind === "group") {
      const props = await client.elementProperties(id).catch(() => null);
      const entry = props?.entries.find((e) => e.path === "frameTransform");
      target.group = { stored: affineOf(entry?.value?.value) };
    }
    out.push(target);
  }
  return out;
}

/** Every page as Align sees it: its spread-space box and margins. */
export async function readAlignPages(
  client: SpreadReadClient,
): Promise<AlignPage[]> {
  const pages = await client.collection<PageRow>("pages");
  return pages.map((p) => {
    const [x, y] = p.pageOrigin ?? [0, 0];
    const [w, h] = p.sizePt;
    return {
      id: p.selfId,
      spreadId: p.spreadId ?? null,
      rect: [y, x, y + h, x + w],
      margins: {
        top: p.marginTopPt ?? 0,
        left: p.marginLeftPt ?? 0,
        bottom: p.marginBottomPt ?? 0,
        right: p.marginRightPt ?? 0,
      },
    };
  });
}
