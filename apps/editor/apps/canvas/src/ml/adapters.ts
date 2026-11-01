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

// Between the doors' images and a model's tensors (editor ADR 290): an RGBA
// image becomes an NCHW float RGB tensor at the model's size, a model's
// output becomes a mask, an image or landmark points at the caller's size.
// Pure functions; the worker only ever sees tensors.

import type { MlImage, MlMask, MlPoint } from "@paged-media/plugin-api";

import type { ModelAdapter } from "./registry";
import type { WireTensor } from "./worker-protocol";

/** Bilinear sample of one channel of a planar float image. */
function sample(
  plane: Float32Array,
  w: number,
  h: number,
  x: number,
  y: number,
): number {
  const fx = Math.min(Math.max(x, 0), w - 1);
  const fy = Math.min(Math.max(y, 0), h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const ax = fx - x0;
  const ay = fy - y0;
  const top = plane[y0 * w + x0]! * (1 - ax) + plane[y0 * w + x1]! * ax;
  const bot = plane[y1 * w + x0]! * (1 - ax) + plane[y1 * w + x1]! * ax;
  return top * (1 - ay) + bot * ay;
}

/** Resize a planar float image (pixel centres aligned). */
export function resizePlane(
  plane: Float32Array,
  w: number,
  h: number,
  tw: number,
  th: number,
): Float32Array {
  if (w === tw && h === th) return plane;
  const out = new Float32Array(tw * th);
  const sx = w / tw;
  const sy = h / th;
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++)
      out[y * tw + x] = sample(
        plane,
        w,
        h,
        (x + 0.5) * sx - 0.5,
        (y + 0.5) * sy - 0.5,
      );
  return out;
}

/** The size a model takes the image at. */
export function inputSize(
  image: { width: number; height: number },
  adapter: ModelAdapter,
): [number, number] {
  return adapter.size ?? [image.width, image.height];
}

/** RGBA → `[1, 3, h, w]` float, 0..1 RGB, normalised when the adapter
 *  says so. */
export function imageToTensor(
  image: MlImage,
  adapter: ModelAdapter,
): WireTensor {
  const [tw, th] = inputSize(image, adapter);
  const n = image.width * image.height;
  const data = new Float32Array(3 * tw * th);
  for (let c = 0; c < 3; c++) {
    const plane = new Float32Array(n);
    for (let i = 0; i < n; i++) plane[i] = image.data[i * 4 + c]! / 255;
    const sized = resizePlane(plane, image.width, image.height, tw, th);
    const mean = adapter.mean?.[c] ?? 0;
    const std = adapter.std?.[c] ?? 1;
    for (let i = 0; i < tw * th; i++)
      data[c * tw * th + i] = (sized[i]! - mean) / std;
  }
  return { dims: [1, 3, th, tw], data };
}

/** A mask → `[1, 1, h, w]` float 0..1 at the model's size. */
export function maskToTensor(mask: MlMask, adapter: ModelAdapter): WireTensor {
  const [tw, th] = inputSize(mask, adapter);
  const plane = new Float32Array(mask.width * mask.height);
  for (let i = 0; i < plane.length; i++) plane[i] = mask.data[i]! / 255;
  return {
    dims: [1, 1, th, tw],
    data: resizePlane(plane, mask.width, mask.height, tw, th),
  };
}

const plane = (t: WireTensor, channel: number) => {
  const [h, w] = t.dims.slice(-2) as [number, number];
  return t.data.subarray(channel * w * h, (channel + 1) * w * h);
};

/** Channel 0 of `[.., h, w]` (values 0..1) → a mask at `width × height`. */
export function tensorToMask(
  t: WireTensor,
  width: number,
  height: number,
): MlMask {
  const [h, w] = t.dims.slice(-2) as [number, number];
  const sized = resizePlane(new Float32Array(plane(t, 0)), w, h, width, height);
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++)
    data[i] = Math.round(Math.min(1, Math.max(0, sized[i]!)) * 255);
  return { width, height, data };
}

/** `[1, 3, h, w]` (0..1) → an opaque RGBA image at its own size, or at
 *  `size` when given. */
export function tensorToImage(
  t: WireTensor,
  size?: { width: number; height: number },
): MlImage {
  const [h, w] = t.dims.slice(-2) as [number, number];
  const width = size?.width ?? w;
  const height = size?.height ?? h;
  const data = new Uint8ClampedArray(width * height * 4);
  const channels = t.dims.length >= 3 ? t.dims[t.dims.length - 3]! : 1;
  for (let c = 0; c < 3; c++) {
    const src = new Float32Array(plane(t, Math.min(c, channels - 1)));
    const sized = resizePlane(src, w, h, width, height);
    for (let i = 0; i < width * height; i++)
      data[i * 4 + c] = Math.round(Math.min(1, Math.max(0, sized[i]!)) * 255);
  }
  for (let i = 0; i < width * height; i++) data[i * 4 + 3] = 255;
  return { width, height, data };
}

/** Flat x,y pairs in 0..1 → points in image pixels, and their box. */
export function tensorToFace(
  t: WireTensor,
  width: number,
  height: number,
): {
  box: { x: number; y: number; width: number; height: number };
  points: MlPoint[];
} {
  const points: MlPoint[] = [];
  for (let i = 0; i + 1 < t.data.length; i += 2)
    points.push({ x: t.data[i]! * width, y: t.data[i + 1]! * height });
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    box: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y },
    points,
  };
}
