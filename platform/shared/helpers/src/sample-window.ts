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

// THE EYEDROPPER'S SAMPLE — Photoshop's sample sizes and the average of the
// window around a pixel. One implementation (P2): the host Eyedropper
// averages a page snapshot with it, and paged.image averages its own
// layers (the host Eyedropper's target provider in an image's context).

/** The sizes an eyedropper offers: the point, then the average of an
 *  N×N window around it. */
export type SampleSize = 1 | 3 | 5 | 11 | 31 | 51 | 101;

export const SAMPLE_SIZES: readonly SampleSize[] = [1, 3, 5, 11, 31, 51, 101];

/** Is `v` one of the offered sample sizes? */
export function isSampleSize(v: unknown): v is SampleSize {
  return (SAMPLE_SIZES as readonly unknown[]).includes(v);
}

/** The window an N×N sample around pixel `at` covers, clipped to a
 *  `w`×`h` raster; null when `at` lies outside it. */
export function sampleWindow(
  at: readonly [number, number],
  size: number,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } | null {
  const px = Math.floor(at[0]);
  const py = Math.floor(at[1]);
  if (px < 0 || py < 0 || px >= w || py >= h) return null;
  const r = (size - 1) / 2;
  const x0 = Math.max(0, px - r);
  const y0 = Math.max(0, py - r);
  const x1 = Math.min(w, px + r + 1);
  const y1 = Math.min(h, py + r + 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The average of a straight-RGBA8 window, as straight RGBA in [0,1].
 * Colour is averaged PREMULTIPLIED, so a transparent neighbour does not
 * drag the sample toward black; alpha is the plain mean. An empty window
 * yields null.
 */
export function averageRgba8(
  px: ArrayLike<number>,
): [number, number, number, number] | null {
  const n = Math.floor(px.length / 4);
  if (n === 0) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let i = 0; i < n * 4; i += 4) {
    const al = px[i + 3]! / 255;
    r += (px[i]! / 255) * al;
    g += (px[i + 1]! / 255) * al;
    b += (px[i + 2]! / 255) * al;
    a += al;
  }
  if (a === 0) return [0, 0, 0, 0];
  return [r / a, g / a, b / a, a / n];
}
