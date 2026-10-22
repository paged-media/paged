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

// Editor ADR 281 — the frame surface's transform (pure; no React, no shell):
// host pixels ← frame-content points.

import type { Camera, ElementGeometryItem } from "@paged-media/client";

import type { PageRect } from "./layout";

export type Mat = [number, number, number, number, number, number];

/** `a ∘ b`: apply `b` first, then `a` (2-D affine, `[a b c d e f]`). */
export function compose(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/** The inverse affine, or null when singular. */
export function invert(m: Mat): Mat | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

/** Host-pixel ← frame-content-point transform for a frame's geometry:
 *  camera ∘ translate(page origin) ∘ ItemTransform ∘ translate(content
 *  box origin). Null when the frame's page is not laid out. */
export function contentToHostMatrix(
  camera: Pick<Camera, "scale" | "tx" | "ty">,
  page: Pick<PageRect, "x" | "y">,
  geom: Pick<ElementGeometryItem, "bounds" | "itemTransform">,
): Mat {
  const [top, left] = geom.bounds;
  const cam: Mat = [camera.scale, 0, 0, camera.scale, camera.tx, camera.ty];
  const onPage: Mat = [1, 0, 0, 1, page.x, page.y];
  const item = (geom.itemTransform ?? [1, 0, 0, 1, 0, 0]) as Mat;
  const inset: Mat = [1, 0, 0, 1, left, top];
  return compose(compose(compose(cam, onPage), item), inset);
}
