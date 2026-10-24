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

// WP4.5 — the Info panel's arithmetic, kept pure so the unit lane proves
// it: the selection's box and angle from the engine's geometry, a pixel
// read out of a decoded snapshot, and the colour conversions a sampled
// display pixel allows (sRGB → hex and CIE L*a*b*, D50 as ICC's PCS).

import type { ElementGeometryItem } from "@paged-media/client";

export interface SelectionReadout {
  /** Top-left of the selection's axis-aligned box, page space, pt. */
  x: number;
  y: number;
  /** One item: its own width and height (scaled, not the rotated box's);
   *  several: the box's. */
  w: number;
  h: number;
  /** Degrees as the transform fields show them (the engine's
   *  decomposition), or null when several items disagree. */
  angle: number | null;
  /** How many items the readout covers (those on a page). */
  count: number;
}

type Affine = readonly [number, number, number, number, number, number];
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** The transform's rotation, as `decompose_transform` reads it: a
 *  mirroring matrix folds its reflection into X first. */
export function angleOf(m: Affine | null | undefined): number {
  const [a, b, c, d] = m ?? IDENTITY;
  const sign = a * d - b * c < 0 ? -1 : 1;
  const a2 = sign * a;
  const b2 = sign * b;
  if (a2 === 0 && b2 === 0) return 0;
  const deg = (Math.atan2(b2, a2) * 180) / Math.PI;
  return Math.abs(deg) < 1e-9 ? 0 : deg;
}

function scaleOf(m: Affine): [number, number] {
  const [a, b, c, d] = m;
  const sx = Math.hypot(a, b);
  const det = Math.abs(a * d - b * c);
  return [sx, sx === 0 ? 0 : det / sx];
}

/** The selection's position, size and angle. Items without a page (the
 *  pasteboard before placement) are left out; null when none remain. */
export function selectionReadout(
  items: ReadonlyArray<ElementGeometryItem>,
): SelectionReadout | null {
  const onPage = items.filter((g) => g.pageId);
  if (onPage.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const angles: number[] = [];
  for (const g of onPage) {
    const m = (g.itemTransform ?? IDENTITY) as Affine;
    const [top, left, bottom, right] = g.bounds;
    for (const [x, y] of [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ] as const) {
      const px = m[0] * x + m[2] * y + m[4];
      const py = m[1] * x + m[3] * y + m[5];
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
    angles.push(angleOf(m));
  }
  const same = angles.every((a) => Math.abs(a - angles[0]!) < 1e-6);
  if (onPage.length === 1) {
    const g = onPage[0]!;
    const m = (g.itemTransform ?? IDENTITY) as Affine;
    const [sx, sy] = scaleOf(m);
    const [top, left, bottom, right] = g.bounds;
    return {
      x: minX,
      y: minY,
      w: (right - left) * sx,
      h: (bottom - top) * sy,
      angle: angles[0]!,
      count: 1,
    };
  }
  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
    angle: same ? angles[0]! : null,
    count: onPage.length,
  };
}

/** A decoded RGBA raster (an `ImageData`'s shape). */
export interface Raster {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

/** The pixel of `raster` (a page drawn `width` px wide) under the page
 *  point, or null outside the page. */
export function samplePixel(
  raster: Raster,
  pageSizePt: readonly [number, number],
  pagePoint: readonly [number, number],
): [number, number, number, number] | null {
  const [pw, ph] = pageSizePt;
  const [x, y] = pagePoint;
  if (pw <= 0 || ph <= 0 || x < 0 || y < 0 || x > pw || y > ph) return null;
  const px = Math.min(raster.width - 1, Math.floor((x / pw) * raster.width));
  const py = Math.min(raster.height - 1, Math.floor((y / ph) * raster.height));
  const i = (py * raster.width + px) * 4;
  const d = raster.data;
  return [d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!];
}

/** `#rrggbb`. */
export function rgbHex(r: number, g: number, b: number): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** sRGB (0–255) → CIE L*a*b* under D50, through the Bradford-adapted
 *  sRGB matrix ICC profiles use. Rounded to one decimal. */
export function srgbToLab(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  // sRGB → XYZ (D50), Bradford-adapted (the sRGB ICC profile's colorants).
  const X = 0.4360747 * R + 0.3850649 * G + 0.1430804 * B;
  const Y = 0.2225045 * R + 0.7168786 * G + 0.0606169 * B;
  const Z = 0.0139322 * R + 0.0971045 * G + 0.7141733 * B;
  const [Xn, Yn, Zn] = [0.96422, 1, 0.82521];
  const f = (t: number) =>
    t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116;
  const fx = f(X / Xn);
  const fy = f(Y / Yn);
  const fz = f(Z / Zn);
  const r1 = (v: number) => {
    const n = Math.round(v * 10) / 10;
    return Object.is(n, -0) ? 0 : n;
  };
  return [r1(116 * fy - 16), r1(500 * (fx - fy)), r1(200 * (fy - fz))];
}
