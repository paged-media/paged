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

// WP4.5 — where the pointer is over the canvas, per editor. The viewport
// writes it on every move (and clears it when the pointer leaves); the
// Info panel reads it for its cursor X/Y and its colour sample. A store
// rather than React state in the viewport: a move must not re-render the
// canvas, only the readers that subscribed.

import type { PageId } from "@paged-media/client";

import { createValueStore, scoped, type ValueStore } from "./editor-scope";

export interface CanvasPointer {
  /** The page under the pointer, or null over the pasteboard. */
  pageId: PageId | null;
  /** The point in that page's space, pt, `(0, 0)` at its top-left; null
   *  over the pasteboard. */
  pagePoint: readonly [number, number] | null;
  /** The point in document space, pt. */
  docPoint: readonly [number, number];
}

/** This editor's canvas pointer (null: the pointer is not over it). */
export const CANVAS_POINTER = scoped<ValueStore<CanvasPointer | null>>(
  "canvasPointer",
  () => createValueStore<CanvasPointer | null>(null),
);
