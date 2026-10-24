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

// WP4.5 — the Navigator (Illustrator's and Photoshop's zoom proxy; not
// `paged.pages`, which is the page list). A thumbnail of the page the view
// is on, a red rectangle where the view is, a drag on the thumbnail to
// pan, and the zoom: a slider, a percent field and zoom out / in.
//
// Everything it shows it reads through the shell's state: the camera and
// the viewport size (`useCamera`), the page thumbnails the document keeps
// current (`useDocument().snapshots`, re-taken after an edit), so it
// follows the canvas without asking the engine for anything itself.

import { useState } from "react";

import {
  clampScale,
  useCamera,
  useDocument,
  zoomCameraTo,
  ZOOM_MAX_SCALE,
  ZOOM_MIN_SCALE,
  type PanelProps,
} from "@paged-media/shell";
import type { Camera } from "@paged-media/client";
import { defineMessages, useStrings } from "@paged-media/strings";

import { layoutPages, type PageRect } from "../ui/layout";

export const NAVIGATOR_PANEL_ID = "paged.navigator";

const M = defineMessages("app.zoomNavigator", {
  noDocument: "No document loaded.",
  page: "Page {page}",
  zoom: "Zoom",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  view: "View",
});

/** The thumbnail's width in CSS px. */
export const NAVIGATOR_THUMB_PX = 200;
/** The zoom buttons' step: the View menu's (×1.5). */
const STEP = 1.5;

/** The page the view is on: the one under the viewport's centre, else
 *  the nearest to it. -1 without pages. */
export function pageInView(
  rects: ReadonlyArray<PageRect>,
  camera: Camera,
  viewport: readonly [number, number],
): number {
  if (rects.length === 0) return -1;
  const cx = (viewport[0] / 2 - camera.tx) / camera.scale;
  const cy = (viewport[1] / 2 - camera.ty) / camera.scale;
  let best = 0;
  let bestD = Infinity;
  rects.forEach((r, i) => {
    const dx = Math.max(r.x - cx, 0, cx - (r.x + r.w));
    const dy = Math.max(r.y - cy, 0, cy - (r.y + r.h));
    const d = Math.hypot(dx, dy);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** The view rectangle in the page's own space, pt (it may reach past the
 *  page; the thumbnail clips it). */
export function viewRectOnPage(
  page: PageRect,
  camera: Camera,
  viewport: readonly [number, number],
): { x: number; y: number; w: number; h: number } {
  return {
    x: -camera.tx / camera.scale - page.x,
    y: -camera.ty / camera.scale - page.y,
    w: viewport[0] / camera.scale,
    h: viewport[1] / camera.scale,
  };
}

/** The camera that centres the view on a page point, at the same zoom. */
export function centreOn(
  page: PageRect,
  point: readonly [number, number],
  camera: Camera,
  viewport: readonly [number, number],
): Camera {
  const docX = page.x + point[0];
  const docY = page.y + point[1];
  return {
    scale: camera.scale,
    tx: viewport[0] / 2 - docX * camera.scale,
    ty: viewport[1] / 2 - docY * camera.scale,
  };
}

// The slider runs on a log scale: 5 % … 4,000 % is three decades, and a
// linear slider would spend nearly all its travel above 1,000 %.
const LOG_MIN = Math.log(ZOOM_MIN_SCALE);
const LOG_MAX = Math.log(ZOOM_MAX_SCALE);
const SLIDER_STEPS = 1000;
const toSlider = (scale: number) =>
  Math.round(
    ((Math.log(clampScale(scale)) - LOG_MIN) / (LOG_MAX - LOG_MIN)) *
      SLIDER_STEPS,
  );
const fromSlider = (v: number) =>
  Math.exp(LOG_MIN + (v / SLIDER_STEPS) * (LOG_MAX - LOG_MIN));

export function ZoomNavigatorPanel(_props: PanelProps) {
  const strings = useStrings();
  const { handle, snapshots } = useDocument();
  const { camera, setCamera, viewportSize } = useCamera();
  // The percent being typed, until Enter or blur commits it.
  const [draft, setDraft] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  if (!handle || handle.pageCount === 0) {
    return (
      <div className="p-3 text-xs text-muted-foreground" data-navigator="empty">
        {strings.t(M.noDocument)}
      </div>
    );
  }

  const rects = layoutPages(handle.pageSizesPt);
  const index = pageInView(rects, camera, viewportSize);
  const page = rects[index]!;
  const pageId = handle.pageIds[index]!;
  const k = NAVIGATOR_THUMB_PX / page.w;
  const thumbH = page.h * k;
  const view = viewRectOnPage(page, camera, viewportSize);
  const url = snapshots.get(pageId);
  const percent = Math.round(camera.scale * 100);

  const zoomTo = (scale: number) =>
    setCamera(zoomCameraTo(camera, scale, viewportSize));

  // A press on the thumbnail centres the view there; a drag keeps
  // centring it under the pointer (pointer capture holds it past the
  // thumbnail's edge).
  const panAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const point: [number, number] = [
      (e.clientX - box.left) / k,
      (e.clientY - box.top) / k,
    ];
    setCamera(centreOn(page, point, camera, viewportSize));
  };

  const commitDraft = () => {
    if (draft === null) return;
    const n = Number(draft.replace(",", ".").replace("%", "").trim());
    setDraft(null);
    if (Number.isFinite(n) && n > 0) zoomTo(n / 100);
  };

  return (
    <div
      className="flex flex-col gap-2 p-2 text-xs"
      data-navigator="ready"
      data-navigator-page={pageId}
    >
      <div
        className="relative mx-auto overflow-hidden border border-input bg-muted"
        style={{
          width: NAVIGATOR_THUMB_PX,
          height: thumbH,
          cursor: dragging ? "grabbing" : "grab",
          touchAction: "none",
        }}
        data-navigator-thumb=""
        aria-label={strings.t(M.page, { page: index + 1 })}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          setDragging(true);
          panAt(e);
        }}
        onPointerMove={(e) => {
          if (dragging) panAt(e);
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture?.(e.pointerId);
          setDragging(false);
        }}
        onPointerCancel={() => setDragging(false)}
      >
        {url && (
          <img
            src={url}
            alt={strings.t(M.page, { page: index + 1 })}
            draggable={false}
            style={{ width: "100%", height: "100%", display: "block" }}
          />
        )}
        <div
          data-navigator-view=""
          aria-label={strings.t(M.view)}
          style={{
            position: "absolute",
            left: view.x * k,
            top: view.y * k,
            width: view.w * k,
            height: view.h * k,
            border: "1.5px solid var(--overlay-target)",
            pointerEvents: "none",
            boxSizing: "border-box",
          }}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="h-6 w-6 rounded hover:bg-muted/60"
          aria-label={strings.t(M.zoomOut)}
          title={strings.t(M.zoomOut)}
          data-navigator-zoom="out"
          onClick={() => zoomTo(camera.scale / STEP)}
        >
          −
        </button>
        <input
          type="range"
          className="min-w-0 flex-1"
          min={0}
          max={SLIDER_STEPS}
          value={toSlider(camera.scale)}
          aria-label={strings.t(M.zoom)}
          data-navigator-slider=""
          onChange={(e) => zoomTo(fromSlider(Number(e.target.value)))}
        />
        <button
          type="button"
          className="h-6 w-6 rounded hover:bg-muted/60"
          aria-label={strings.t(M.zoomIn)}
          title={strings.t(M.zoomIn)}
          data-navigator-zoom="in"
          onClick={() => zoomTo(camera.scale * STEP)}
        >
          +
        </button>
        <input
          type="text"
          inputMode="decimal"
          className="pg-value h-6 w-14 rounded border border-input bg-background px-1 text-right"
          aria-label={strings.t(M.zoom)}
          data-navigator-percent=""
          value={draft ?? `${percent}%`}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitDraft();
            if (e.key === "Escape") setDraft(null);
          }}
        />
      </div>
    </div>
  );
}
