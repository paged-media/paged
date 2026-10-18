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

// Lasso select (wave 2) — drag a freehand region; on release every leaf
// element the region TOUCHES becomes the selection.
//
// TWO RULES, chosen by the tool's `mode` option (`../tool-options.ts`,
// the double-click popover):
//
//   · "intersect" — THE DEFAULT. An element is selected when the lasso
//     region touches its OUTLINE: some point of the outline lies inside
//     the lasso, or some segment of it crosses a lasso edge
//     (draw-geometry `polylineTouchesPolygon`). For the four path-bearing
//     kinds the outline is the element's real path — its anchor table,
//     every contour flattened (`flattenAnchorRun`, open contours left
//     open) and mapped through its item transform; for any other kind,
//     or a path whose table cannot be read, it is the element's
//     TRANSFORMED BOUNDS as a closed ring. A lasso drawn wholly INSIDE a
//     big shape touches no outline and does not select it — the rule is
//     about the path, not the paint it encloses (the function's
//     documented scope).
//   · "centre" — the v0 rule, kept reachable: the element's bounds
//     CENTRE (mapped through its item transform) lies inside the lasso
//     (`pointInPolygon`). An element overlapping the region whose centre
//     is outside is NOT selected.
//
// WHAT INTERSECTION COSTS, and why it cannot be cheaper here. Enumeration
// is unchanged — the `host.document.tree()` read door (the select-same
// flattener, `leafIdsOf`) and ONE `host.document.elementGeometry` call
// for every candidate's page, bounds and transform. Intersection then
// reads `pathAnchors` once per PATH-BEARING leaf on the lasso's page
// (windowed, in parallel). The bounds cannot be used to skip those reads:
// they are STALE after a whole-path write — measured, protocol 64: a
// `framePath` write, an `offsetPath` and a Make Compound Path all leave
// `elementGeometry.bounds` at the element's ORIGINAL box — so pruning by
// bounds would miss exactly the paths that were edited. What would lower
// it: `pathAnchors` taking a list, or a `document.marqueeHits`-style
// facade that intersects in the engine. "centre" mode costs what it
// always did (two reads).
//
// Always: an empty lasso CLEARS the selection (the marquee convention);
// group members are matched as leaves (the tree flattener descends into
// groups — the same choice select-same makes).

import type {
  BundleHost,
  CanvasPointerEvent,
  ElementGeometryItem,
  ElementId,
  GestureHandler,
  PathAnchorsResult,
} from "@paged-media/plugin-api";

import {
  applyAffine,
  dist,
  flattenAnchorRun,
  pointInPolygon,
  polylineTouchesPolygon,
  type Affine,
  type Vec2,
} from "@paged-media/draw-geometry";

import { leafIdsOf } from "../commands/select-same";
import { supportsPathOps } from "../commands/path-ops";
import { LASSO_OPTIONS, createToolOptionsReader } from "../tool-options";

/** Screen-space decimation floor between recorded lasso points. */
const MIN_SAMPLE_PX = 3;

/** Path reads per parallel window (the link walk's reason: the engine
 *  worker answers in order, and one burst of N reads would queue ahead
 *  of whatever the user does next). */
const OUTLINE_READ_WINDOW = 64;

/** The lasso's selection rule — see the header. */
export type LassoMode = "intersect" | "centre";

/** One corner of the preview outline (the `ToolPreviewPath` anchor). */
interface PreviewAnchor {
  anchor: [number, number];
  left: [number, number];
  right: [number, number];
}

/** The page-space CENTER of one geometry item: the raw bounds
 *  `[top, left, bottom, right]` midpoint mapped through the item
 *  transform (identity when absent). */
export function itemCenterOnPage(item: ElementGeometryItem): Vec2 {
  const [top, left, bottom, right] = item.bounds;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const m = item.itemTransform ?? null;
  return m ? (applyAffine(m, cx, cy) as Vec2) : [cx, cy];
}

/** The ids whose page-space bounds centers fall inside `polygon` —
 *  the "centre" rule, pure, exported for the conformance spec. */
export function lassoMatches(
  items: readonly ElementGeometryItem[],
  polygon: readonly Vec2[],
): ElementId[] {
  const out: ElementId[] = [];
  for (const item of items) {
    if (pointInPolygon(itemCenterOnPage(item), polygon)) out.push(item.id);
  }
  return out;
}

/** An element's outline in PAGE space: one polyline per contour, and
 *  whether it closes. */
export interface LassoOutline {
  rings: Vec2[][];
  closed: boolean[];
}

const keyOf = (id: ElementId): string => `${id.kind}\u0000${String(id.id)}`;

/** The outline an anchor table describes, in page space: each contour
 *  flattened in the element's own space (closed contours with their
 *  closing segment) and mapped through `itemTransform`. Null when there
 *  is nothing to draw. Pure; exported for the spec. */
export function outlineOfPath(read: PathAnchorsResult): LassoOutline | null {
  const n = read.anchors.length;
  if (n === 0) return null;
  const m = (read.itemTransform ?? null) as Affine | null;
  const starts = read.subpathStarts.length > 0 ? read.subpathStarts : [0];
  const rings: Vec2[][] = [];
  const closed: boolean[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : n;
    if (to <= from) continue;
    const isClosed = read.subpathOpen?.[i] !== true;
    const flat = flattenAnchorRun(read.anchors.slice(from, to), { close: isClosed });
    rings.push(flat.map(([x, y]) => (m ? (applyAffine(m, x, y) as Vec2) : [x, y])));
    closed.push(isClosed);
  }
  return rings.length > 0 ? { rings, closed } : null;
}

/** An element's TRANSFORMED bounds as one closed ring — the outline of a
 *  kind with no path. */
export function outlineOfBounds(item: ElementGeometryItem): LassoOutline {
  const [top, left, bottom, right] = item.bounds;
  const m = item.itemTransform ?? null;
  const corners: Vec2[] = [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ];
  return {
    rings: [corners.map(([x, y]) => (m ? (applyAffine(m, x, y) as Vec2) : [x, y]))],
    closed: [true],
  };
}

/** Does `polygon` touch `outline`? */
export function lassoTouchesOutline(
  outline: LassoOutline,
  polygon: readonly Vec2[],
): boolean {
  return outline.rings.some((ring, i) =>
    polylineTouchesPolygon(ring, polygon, { closed: outline.closed[i] }),
  );
}

/** The "intersect" rule, pure (exported for the conformance spec): every
 *  item whose outline the lasso touches — its PATH outline when `paths`
 *  holds one for it, its transformed bounds otherwise. In item order. */
export function lassoIntersections(
  items: readonly ElementGeometryItem[],
  paths: ReadonlyMap<string, LassoOutline>,
  polygon: readonly Vec2[],
): ElementId[] {
  const out: ElementId[] = [];
  for (const item of items) {
    const outline = paths.get(keyOf(item.id)) ?? outlineOfBounds(item);
    if (lassoTouchesOutline(outline, polygon)) out.push(item.id);
  }
  return out;
}

/** Read the path outline of every path-bearing item (one `pathAnchors`
 *  each, windowed). An item whose table is unreadable is left out, and
 *  so falls back to its bounds. */
export async function readLassoOutlines(
  host: BundleHost,
  items: readonly ElementGeometryItem[],
): Promise<Map<string, LassoOutline>> {
  const paths = items.filter((item) => supportsPathOps(item.id));
  const out = new Map<string, LassoOutline>();
  for (let at = 0; at < paths.length; at += OUTLINE_READ_WINDOW) {
    await Promise.all(
      paths.slice(at, at + OUTLINE_READ_WINDOW).map(async (item) => {
        const read = await host.document.pathAnchors(item.id).catch(() => null);
        const outline = read ? outlineOfPath(read) : null;
        if (outline) out.set(keyOf(item.id), outline);
      }),
    );
  }
  return out;
}

export function createLassoSelectHandler(host: BundleHost): GestureHandler {
  let points: Vec2[] = [];
  let pageId: string | null = null;
  /** The rule this drag selects by — read on the press, with the floor. */
  let mode: LassoMode = "intersect";
  const options = createToolOptionsReader(LASSO_OPTIONS);
  /** The corner anchors handed to the overlay — ONE array per drag,
   *  appended to as `points` grows (the `./stroke-preview.ts` rule, in
   *  the path form: a recorded point is turned into its anchor triple
   *  once, not once per later move). Null between drags. */
  let outline: PreviewAnchor[] | null = null;
  /** `MIN_SAMPLE_PX` in page pt, converted ONCE per drag, on the press.
   *  It used to be asked of the viewport on every move (1 999 times for
   *  a 2 000-sample lasso) for a number that is the same throughout.
   *
   *  "Per drag" is as fine as the contract allows: `host.viewport` has
   *  `camera()` and `pxToPt()` and no change event, so a zoom DURING a
   *  drag cannot be noticed without asking every move — which is the
   *  cost this removes. The next press reads the new zoom. The pencil
   *  and the brushes have always fixed their tolerances this way. */
  let floorPt = 0;

  const reset = () => {
    points = [];
    outline = null;
    pageId = null;
    host.overlay.setToolPreview(null);
  };

  const preview = () => {
    if (!pageId || points.length < 2) {
      host.overlay.setToolPreview(null);
      return;
    }
    if (!outline) outline = [];
    for (let i = outline.length; i < points.length; i++) {
      const [x, y] = points[i];
      outline.push({ anchor: [x, y], left: [x, y], right: [x, y] });
    }
    // The in-flight region previews as a dashed CLOSED path (corner
    // anchors — the polygon the release will test). A fresh shape around
    // the same array: the overlay door holds one whole shape, so the
    // whole outline is still what each publish names.
    host.overlay.setToolPreview({
      pageId,
      anchors: outline,
      close: true,
      dashed: true,
    });
  };

  const commit = async (
    polygon: readonly Vec2[],
    onPage: string,
    rule: LassoMode,
  ) => {
    const roots = await host.document.tree();
    const leaves = leafIdsOf(roots);
    if (leaves.length === 0) {
      await host.selection.set([]);
      return;
    }
    const items = (await host.document.elementGeometry(leaves)).filter(
      (i) => i.pageId === onPage,
    );
    const matches =
      rule === "centre"
        ? lassoMatches(items, polygon)
        : lassoIntersections(items, await readLassoOutlines(host, items), polygon);
    // Empty region ⇒ selection clears (the marquee convention).
    await host.selection.set(matches);
  };

  return {
    onActivate(paged) {
      // Per-drag state allocates on pointer-down; this only binds the
      // options reader to the host's store.
      options.attach(paged);
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      reset();
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (e.button !== 0 || !e.pageId || !e.pagePoint) return;
      pageId = e.pageId;
      points = [e.pagePoint];
      floorPt = host.viewport.pxToPt(MIN_SAMPLE_PX);
      mode = options.select("mode") === "centre" ? "centre" : "intersect";
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!pageId || !e.pagePoint || e.pageId !== pageId) return;
      const last = points[points.length - 1];
      if (dist(last, e.pagePoint) < floorPt) return;
      points.push(e.pagePoint);
      preview();
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!pageId) return;
      const onPage = pageId;
      const rule = mode;
      const polygon =
        e.pageId === onPage && e.pagePoint ? [...points, e.pagePoint] : points;
      reset();
      if (polygon.length < 3) return; // a click / short drag is no region
      void commit(polygon, onPage, rule).catch((err) =>
        host.log.warn(`lassoSelect failed: ${err}`),
      );
    },
    onKey(e: KeyboardEvent) {
      if (e.key === "Escape") reset();
    },
  };
}
