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

// GLOBAL EDIT — select every object whose GEOMETRY matches the selected
// one's (Illustrator's Start Global Edit, its selection half).
//
// WHAT "MATCHES" MEANS is draw-geometry's `sameShape`: the same contour
// structure (anchor count, contour boundaries, open flags) and every
// anchor and handle within `tolerance` pt of its partner, POSITION
// ignored. Size counts unless the payload says `anySize: true`, which
// matches a uniformly scaled copy too. A rotated, skewed or mirrored copy
// never matches (Illustrator's does not either). Each table is compared
// in PAGE space — the anchors through the element's own `itemTransform` —
// so a copy that was moved with a transform rather than with its points
// still matches; the page's origin is a translation and falls out.
//
// WHAT IT IS NOT. Illustrator's Global Edit is a MODE: an edit to one
// selected object is replayed on the others while it lasts. This is the
// selection only. Every edit that already applies to a multi-selection
// (fill, stroke, opacity, a transform) then reaches all of them; a POINT
// edit on one path does not propagate, because no door replays one
// element's `framePath` change onto another. Pure selection, no mutation,
// so no undo step.
//
// WHAT IT COSTS: one `pathAnchors` read per leaf (the door takes one id),
// in parallel windows, kept per document revision (the link index's
// cache) — a second Global Edit on an unchanged document reads nothing.
// A leaf whose structure key differs from the reference's is skipped
// before any point is compared.

import type {
  BundleHost,
  Disposable,
  ElementId,
} from "@paged-media/plugin-api";
import {
  applyAffine,
  ovalToPath,
  rectToPath,
  sameShape,
  shapeStructureKey,
  SAME_SHAPE_TOLERANCE,
  type Affine,
  type AnchorTable,
} from "@paged-media/draw-geometry";

import { leafIdsOf, linkIndex } from "../link-index";
import { registerCommand } from "../command-registry";
import { defineMessages } from "@paged-media/strings";
import { SELECT_SAME_COMMAND_CATEGORY } from "./select-same";

const M = defineMessages("draw.globalEdit", {
  title: "Global Edit: select objects of the same shape",
});

export const GLOBAL_EDIT_COMMAND_ID = "media.paged.draw.command.globalEdit";

/** The contributed command ids, in registration order. */
export const GLOBAL_EDIT_COMMAND_IDS = [GLOBAL_EDIT_COMMAND_ID];

/** The largest tolerance a payload may ask for (pt) — past it every
 *  shape with the reference's structure would match. */
export const MAX_GLOBAL_EDIT_TOLERANCE = 100;

/** What a Global Edit compares by. */
export interface GlobalEditOptions {
  /** Per-point slack, pt (inclusive). */
  tolerance: number;
  /** Match a uniformly scaled copy too. */
  anySize: boolean;
}

/** A payload as options: a finite tolerance ≥ 0 (clamped; anything else
 *  is the default), `anySize` only when it is `true`. */
export function globalEditOptionsOf(payload: unknown): GlobalEditOptions {
  const p =
    payload !== null && typeof payload === "object"
      ? (payload as { tolerance?: unknown; anySize?: unknown })
      : {};
  const t = p.tolerance;
  const tolerance =
    typeof t === "number" && Number.isFinite(t) && t >= 0
      ? Math.min(t, MAX_GLOBAL_EDIT_TOLERANCE)
      : SAME_SHAPE_TOLERANCE;
  return { tolerance, anySize: p.anySize === true };
}

/** `table` through `m` (an affine moves a Bézier's control points
 *  exactly). */
function mapped(table: AnchorTable, m: Affine | null): AnchorTable {
  const at = (p: readonly [number, number]): [number, number] =>
    m ? applyAffine(m, p[0], p[1]) : [p[0], p[1]];
  return {
    anchors: table.anchors.map((a) => ({
      anchor: at(a.anchor),
      left: at(a.left),
      right: at(a.right),
    })),
    subpathStarts: table.subpathStarts.length > 0 ? table.subpathStarts : [0],
    ...(table.subpathOpen && table.subpathOpen.length > 0
      ? { subpathOpen: table.subpathOpen }
      : {}),
  };
}

/** One element's anchor table in PAGE space, or null when it has none.
 *  A rectangle or oval that stores no path (`pathAnchors` answers an
 *  empty table for a frame known only by its bounds, and never a curve
 *  for an oval) is DERIVED from its box — the shape the renderer draws. */
async function pageTableOf(
  host: BundleHost,
  id: ElementId,
): Promise<AnchorTable | null> {
  const r = await host.document.pathAnchors(id).catch(() => null);
  if (r && r.anchors.length > 0) {
    return mapped(r, (r.itemTransform ?? null) as Affine | null);
  }
  if (id.kind !== "rectangle" && id.kind !== "oval") return null;
  const item = (await host.document.elementGeometry([id]).catch(() => []))[0];
  if (!item) return null;
  const [top, left, bottom, right] = item.bounds;
  const table =
    id.kind === "oval"
      ? ovalToPath(item.bounds)
      : rectToPath(left, top, right - left, bottom - top);
  if (table.anchors.length === 0) return null;
  return mapped(table, (item.itemTransform ?? null) as Affine | null);
}

const READ_WINDOW = 64;
const SHAPES_KEY = "global-edit:shapes";

type LeafShape = { id: ElementId; table: AnchorTable | null };

const sameElement = (a: ElementId, b: ElementId): boolean =>
  a.kind === b.kind && a.id === b.id;

/** Every leaf's page-space table, in tree order, once per revision. */
function leafShapes(host: BundleHost): Promise<LeafShape[]> {
  const index = linkIndex(host);
  return index.cached(SHAPES_KEY, async () => {
    const leaves = leafIdsOf(await index.tree());
    const out: LeafShape[] = new Array(leaves.length);
    for (let at = 0; at < leaves.length; at += READ_WINDOW) {
      await Promise.all(
        leaves.slice(at, at + READ_WINDOW).map(async (id, i) => {
          out[at + i] = { id, table: await pageTableOf(host, id) };
        }),
      );
    }
    return out;
  });
}

/** Every leaf whose geometry matches `reference`'s (the reference
 *  included). `[]` when the reference reports no anchor table. Exported
 *  for the conformance spec. */
export async function globalEditMatches(
  host: BundleHost,
  reference: ElementId,
  options: Partial<GlobalEditOptions> = {},
): Promise<ElementId[]> {
  const cached = await linkIndex(host).peek<LeafShape[]>(SHAPES_KEY);
  const ref =
    cached?.find((l) => sameElement(l.id, reference))?.table ??
    (await pageTableOf(host, reference));
  if (!ref) return [];
  const key = shapeStructureKey(ref);
  const leaves = cached ?? (await leafShapes(host));
  return leaves
    .filter(
      (l) =>
        l.table !== null &&
        shapeStructureKey(l.table) === key &&
        sameShape(ref, l.table, options),
    )
    .map((l) => l.id);
}

/** The command: the first selected element is the reference. Answers the
 *  new selection (empty = a no-op, logged). */
export async function applyGlobalEdit(
  host: BundleHost,
  payload?: unknown,
): Promise<ElementId[]> {
  const label = GLOBAL_EDIT_COMMAND_ID;
  const selection = host.selection.get();
  if (selection.length === 0) {
    host.log.debug(`${label}: no reference selected — no-op`);
    return [];
  }
  const matches = await globalEditMatches(
    host,
    selection[0]!,
    globalEditOptionsOf(payload),
  );
  if (matches.length === 0) {
    host.log.debug(`${label}: the reference reports no path geometry — no-op`);
    return [];
  }
  await host.selection.set(matches);
  return matches;
}

/** Register Global Edit. Pure selection — no document mutation. */
export function contributeGlobalEditCommand(host: BundleHost): Disposable {
  return registerCommand(host, {
    id: GLOBAL_EDIT_COMMAND_ID,
    title: M.title,
    category: SELECT_SAME_COMMAND_CATEGORY,
    handler: async (_paged, payload) => {
      await applyGlobalEdit(host, payload);
    },
  });
}
