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

// Lasso select (wave 2) — drag a freehand region; on release every
// leaf element whose BOUNDS CENTER falls inside the lasso polygon
// (draw-geometry's `pointInPolygon`) becomes the selection.
//
// ENUMERATION (honest + cheap): the document's leaf elements come
// from the `host.document.tree()` read door (the select-same
// flattener, `leafIdsOf`) and ONE `host.document.elementGeometry`
// call answers every candidate's bounds + item transform — no
// per-point hitTest grid sampling needed. Each element's raw
// GeometricBounds center is mapped through its item transform into
// page space and tested against the polygon.
//
// HONEST v0 SEMANTICS:
//   · CENTERS-inside, not intersection — an element overlapping the
//     region whose center lies outside is NOT selected (documented;
//     a true marquee-intersection test needs per-element outline
//     geometry).
//   · An empty lasso CLEARS the selection (the marquee convention).
//   · Group members are matched as leaves (the tree flattener descends
//     into groups — the same choice select-same makes).

import type {
  BundleHost,
  CanvasPointerEvent,
  ElementGeometryItem,
  ElementId,
  GestureHandler,
} from "@paged-media/plugin-api";

import {
  applyAffine,
  dist,
  pointInPolygon,
  type Vec2,
} from "@paged-media/draw-geometry";

import { leafIdsOf } from "../commands/select-same";

/** Screen-space decimation floor between recorded lasso points. */
const MIN_SAMPLE_PX = 3;

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
 *  the pure core, exported for the conformance spec. */
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

export function createLassoSelectHandler(host: BundleHost): GestureHandler {
  let points: Vec2[] = [];
  let pageId: string | null = null;
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

  const commit = async (polygon: readonly Vec2[], onPage: string) => {
    const roots = await host.document.tree();
    const leaves = leafIdsOf(roots);
    if (leaves.length === 0) {
      await host.selection.set([]);
      return;
    }
    const items = await host.document.elementGeometry(leaves);
    const matches = lassoMatches(
      items.filter((i) => i.pageId === onPage),
      polygon,
    );
    // Empty region ⇒ selection clears (the marquee convention).
    await host.selection.set(matches);
  };

  return {
    onActivate() {
      /* per-drag state allocates on pointer-down */
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
      const polygon =
        e.pageId === onPage && e.pagePoint ? [...points, e.pagePoint] : points;
      reset();
      if (polygon.length < 3) return; // a click / short drag is no region
      void commit(polygon, onPage).catch((err) =>
        host.log.warn(`lassoSelect failed: ${err}`),
      );
    },
    onKey(e: KeyboardEvent) {
      if (e.key === "Escape") reset();
    },
  };
}
