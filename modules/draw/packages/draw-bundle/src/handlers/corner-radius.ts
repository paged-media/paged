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
// exported per-corner builders. Press near a corner of the selected
// frame, drag inward: the radius follows, the overlay previews the
// extent, pointer-up commits ONE batch (one undo step).
//
// THE KINDS ARE THE ENGINE'S (`supportsLiveCorners`: rectangle, polygon,
// text frame), and the handle geometry is now each one's own:
//   · a RECTANGLE or TEXT FRAME is a BOX — four corners, a radius per
//     corner (`cornerRadiiMutationFor`, two writes);
//   · a POLYGON has a handle at EVERY corner anchor the renderer rounds
//     (straight edges both sides, closed contour — draw-tools
//     `polygonCorners`), and the drag reads the renderer's own
//     inscribed-circle rule. A polygon has ONE radius: the renderer reads
//     only the top-left slot for an N-gon (core `uniform_corner`), so any
//     corner's handle sets the uniform radius, written to all four slots
//     the way the Corners presets write it (`cornerStyleMutationFor`).
//
// ROTATED AND SCALED FRAMES WORK, because the whole gesture happens in
// the element's OWN space: the pointer is mapped through the INVERSE item
// transform (draw-geometry `inverseApplyAffine`) before the hit-test and
// the drag, the hit tolerance is scaled into that space so it stays a
// constant 8 px on screen, and the preview is mapped back through the
// transform. The radius written is an own-space length, which is what
// the frame's corner properties are. This used to skip any transformed
// rectangle, because its corners do not sit on its page bounds.

import type {
  BundleHost,
  CanvasPointerEvent,
  ElementId,
  GestureHandler,
  Mutation,
} from "@paged-media/plugin-api";
import {
  affineScale,
  applyAffine,
  inverseApplyAffine,
  type Affine,
  type Vec2,
} from "@paged-media/draw-geometry";
import {
  cornerAt,
  cornerPreview,
  polygonCornerAt,
  polygonCornerPreview,
  polygonCorners,
  polygonRadiusFromDrag,
  radiusFromDrag,
  type Bounds,
  type CornerIndex,
  type PolygonCorner,
} from "@paged-media/draw-tools";

import {
  cornerRadiiMutationFor,
  cornerStyleMutationFor,
  supportsLiveCorners,
} from "../commands/live-corners";

/** Screen-space corner hit tolerance. */
const CORNER_TOL_PX = 8;

/** One drag in flight, in the element's own space. */
type CornerDrag =
  | { kind: "box"; target: ElementId; m: Affine | null; bounds: Bounds; corner: CornerIndex }
  | { kind: "polygon"; target: ElementId; m: Affine | null; corner: PolygonCorner };

/** What a finished drag writes: a box corner's two writes, or a
 *  polygon's uniform radius in all four slots. One batch either way.
 *  Exported for the spec. */
export function cornerDragMutationFor(
  drag: Pick<CornerDrag, "kind" | "target"> & { corner?: CornerIndex | PolygonCorner },
  radius: number,
): Mutation {
  if (drag.kind === "box") {
    return cornerRadiiMutationFor(drag.target, drag.corner as CornerIndex, "RoundedCorner", radius);
  }
  return cornerStyleMutationFor(drag.target, {
    id: "",
    title: "",
    style: "RoundedCorner",
    radius,
  });
}

export function createCornerRadiusHandler(host: BundleHost): GestureHandler {
  let drag: CornerDrag | null = null;
  let pageId: string | null = null;
  let radius = 0;

  const reset = () => {
    drag = null;
    pageId = null;
    radius = 0;
    host.overlay.setToolPreview(null);
  };

  const toInner = (m: Affine | null, p: Vec2): Vec2 | null => inverseApplyAffine(m, p[0], p[1]);

  /** Follow the pointer: the radius, then the preview mapped to the page. */
  const follow = (d: CornerDrag, page: string, pointer: Vec2) => {
    const inner = toInner(d.m, pointer);
    if (!inner) return;
    radius =
      d.kind === "box"
        ? radiusFromDrag(d.bounds, d.corner, inner)
        : polygonRadiusFromDrag(d.corner, inner);
    const preview =
      d.kind === "box" ? cornerPreview(d.bounds, d.corner, radius) : polygonCornerPreview(d.corner, radius);
    host.overlay.setToolPreview({
      pageId: page,
      points: preview.map((p) => {
        const q = applyAffine(d.m, p[0], p[1]);
        return [q[0], q[1]] as [number, number];
      }),
    });
  };

  /** Resolve a press on `target` into a drag, or null (no corner hit). */
  const grab = async (target: ElementId, page: string, pointer: Vec2): Promise<CornerDrag | null> => {
    const tolPx = host.viewport.pxToPt(CORNER_TOL_PX);
    if (target.kind === "polygon") {
      const read = await host.document.pathAnchors(target).catch(() => null);
      if (!read || read.pageId !== page) return null;
      const m = (read.itemTransform ?? null) as Affine | null;
      const inner = toInner(m, pointer);
      if (!inner) return null;
      const corner = polygonCornerAt(
        polygonCorners({
          anchors: read.anchors,
          subpathStarts: read.subpathStarts,
          subpathOpen: read.subpathOpen,
        }),
        inner,
        tolPx / affineScale(m),
      );
      return corner ? { kind: "polygon", target, m, corner } : null;
    }
    const [geom] = await host.document.elementGeometry([target]).catch(() => []);
    if (!geom?.bounds || geom.pageId !== page) return null;
    const m = (geom.itemTransform ?? null) as Affine | null;
    const inner = toInner(m, pointer);
    if (!inner) return null;
    const bounds = geom.bounds as Bounds;
    const corner = cornerAt(bounds, inner, tolPx / affineScale(m));
    return corner === null ? null : { kind: "box", target, m, bounds, corner };
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
      const target = host.selection.get().find(supportsLiveCorners);
      if (!target) {
        host.log.debug?.(
          "cornerRadius: select a rectangle, polygon or text frame (the kinds whose corners the engine renders)",
        );
        return;
      }
      const page = e.pageId;
      const pointer = e.pagePoint as Vec2;
      void (async () => {
        const d = await grab(target, page, pointer);
        if (!d) return;
        drag = d;
        pageId = page;
        follow(d, page, pointer);
      })();
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!drag || !e.pagePoint || !pageId || e.pageId !== pageId) return;
      follow(drag, pageId, e.pagePoint as Vec2);
    },
    onPointerUp() {
      if (!drag) {
        reset();
        return;
      }
      const d = drag;
      const r = radius;
      reset();
      void host.document
        .mutate(cornerDragMutationFor(d, r))
        .then((outcome) => {
          if (!outcome.applied) {
            host.log.warn(`cornerRadius rejected by engine: ${JSON.stringify(outcome.error)}`);
          }
        })
        .catch((err) => host.log.warn(`cornerRadius commit failed: ${err}`));
    },
    onKey(e: KeyboardEvent) {
      if (e.key === "Escape") reset();
    },
  };
}
