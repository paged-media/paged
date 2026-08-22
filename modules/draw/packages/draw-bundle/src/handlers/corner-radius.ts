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

// The CORNER-RADIUS gesture tool (concept §13.2 "drag corner widgets") —
// the on-canvas handle the live-corners command module reserved via its
// exported per-corner builder. Press near a corner of the selected
// RECTANGLE, drag inward: the radius follows (clamped to half the short
// side), the overlay previews the extent, pointer-up commits ONE
// per-corner mutation (`cornerRadiiMutationFor` → RoundedCorner).
//
// Honest scope (mirrors the preset commands): RECTANGLES only — the
// engine has no polygon corner apply arm (RFI B-23); a non-rectangle
// selection is a no-op with a debug log. Axis-aligned bounds only: a
// rotated rectangle's corners don't sit on its page bounds, so the tool
// skips it (the transform-aware hit is the follow-up).

import type {
  BundleHost,
  CanvasPointerEvent,
  ElementId,
  GestureHandler,
} from "@paged-media/plugin-api";
import {
  cornerAt,
  cornerPreview,
  radiusFromDrag,
  type Bounds,
  type CornerIndex,
} from "@paged-media/draw-tools";

import { cornerRadiiMutationFor } from "../commands/live-corners";

/** Screen-space corner hit tolerance. */
const CORNER_TOL_PX = 8;

const IDENTITY: readonly number[] = [1, 0, 0, 1, 0, 0];

export function createCornerRadiusHandler(host: BundleHost): GestureHandler {
  let target: ElementId | null = null;
  let bounds: Bounds | null = null;
  let corner: CornerIndex | null = null;
  let pageId: string | null = null;
  let radius = 0;

  const reset = () => {
    target = null;
    bounds = null;
    corner = null;
    pageId = null;
    radius = 0;
    host.overlay.setToolPreview(null);
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
      const selection = host.selection.get();
      const rect = selection.find(
        (id) => (id as { kind?: string }).kind === "rectangle",
      );
      if (!rect) {
        // Rectangle-only HERE is a HANDLE-GEOMETRY limit, not an engine
        // one: B-23/C-18 closed the polygon apply arm and the presets in
        // commands/live-corners.ts now drive it, but `cornerAt` hit-tests
        // the four corners of an axis-aligned BOX. An N-gon's corners are
        // its anchors, which this handler cannot address — driving one
        // needs a vertex hit-test over `pathAnchors`, not a wider filter.
        host.log.debug?.(
          "cornerRadius: select a rectangle (the drag handle hit-tests a " +
            "box's four corners; use the Corners commands on a polygon)",
        );
        return;
      }
      void (async () => {
        const [geom] = await host.document.elementGeometry([rect]);
        if (!geom?.bounds) return;
        const t = (geom as { itemTransform?: number[] }).itemTransform;
        if (t && t.some((v, i) => v !== IDENTITY[i])) {
          host.log.debug?.(
            "cornerRadius: rotated/transformed rectangle — the axis-aligned hit would lie; skipped",
          );
          return;
        }
        const hit = cornerAt(
          geom.bounds as Bounds,
          e.pagePoint as [number, number],
          host.viewport.pxToPt(CORNER_TOL_PX),
        );
        if (hit === null) return;
        target = rect;
        bounds = geom.bounds as Bounds;
        corner = hit;
        pageId = e.pageId ?? null;
        radius = radiusFromDrag(bounds, corner, e.pagePoint as [number, number]);
        if (pageId) {
          host.overlay.setToolPreview({
            pageId,
            points: cornerPreview(bounds, corner, radius) as [number, number][],
          });
        }
      })();
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!bounds || corner === null || !e.pagePoint || !pageId) return;
      radius = radiusFromDrag(bounds, corner, e.pagePoint as [number, number]);
      host.overlay.setToolPreview({
        pageId,
        points: cornerPreview(bounds, corner, radius) as [number, number][],
      });
    },
    onPointerUp() {
      if (!target || corner === null) {
        reset();
        return;
      }
      const id = target;
      const c = corner;
      const r = radius;
      reset();
      void host.document
        .mutate(cornerRadiiMutationFor(id, c, "RoundedCorner", r))
        .then((outcome) => {
          if (!outcome.applied) {
            host.log.warn(
              `cornerRadius rejected by engine: ${JSON.stringify(outcome.error)}`,
            );
          }
        })
        .catch((err) => host.log.warn(`cornerRadius commit failed: ${err}`));
    },
    onKey(e: KeyboardEvent) {
      if (e.key === "Escape") reset();
    },
  };
}
