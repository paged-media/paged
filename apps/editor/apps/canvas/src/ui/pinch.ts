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

// Two fingers on the canvas zoom and move it together (editor ADR 294):
// the document point under the fingers' midpoint at the start stays under
// their midpoint, and the scale follows the distance between them. Pure,
// so the arithmetic is tested without a pointer.

import type { Camera } from "@paged-media/client";

import {
  ZOOM_MAX_SCALE,
  ZOOM_MIN_SCALE,
} from "@paged-media/shell/state/zoom-range";

/** A point in the viewport's CSS pixels. */
export type ViewportPoint = readonly [number, number];

export interface Pinch {
  readonly startCamera: Camera;
  readonly startDistance: number;
  /** The document point under the starting midpoint. */
  readonly anchor: readonly [number, number];
}

function midpoint(a: ViewportPoint, b: ViewportPoint): [number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function distance(a: ViewportPoint, b: ViewportPoint): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function startPinch(
  camera: Camera,
  a: ViewportPoint,
  b: ViewportPoint,
): Pinch {
  const [mx, my] = midpoint(a, b);
  const scale = camera.scale > 0 ? camera.scale : 1;
  return {
    startCamera: camera,
    startDistance: Math.max(distance(a, b), 1),
    anchor: [(mx - camera.tx) / scale, (my - camera.ty) / scale],
  };
}

/** The camera for the fingers at `a` and `b` now. */
export function pinchCamera(
  pinch: Pinch,
  a: ViewportPoint,
  b: ViewportPoint,
): Camera {
  const factor = distance(a, b) / pinch.startDistance;
  const scale = Math.min(
    ZOOM_MAX_SCALE,
    Math.max(ZOOM_MIN_SCALE, pinch.startCamera.scale * factor),
  );
  const [mx, my] = midpoint(a, b);
  return {
    scale,
    tx: mx - pinch.anchor[0] * scale,
    ty: my - pinch.anchor[1] * scale,
  };
}
