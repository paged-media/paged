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

import { compose, invert, type Affine } from "@paged-media/helpers";

export { compose, invert };

/** A 2-D affine, `[a b c d e f]` (helpers' `transform`). */
export type Mat = Affine;

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
