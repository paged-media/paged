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

import type { ReactNode } from "react";

import type { ElementGeometryItem, ResizeHandle } from "@paged-media/client";

import type { OverlayContribution, OverlayProps } from "../registries/overlay";
import { useSelection } from "../state/selection-context";

import { applyAffine } from "./affine";
import { groupByPage, unionAabb } from "./selection-chrome";

/**
 * Eight cardinal/diagonal resize handles.
 *
 * - Single selection: handles render on the element's oriented bbox
 *   (corners projected through `itemTransform`).
 * - Multi-selection: handles render on the per-page union AABB.
 *
 * Each handle carries `data-handle="<name>"`; ViewportCanvas's
 * pointerdown reads the dataset to begin the correct resize gesture.
 *
 * Just OUTSIDE each corner lies a rotate band (`data-handle="rotate"`,
 * a rotate cursor), as in InDesign and Illustrator: a drag there rotates
 * the selection and keeps its size (F-30). The band lies over the outer
 * part of the corner's resize hit area, so the corner resizes on its
 * visible square and just inside it.
 */
function ResizeHandlesRender(props: OverlayProps) {
  const { placedGeometry: elementGeometry, pathEditMode } = useSelection();
  // Path-edit mode edits the element's POINTS, and every press on the
  // canvas is the path's there — a frame handle would be drawn and
  // dead. The outline stays; the handles come back with the mode off.
  if (pathEditMode) return null;
  if (elementGeometry.length === 0) return null;
  if (elementGeometry.length === 1) {
    return renderSingle(elementGeometry[0], props);
  }
  return renderUnion(elementGeometry, props);
}

function renderSingle(item: ElementGeometryItem, props: OverlayProps) {
  // C-23 — no page found for it ⇒ no space to draw in.
  const pageId = item.pageId;
  const pr = pageId ? props.pageRects.get(pageId) : undefined;
  if (!pageId || !pr) return null;
  const [top, left, bottom, right] = item.bounds;
  const cx = (left + right) * 0.5;
  const cy = (top + bottom) * 0.5;
  const positions = handlePositions(left, top, right, bottom, cx, cy);
  const inv = 1 / props.camera.scale;
  const [ccx, ccy] = applyAffine(item.itemTransform, cx, cy);
  return (
    <>
      {positions.map(({ name, local, cursor }) => {
        const [wx, wy] = applyAffine(item.itemTransform, local[0], local[1]);
        return renderHandle(
          name,
          pageId,
          pr.x + wx,
          pr.y + wy,
          inv,
          cursor,
          `${name}`,
          [wx - ccx, wy - ccy],
        );
      })}
    </>
  );
}

function renderUnion(
  geometry: ReadonlyArray<ElementGeometryItem>,
  props: OverlayProps,
) {
  const byPage = groupByPage(geometry);
  const inv = 1 / props.camera.scale;
  const out: ReactNode[] = [];
  for (const [pageId, items] of byPage) {
    const pr = props.pageRects.get(pageId);
    if (!pr) continue;
    const bb = unionAabb(items);
    if (!bb) continue;
    const cx = (bb.minX + bb.maxX) * 0.5;
    const cy = (bb.minY + bb.maxY) * 0.5;
    const positions = handlePositions(
      bb.minX,
      bb.minY,
      bb.maxX,
      bb.maxY,
      cx,
      cy,
    );
    for (const { name, local, cursor } of positions) {
      out.push(
        renderHandle(
          name,
          pageId,
          pr.x + local[0],
          pr.y + local[1],
          inv,
          cursor,
          `${pageId}:${name}`,
          [local[0] - cx, local[1] - cy],
        ),
      );
    }
  }
  return <>{out}</>;
}

function handlePositions(
  left: number,
  top: number,
  right: number,
  bottom: number,
  cx: number,
  cy: number,
): Array<{
  name: ResizeHandle;
  local: [number, number];
  cursor: string;
}> {
  return [
    { name: "northWest", local: [left, top], cursor: "nwse-resize" },
    { name: "north", local: [cx, top], cursor: "ns-resize" },
    { name: "northEast", local: [right, top], cursor: "nesw-resize" },
    { name: "east", local: [right, cy], cursor: "ew-resize" },
    { name: "southEast", local: [right, bottom], cursor: "nwse-resize" },
    { name: "south", local: [cx, bottom], cursor: "ns-resize" },
    { name: "southWest", local: [left, bottom], cursor: "nesw-resize" },
    { name: "west", local: [left, cy], cursor: "ew-resize" },
  ];
}

function renderHandle(
  name: ResizeHandle,
  pageId: string,
  x: number,
  y: number,
  inv: number,
  cursor: string,
  key: string,
  /** From the selection's centre to this handle, page space: which way
   *  is OUTSIDE (only its signs are read). */
  outward: [number, number],
) {
  const visiblePx = 8;
  const hitPx = 12;
  const corner = CORNERS.has(name);
  // Outward signs; an edge handle's along-edge axis has none.
  const sx = corner ? Math.sign(outward[0]) : 0;
  const sy = corner ? Math.sign(outward[1]) : 0;
  // `data-handle-page`: the page whose space the handle's box is in —
  // the canvas names its gesture's anchor and pivot on that page, which
  // is not always the page under the pointer.
  //
  // Paint order is hit order: the resize hit area, then a corner's
  // rotate band over its outer part, then the visible square over both.
  // So a corner resizes on its square and just inside it, and rotates
  // just outside it (F-30).
  return (
    <g
      key={key}
      transform={`translate(${x}, ${y}) scale(${inv})`}
      data-selection-handle={name}
      data-handle-page={pageId}
    >
      <rect
        x={-hitPx / 2}
        y={-hitPx / 2}
        width={hitPx}
        height={hitPx}
        fill="transparent"
        data-handle={name}
        style={{ cursor, pointerEvents: "all" }}
      />
      {corner ? (
        <rect
          x={sx * ROTATE_BAND_OFFSET_PX - ROTATE_BAND_PX / 2}
          y={sy * ROTATE_BAND_OFFSET_PX - ROTATE_BAND_PX / 2}
          width={ROTATE_BAND_PX}
          height={ROTATE_BAND_PX}
          fill="transparent"
          data-handle="rotate"
          data-rotate-band={name}
          style={{ cursor: ROTATE_CURSOR, pointerEvents: "all" }}
        />
      ) : null}
      <rect
        x={-visiblePx / 2}
        y={-visiblePx / 2}
        width={visiblePx}
        height={visiblePx}
        fill="white"
        stroke="var(--overlay-selection)"
        strokeWidth={1}
        data-handle={name}
        style={{ cursor, pointerEvents: "all" }}
      />
    </g>
  );
}

const CORNERS: ReadonlySet<ResizeHandle> = new Set([
  "northWest",
  "northEast",
  "southEast",
  "southWest",
]);

/** The rotate band outside a corner: a square of this side, screen px,
 *  centred this far outward from the corner on both axes — it spans
 *  from the handle's outer edge to 20 px beyond the corner. */
const ROTATE_BAND_PX = 24;
const ROTATE_BAND_OFFSET_PX = 8;

/** A curved double arrow (the rotate cursor), hotspot at its centre. */
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
    '<path d="M5 15a8 8 0 0 1 14-8" fill="none" stroke="white" stroke-width="4" stroke-linecap="round"/>' +
    '<path d="M5 15a8 8 0 0 1 14-8" fill="none" stroke="black" stroke-width="1.5" stroke-linecap="round"/>' +
    '<path d="M2 12l3 4 4-3M22 10l-3-4-4 3" fill="none" stroke="black" stroke-width="1.5" stroke-linejoin="round"/>' +
    "</svg>",
)}") 12 12, alias`;

export const resizeHandlesContribution: OverlayContribution = {
  id: "paged.resize-handles",
  render: ResizeHandlesRender,
  z: 300,
};
