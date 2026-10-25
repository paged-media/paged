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

// Document-space page layout helpers.
//
// Pages stack vertically with a fixed gap; spreads are TBD (Phase 2).
// All coordinates are in points (pt), the IDML unit. The camera
// transform maps these to viewport (CSS) pixels.

import type { Camera } from "@paged-media/client";
// Deep import: the worker reads this module, and the shell barrel pulls in React.
import {
  ZOOM_MAX_SCALE,
  ZOOM_MIN_SCALE,
} from "@paged-media/shell/state/zoom-range";

export interface PageRect {
  /** Top-left x in document space (pt). */
  x: number;
  /** Top-left y in document space (pt). */
  y: number;
  /** Width in document space (pt). */
  w: number;
  /** Height in document space (pt). */
  h: number;
}

/**
 * Stack `pageSizesPt` vertically with `gapPt` between adjacent pages.
 * Returns one rect per page, in the same order as the input.
 * Result is centred-x within the document (each page starts at x=0,
 * letting the viewport's pan + a centred default camera handle
 * horizontal alignment).
 */
export function layoutPages(
  pageSizesPt: ReadonlyArray<readonly [number, number]>,
  gapPt = 24,
): PageRect[] {
  const out: PageRect[] = [];
  let y = 0;
  for (const [w, h] of pageSizesPt) {
    out.push({ x: 0, y, w, h });
    y += h + gapPt;
  }
  return out;
}

/**
 * Total bounding box of all pages in document space. Used by
 * fit-to-document and to constrain pan bounds.
 */
export function documentBounds(rects: ReadonlyArray<PageRect>): PageRect {
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * What a document opens on: its first page (UX audit F-32 — the view Home
 * gives, with the page indicator on 1), not the whole document, which on
 * a long document is a strip of slivers at a few percent.
 */
export function openingView(rects: ReadonlyArray<PageRect>): PageRect {
  return rects[0] ?? { x: 0, y: 0, w: 0, h: 0 };
}

/**
 * Camera that fits `rect` (document space) into a viewport of the
 * given pixel size, with a margin. Centres the rect in the viewport.
 * Used for fit-to-document on load and fit-to-page on navigator click.
 */
export function fitCamera(
  viewportWidthPx: number,
  viewportHeightPx: number,
  rect: PageRect,
  marginPx = 40,
  rotation = 0,
): Camera {
  if (rect.w <= 0 || rect.h <= 0) {
    return { scale: 1, tx: 0, ty: 0, rotation };
  }
  // v77 (editor ADR 287) — in a turned view the rect's turned box fits.
  const c = Math.abs(Math.cos(rotation));
  const s = Math.abs(Math.sin(rotation));
  const w = rect.w * c + rect.h * s;
  const h = rect.w * s + rect.h * c;
  const scaleX = (viewportWidthPx - 2 * marginPx) / w;
  const scaleY = (viewportHeightPx - 2 * marginPx) / h;
  const scale = Math.max(0.01, Math.min(scaleX, scaleY));
  // The rect's centre lands on the viewport's.
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const tx = viewportWidthPx / 2 - scale * (cos * cx - sin * cy);
  const ty = viewportHeightPx / 2 - scale * (sin * cx + cos * cy);
  return { scale, tx, ty, rotation };
}

/** Apply a zoom-to-cursor zoom delta. `factor > 1` zooms in. */
export function zoomAt(
  cam: Camera,
  cursorViewportX: number,
  cursorViewportY: number,
  factor: number,
  minScale = ZOOM_MIN_SCALE,
  maxScale = ZOOM_MAX_SCALE,
): Camera {
  const newScale = Math.max(minScale, Math.min(maxScale, cam.scale * factor));
  if (newScale === cam.scale) return cam;
  // Keep the document point under the cursor stationary.
  const docX = (cursorViewportX - cam.tx) / cam.scale;
  const docY = (cursorViewportY - cam.ty) / cam.scale;
  return {
    scale: newScale,
    tx: cursorViewportX - docX * newScale,
    ty: cursorViewportY - docY * newScale,
  };
}
