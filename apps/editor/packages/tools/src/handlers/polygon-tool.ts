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

// Editor-ops — the Polygon tool's gesture handler (W2.6).
//
// Drag → a live N-gon (or star, when star inset > 0) inscribed in the
// drag bounds, previewed as a closed polyline → ONE batch on pointer-up:
// `insertPath { pageId, anchors, open: false, smooth: false }` of the
// plain N-gon, then its `frameShapeSides` and `frameShapeStarInset`
// (engine ADR 1047, editor ADR 310), so the polygon stays a LIVE shape —
// the Transform panel's Shape section and the on-canvas widgets change
// its sides and inset later — and the engine draws the star itself, its
// outer points where the preview put them. The corner vertices are
// PathAnchorSpec with collapsed handles (left = right = anchor).
// Lifecycle mirrors the Rectangle handler (page-anchored drag, single
// mutation on release, mutateAndSelect, Escape cancels, spring-load
// suspend keeps the gesture).
//
// Tool options (T8): `sides` and `starInset` are tool-scoped settings,
// read from `paged.toolSettings` keyed by this tool's id — app state,
// NOT a document mutation (the double-click ToolOptionsPopover writes
// them). Star semantics: inner radius = outer × (1 − starInset/100),
// vertices alternate outer/inner (2·sides anchors); a 0 inset is a
// plain N-gon (sides anchors). The inset stops at 99 %, the engine's
// limit (at 100 a star has no area).
//
// Modifiers (gestures.md DR-02): Shift constrains the bounds to a
// square via the shared `drawBoundsFor` (Alt-from-centre rides along
// for free — same helper as the Ellipse tool).

import type {
  CanvasPointerEvent,
  GestureHandler,
  PagedEditor,
} from "@paged-media/shell";

import type { Mutation, PathAnchorSpec } from "@paged-media/client";

import {
  clampShape,
  MAX_STAR_INSET,
  polygonInCircle,
} from "../live-shapes/geometry";

import {
  beginPageDrag,
  drawBoundsFor,
  endLocalFor,
  mutateAndSelect,
  mutateGraphicAndSelect,
  CLICK_DRAG_THRESHOLD_PX,
  type Bounds,
  type DrawHandlerOptions,
  type PageDrag,
} from "./shared";

const TOOL_ID = "paged.tool.polygon";
/** InDesign's default polygon is a hexagon; star inset defaults off. */
const DEFAULT_SIDES = 6;
const DEFAULT_STAR_INSET = 0;
const MIN_SIDES = 3;
const MAX_SIDES = 100;
const MIN_SIZE_PT = 1;

/** Clamp a tool-setting number, falling back to `fallback` when the
 *  store has no (or a non-numeric) value yet. */
function settingNumber(
  paged: PagedEditor,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = paged.toolSettings.getValue(TOOL_ID, key);
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * The polygon's corner vertices in page-local pt, inscribed in `bounds`:
 * the outer points on the ellipse of the drag box, the first at twelve
 * o'clock (`../live-shapes/geometry`, the engine's own definition).
 */
function polygonVertices(
  bounds: Bounds,
  sides: number,
  starInset: number,
): [number, number][] {
  return polygonInCircle(bounds, clampShape(sides, starInset)).map(([x, y]) => [
    x,
    y,
  ]);
}

/** Corner anchor — handles collapsed onto the point, so the engine
 *  stores straight segments between vertices. */
function cornerAnchor([x, y]: [number, number]): PathAnchorSpec {
  return { anchor: [x, y], left: [x, y], right: [x, y] };
}

/**
 * Engine ADR 1047 — the polygon a drag makes, LIVE: the plain polygon
 * inscribed in the drag box, then its side count and star inset written
 * to it (`$created`), so the engine keeps the parameters and draws the
 * star itself, its outer points where the preview put them. One batch,
 * one undo step.
 */
export function livePolygonInsert(
  pageId: string,
  bounds: Bounds,
  sides: number,
  starInset: number,
): Mutation {
  const shape = clampShape(sides, starInset);
  const anchors = polygonVertices(bounds, shape.sides, 0).map(cornerAnchor);
  const elementId = { kind: "polygon", id: "$created" } as const;
  const ops: Mutation[] = [
    {
      op: "insertPath",
      args: { pageId, anchors, open: false, smooth: false },
    },
    {
      op: "setElementProperty",
      args: {
        elementId,
        path: "frameShapeSides",
        value: { type: "length", value: shape.sides },
      },
    },
  ];
  if (shape.starInset > 0) {
    ops.push({
      op: "setElementProperty",
      args: {
        elementId,
        path: "frameShapeStarInset",
        value: { type: "length", value: shape.starInset },
      },
    });
  }
  return { op: "batch", args: { ops } } as Mutation;
}

export function createPolygonHandler(
  options: DrawHandlerOptions = {},
): GestureHandler {
  const commit = options.frame ? mutateAndSelect : mutateGraphicAndSelect;
  let paged: PagedEditor | null = null;
  let drag: PageDrag | null = null;

  const cancel = () => {
    paged?.overlaySignals.setToolPreview(null);
    drag = null;
  };

  const boundsFor = (e: CanvasPointerEvent): Bounds =>
    drawBoundsFor(drag!.startLocal, endLocalFor(drag!, e), e.modifiers);

  const optionsFor = (): { sides: number; starInset: number } => ({
    sides: Math.round(
      settingNumber(paged!, "sides", DEFAULT_SIDES, MIN_SIDES, MAX_SIDES),
    ),
    starInset: settingNumber(
      paged!,
      "starInset",
      DEFAULT_STAR_INSET,
      0,
      MAX_STAR_INSET,
    ),
  });

  return {
    onActivate(p) {
      paged = p;
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      cancel();
    },
    onPointerDown(e: CanvasPointerEvent) {
      drag = beginPageDrag(e);
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!paged || !drag) return;
      if (e.maxDelta <= CLICK_DRAG_THRESHOLD_PX) return;
      const { sides, starInset } = optionsFor();
      paged.overlaySignals.setToolPreview({
        pageId: drag.pageId,
        points: polygonVertices(boundsFor(e), sides, starInset),
        close: true,
      });
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!paged || !drag) {
        cancel();
        return;
      }
      const bounds = boundsFor(e);
      const { pageId } = drag;
      const { sides, starInset } = optionsFor();
      cancel();
      // Click versus drag is decided in SCREEN px (INV-6): at 25 % a
      // 3 px jitter spans 12 pt and must still be a click (GT-1).
      if (e.maxDelta <= CLICK_DRAG_THRESHOLD_PX) return;
      const [top, left, bottom, right] = bounds;
      // A click (no real drag) creates nothing — InDesign opens an
      // options dialog there; that's a follow-up (matches Rectangle).
      if (bottom - top < MIN_SIZE_PT || right - left < MIN_SIZE_PT) return;
      void commit(
        paged,
        livePolygonInsert(pageId, bounds, sides, starInset),
        "insertPath",
      );
    },
    onKey(e: KeyboardEvent) {
      if (e.key === "Escape") cancel();
    },
  };
}
