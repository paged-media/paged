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

// Extensions ADR 338 — "rasterise these items to pixels at N ppi", the
// one helper a rasterize command, an image layer of a story and a vector
// smart object share. Built on the public contract alone
// (`host.document.elementGeometry` + `host.render.snapshot@2`), so a
// community bundle uses it the same way a built-in does.

import type {
  BundleHost,
  ElementId,
  RenderRect,
  RenderedPage,
  RenderSurface,
} from "@paged-media/plugin-api";

/** The two fields of an `elementGeometry` row the region reads. */
export interface PlacedGeometry {
  /** `[top, left, bottom, right]` in the item's own coordinates. */
  bounds: readonly number[];
  /** `[a, b, c, d, tx, ty]` into page coordinates; absent = identity. */
  itemTransform?: readonly number[] | null;
}

/** The page-pt box around items' geometric bounds (each through its
 *  `itemTransform`, so a rotated item's corners count), grown by
 *  `marginPt` on every side. */
export function regionAround(
  geometry: readonly PlacedGeometry[],
  marginPt: number,
): RenderRect {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const g of geometry) {
    const [top, left, bottom, right] = g.bounds;
    const [a, b, c, d, tx, ty] = g.itemTransform ?? [1, 0, 0, 1, 0, 0];
    for (const [x, y] of [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ]) {
      xs.push(a * x + c * y + tx);
      ys.push(b * x + d * y + ty);
    }
  }
  const x = Math.min(...xs) - marginPt;
  const y = Math.min(...ys) - marginPt;
  return {
    x,
    y,
    width: Math.max(...xs) + marginPt - x,
    height: Math.max(...ys) + marginPt - y,
  };
}

/**
 * `only` on `pageId`, cropped to what it draws within `around` (page pt),
 * at `dpi`: a transparent ground answers the trimmed image itself; a paper
 * ground draws the SAME pixel region again on white (a white ground has
 * nothing to trim by). `null` when nothing is drawn or the engine cannot
 * honour the request. The one recipe `host.render.element` and
 * {@link rasterizeElements} share.
 */
export async function snapshotCropped(
  snapshot: RenderSurface["snapshot"],
  pageId: string,
  only: ElementId[],
  around: RenderRect,
  dpi: number,
  format: "png" | "rgba",
  background: "transparent" | "paper",
): Promise<(RenderedPage & { region: RenderRect }) | null> {
  const transparent = background === "transparent";
  const trimmed = await snapshot(pageId, {
    dpi,
    only,
    clip: around,
    format: transparent ? format : "png",
    background: "transparent",
    trim: true,
  });
  if (!trimmed?.region) return null;
  if (transparent) return { ...trimmed, region: trimmed.region };
  // The trimmed region sits on whole pixels at `dpi`; pulled in by a
  // hundredth of a pixel, the clip lands on exactly those pixels again
  // (no float error grows it by one).
  const r = trimmed.region;
  const e = 0.01 * (72 / dpi);
  const white = await snapshot(pageId, {
    dpi,
    only,
    clip: {
      x: r.x + e,
      y: r.y + e,
      width: r.width - 2 * e,
      height: r.height - 2 * e,
    },
    format,
    background: "paper",
  });
  return white?.region ? { ...white, region: white.region } : null;
}

/** What {@link rasterizeElements} draws. */
export interface RasterizeOptions {
  /** Pixels per inch, 1 to 2400. */
  ppi: number;
  /** `"transparent"` (the default) or `"paper"` (white under the items). */
  background?: "transparent" | "paper";
  /** `"rgba"` (the default) or `"png"`. */
  format?: "rgba" | "png";
  /** How far past the items' geometric bounds, in pt, the pixels may
   *  reach for strokes and effects (default 72). The image is cropped to
   *  what the items draw within it, on either ground. */
  marginPt?: number;
}

/** Items as pixels, and where those pixels sit on their page. */
export interface RasterizedElements {
  pageId: string;
  widthPx: number;
  heightPx: number;
  /** The pixels: straight-alpha RGBA8 with `format: "rgba"`, else empty. */
  rgba: Uint8Array;
  /** The PNG with `format: "png"`, else empty. */
  png: Uint8Array;
  /** The page region the image covers, in page pt. */
  region: RenderRect;
  /** The same region as `[top, left, bottom, right]` — the bounds an
   *  `insertFrame` takes to place the pixels exactly over the items. */
  bounds: [number, number, number, number];
  ppi: number;
}

/**
 * Draw `ids` — page items on ONE page — alone, in their stacking order,
 * at `ppi`, the way the page draws them (effects, blend modes, text and
 * placed images included), cropped to what they draw. `null` when the
 * host has no `render.snapshot@2`, an item is unknown or on another page
 * or the pasteboard, or nothing is drawn. A read: no undo step.
 */
export async function rasterizeElements(
  host: BundleHost,
  ids: readonly ElementId[],
  options: RasterizeOptions,
): Promise<RasterizedElements | null> {
  if (ids.length === 0 || !host.supports("render.snapshot@2")) return null;
  const geometry = await host.document.elementGeometry([...ids]);
  if (geometry.length !== ids.length) return null;
  const pageId = geometry[0]?.pageId;
  if (!pageId || geometry.some((g) => g.pageId !== pageId)) return null;
  const clip = regionAround(geometry, options.marginPt ?? 72);
  const shot = await snapshotCropped(
    (page, opts) => host.render.snapshot(page, opts),
    pageId,
    [...ids],
    clip,
    options.ppi,
    options.format ?? "rgba",
    options.background ?? "transparent",
  );
  if (!shot) return null;
  const r = shot.region;
  return {
    pageId,
    widthPx: shot.widthPx,
    heightPx: shot.heightPx,
    rgba: shot.rgba ?? new Uint8Array(0),
    png: shot.png,
    region: r,
    bounds: [r.y, r.x, r.y + r.height, r.x + r.width],
    ppi: options.ppi,
  };
}
