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

// Editor ADR 287 — View ▸ Show Grid and View ▸ Pixel Grid.
//
// The document grid: a gridline every `gridEvery` pt with `gridSubdivisions`
// fainter lines between, in the preference's colour, per page — the same
// lines the engine snaps to with Snap to Grid (`view-settings-sync.tsx`
// sends the spacing). Subdivisions drop out when they would sit closer
// than 4 screen px; the gridlines when they would.
//
// "Grids in back": the canvas is one raster under this overlay, so the
// grid cannot be occluded by the artwork. It is drawn multiplied into the
// raster at reduced strength instead: plain on the paper, sunk into dark
// fills. In front it draws plainly over everything.
//
// The pixel grid: Illustrator's, one line per point (a pixel at 72 ppi)
// in Pixel Preview at 600 % and above.
//
// Every line of one kind on one page is one `<path>`, and only pages in
// view draw, so a long document costs a few elements.

import { useSyncExternalStore } from "react";

import { viewportToDoc } from "@paged-media/client";

import { useContextWorkspace } from "../catalog/binding-providers";
import { workspaceDocRect } from "../state/context-workspace";
import type {
  OverlayContribution,
  OverlayPageRect,
  OverlayProps,
} from "../registries/overlay";
import { useCamera } from "../state/camera-context";
import { useEditorScope } from "../state/editor-scope";
import { gridStep, useViewPreferences } from "../state/view-preferences";
import { getViewToggle, subscribeViewToggles } from "../state/view-toggles";

/** The zoom (camera scale) at which the pixel grid appears. */
export const PIXEL_GRID_MIN_SCALE = 6;
/** Lines closer than this on screen are left out. */
const MIN_SPACING_PX = 4;

interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The document-space box the viewport shows. */
function visibleBounds(
  camera: OverlayProps["camera"],
  viewport: readonly [number, number],
): Bounds | null {
  const [w, h] = viewport;
  if (!(w > 0 && h > 0)) return null;
  const corners = [
    viewportToDoc(camera, 0, 0),
    viewportToDoc(camera, w, 0),
    viewportToDoc(camera, w, h),
    viewportToDoc(camera, 0, h),
  ];
  return {
    x0: Math.min(...corners.map((c) => c[0])),
    y0: Math.min(...corners.map((c) => c[1])),
    x1: Math.max(...corners.map((c) => c[0])),
    y1: Math.max(...corners.map((c) => c[1])),
  };
}

/** One page's lines every `step` pt from its origin, clipped to `view`,
 *  as path data; `skip(k)` leaves line k out (the gridlines a subdivision
 *  path would double). */
export function gridPath(
  rect: OverlayPageRect,
  step: number,
  view: Bounds | null,
  skip: (k: number) => boolean = () => false,
): string {
  if (!(step > 0)) return "";
  const x0 = Math.max(rect.x, view?.x0 ?? rect.x);
  const x1 = Math.min(rect.x + rect.w, view?.x1 ?? rect.x + rect.w);
  const y0 = Math.max(rect.y, view?.y0 ?? rect.y);
  const y1 = Math.min(rect.y + rect.h, view?.y1 ?? rect.y + rect.h);
  if (x0 > x1 || y0 > y1) return "";
  const parts: string[] = [];
  const kx0 = Math.ceil((x0 - rect.x) / step - 1e-6);
  const kx1 = Math.floor((x1 - rect.x) / step + 1e-6);
  for (let k = kx0; k <= kx1; k++) {
    if (skip(k)) continue;
    const x = rect.x + k * step;
    parts.push(`M${x} ${y0}V${y1}`);
  }
  const ky0 = Math.ceil((y0 - rect.y) / step - 1e-6);
  const ky1 = Math.floor((y1 - rect.y) / step + 1e-6);
  for (let k = ky0; k <= ky1; k++) {
    if (skip(k)) continue;
    const y = rect.y + k * step;
    parts.push(`M${x0} ${y}H${x1}`);
  }
  return parts.join("");
}

function useToggle(which: "showGrid" | "pixelGrid" | "pixelPreview"): boolean {
  const scope = useEditorScope();
  return useSyncExternalStore(
    (l) => subscribeViewToggles(scope, l),
    () => getViewToggle(scope, which),
    () => false,
  );
}

function GridRender(props: OverlayProps) {
  const showGrid = useToggle("showGrid");
  const pixelGrid = useToggle("pixelGrid");
  const pixelPreview = useToggle("pixelPreview");
  const prefs = useViewPreferences();
  const { viewportSize } = useCamera();
  // Extensions ADR 3XX — inside an edit context with a workspace (a raster
  // image) the grid covers the workspace from ITS origin, the physical
  // "gridline every" mapped through its resolution, instead of the page.
  const ctx = useContextWorkspace();
  const scale = props.camera.scale;
  const showPixels = pixelGrid && pixelPreview && scale >= PIXEL_GRID_MIN_SCALE;
  if (!showGrid && !showPixels) return null;
  const view = visibleBounds(props.camera, viewportSize);
  const inView = (r: OverlayPageRect) =>
    !view ||
    (r.x <= view.x1 &&
      r.x + r.w >= view.x0 &&
      r.y <= view.y1 &&
      r.y + r.h >= view.y0);
  const wsPage = ctx ? props.pageRects.get(ctx.workspace.pageId) : undefined;
  const wsRect = ctx && wsPage ? workspaceDocRect(ctx.workspace, wsPage) : null;
  const wsScale = ctx
    ? ctx.workspace.basePerPoint * ctx.workspace.ptPerBase
    : 1;
  const pages = [...props.pageRects.entries()].filter(
    ([id, r]) => inView(r) && !(wsRect && id === ctx?.workspace.pageId),
  );
  const every = prefs.gridEvery;
  const step = gridStep(prefs);
  const subdivisions = Math.max(1, Math.round(prefs.gridSubdivisions));
  const drawMinor = subdivisions > 1 && step * scale >= MIN_SPACING_PX;
  const drawMajor = every * scale >= MIN_SPACING_PX;
  const back = prefs.gridsInBack;
  const wsEvery = every * wsScale;
  const wsStep = step * wsScale;
  return (
    <g pointerEvents="none" data-grid-overlay="">
      {showGrid && wsRect && (
        <g
          data-workspace-grid=""
          data-grid-step={wsStep}
          style={back ? { mixBlendMode: "multiply" } : undefined}
        >
          {subdivisions > 1 && wsStep * scale >= MIN_SPACING_PX && (
            <path
              d={gridPath(wsRect, wsStep, view, (k) => k % subdivisions === 0)}
              stroke={prefs.gridColor}
              strokeOpacity={back ? 0.35 : 0.45}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              fill="none"
            />
          )}
          {wsEvery * scale >= MIN_SPACING_PX && (
            <path
              d={gridPath(wsRect, wsEvery, view)}
              stroke={prefs.gridColor}
              strokeOpacity={back ? 0.7 : 0.9}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              fill="none"
            />
          )}
        </g>
      )}
      {showGrid &&
        pages.map(([pageId, rect]) => (
          <g
            key={pageId}
            data-document-grid={pageId}
            data-grid-step={step}
            data-grid-in-back={back ? "" : undefined}
            style={back ? { mixBlendMode: "multiply" } : undefined}
          >
            {drawMinor && (
              <path
                d={gridPath(rect, step, view, (k) => k % subdivisions === 0)}
                stroke={prefs.gridColor}
                strokeOpacity={back ? 0.35 : 0.45}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                fill="none"
              />
            )}
            {drawMajor && (
              <path
                d={gridPath(rect, every, view)}
                stroke={prefs.gridColor}
                strokeOpacity={back ? 0.7 : 0.9}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                fill="none"
              />
            )}
          </g>
        ))}
      {showPixels &&
        pages.map(([pageId, rect]) => (
          <path
            key={`px-${pageId}`}
            data-pixel-grid={pageId}
            d={gridPath(rect, 1, view)}
            stroke="#a0a0a0"
            strokeOpacity={0.5}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            fill="none"
          />
        ))}
    </g>
  );
}

export const gridOverlayContribution: OverlayContribution = {
  id: "paged.grid",
  render: GridRender,
  // Above the page decorations (50) and below the ruler guides (75), the
  // selection chrome and the snap lines: the grid is the quietest layer.
  z: 60,
};
