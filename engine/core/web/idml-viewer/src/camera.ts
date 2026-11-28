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

/**
 * Pure camera math over the page layout. Doc space is pt (each page at
 * its canvas place per `page_layout()`: by default a vertical stack, with
 * the pages of a spread side by side); the camera maps a
 * doc point `p` to viewport CSS px as `scroll + p * zoom`. Everything
 * here is side-effect-free so the invariants (zoom-to-anchor, fit,
 * clamps, current-page) are unit-testable without a canvas.
 */

import type { SessionPageRect, SessionPagesLayout } from "./session.js";

export interface Camera {
  /** CSS px per pt. */
  zoom: number;
  /** Doc origin in viewport CSS px. */
  x: number;
  y: number;
}

export interface Viewport {
  /** CSS px. */
  width: number;
  height: number;
}

export interface ZoomLimits {
  min: number;
  max: number;
}

/** Default page-fit margin — matches the wasm fit-page present. */
export const FIT_MARGIN = 0.95;

export function clampZoom(zoom: number, limits: ZoomLimits): number {
  return Math.min(limits.max, Math.max(limits.min, zoom));
}

/** A page's left edge in doc space (pt); 0 when the session omits it. */
function pageX(page: SessionPageRect): number {
  return page.xPt ?? 0;
}

/**
 * The doc-space rectangle (pt) that holds every page. Pages sit at their
 * canvas place, so a spread's pages lie side by side and the origin may be
 * left of or above zero.
 */
export function contentBounds(layout: SessionPagesLayout): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of layout.pages) {
    const x = pageX(p);
    minX = Math.min(minX, x);
    minY = Math.min(minY, p.yPt);
    maxX = Math.max(maxX, x + p.widthPt);
    maxY = Math.max(maxY, p.yPt + p.heightPt);
  }
  if (layout.pages.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Total doc-space extents of the page layout (pt): `contentBounds`' size. */
export function contentExtent(layout: SessionPagesLayout): {
  width: number;
  height: number;
} {
  const { width, height } = contentBounds(layout);
  return { width, height };
}

/**
 * Zoom about an anchor point (viewport CSS px): the doc point under
 * the anchor stays under it. With no anchor, zoom about the viewport
 * centre.
 */
export function zoomAt(
  camera: Camera,
  nextZoom: number,
  limits: ZoomLimits,
  viewport: Viewport,
  anchor?: { x: number; y: number },
): Camera {
  const z = clampZoom(nextZoom, limits);
  const ax = anchor?.x ?? viewport.width / 2;
  const ay = anchor?.y ?? viewport.height / 2;
  const docX = (ax - camera.x) / camera.zoom;
  const docY = (ay - camera.y) / camera.zoom;
  return { zoom: z, x: ax - docX * z, y: ay - docY * z };
}

/**
 * Keep content on screen: per axis, content smaller than the viewport
 * centres; larger content clamps so no blank gap opens at either edge.
 */
export function clampScroll(
  camera: Camera,
  layout: SessionPagesLayout,
  viewport: Viewport,
): Camera {
  const bounds = contentBounds(layout);
  // `pos` places the doc origin; the content starts `start` px after it.
  const clampAxis = (
    pos: number,
    start: number,
    content: number,
    view: number,
  ): number =>
    content <= view
      ? (view - content) / 2 - start
      : Math.min(0 - start, Math.max(view - content - start, pos));
  return {
    zoom: camera.zoom,
    x: clampAxis(
      camera.x,
      bounds.x * camera.zoom,
      bounds.width * camera.zoom,
      viewport.width,
    ),
    y: clampAxis(
      camera.y,
      bounds.y * camera.zoom,
      bounds.height * camera.zoom,
      viewport.height,
    ),
  };
}

/**
 * Fit a page: `"page"` fits both dimensions, `"width"` fits the page
 * width (top-aligned to the page). Returns the camera centred on the
 * page in continuous coordinates; single-page mode passes a layout
 * containing just that page at `yPt: 0`.
 */
export function fitPage(
  layout: SessionPagesLayout,
  pageIndex: number,
  mode: "page" | "width",
  viewport: Viewport,
  limits: ZoomLimits,
): Camera {
  const page = layout.pages[pageIndex] ?? layout.pages[0];
  if (!page) return { zoom: 1, x: 0, y: 0 };
  const pw = Math.max(page.widthPt, 1);
  const ph = Math.max(page.heightPt, 1);
  const zoom = clampZoom(
    mode === "page"
      ? Math.min(viewport.width / pw, viewport.height / ph) * FIT_MARGIN
      : (viewport.width / pw) * FIT_MARGIN,
    limits,
  );
  const x = (viewport.width - pw * zoom) / 2 - pageX(page) * zoom;
  const y =
    mode === "page"
      ? (viewport.height - ph * zoom) / 2 - page.yPt * zoom
      : (viewport.height - ph * zoom) / 2 -
        page.yPt * zoom +
        Math.max(0, (ph * zoom - viewport.height) / 2);
  return { zoom, x, y };
}

/**
 * The page under the viewport centre. Pages are compared by their distance
 * from the centre, vertical first (the page stack), then horizontal (the
 * pages of one spread): the page that contains the centre wins, otherwise
 * the nearest one.
 */
export function currentPageAt(
  camera: Camera,
  layout: SessionPagesLayout,
  viewport: Viewport,
): number {
  if (layout.pages.length === 0) return 0;
  const centreX = (viewport.width / 2 - camera.x) / camera.zoom;
  const centreY = (viewport.height / 2 - camera.y) / camera.zoom;
  const outside = (at: number, start: number, size: number): number =>
    at < start ? start - at : at > start + size ? at - start - size : 0;
  let best = 0;
  let bestY = Number.POSITIVE_INFINITY;
  let bestX = Number.POSITIVE_INFINITY;
  for (const p of layout.pages) {
    const dy = outside(centreY, p.yPt, p.heightPt);
    const dx = outside(centreX, pageX(p), p.widthPt);
    if (dy < bestY || (dy === bestY && dx < bestX)) {
      bestY = dy;
      bestX = dx;
      best = p.index;
    }
  }
  return best;
}

/** Scroll that brings `pageIndex`'s top into view (continuous mode). */
export function scrollToPage(
  camera: Camera,
  layout: SessionPagesLayout,
  pageIndex: number,
  viewport: Viewport,
): Camera {
  const page = layout.pages[pageIndex];
  if (!page) return camera;
  const x =
    (viewport.width - page.widthPt * camera.zoom) / 2 -
    pageX(page) * camera.zoom;
  // Small breathing room above the page top, mirroring the gap.
  const y = -page.yPt * camera.zoom + Math.min(12, layout.gapPt * camera.zoom);
  return { zoom: camera.zoom, x, y };
}
