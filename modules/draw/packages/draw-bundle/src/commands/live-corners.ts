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

// Live Corners — the corner builder this bundle's scripts and specs use.
// The on-canvas corner widgets (a rectangle's, a text frame's, a
// polygon's) are the host's live-shape widgets (editor ADR 310). The corner PRESET commands (Rounded / Inverse
// rounded / Bevel / Fancy / None) are the host's (`paged.corners.*`,
// PM-0017) and build through the same shared writes
// (`@paged-media/helpers`' `cornerPresetOps`). The `liveCorners` metadata
// marker the commands used to stamp was never read by anything and went
// with them; a stale one in an old document is inert.
//
// The wire carries the per-corner PropertyPaths
// (`frameCornerOption{TopLeft,TopRight,BottomRight,BottomLeft}` +
// `frameCornerRadius{...}`). For POLYGONS only the TOP-LEFT slot drives
// geometry (the renderer's `uniform_corner` reads `corners[0]`), because
// "top left" has no meaning for an N-gon; the other three round-trip.

import {
  cornerPresetOps,
  supportsLiveCornerKind,
  type CornerStyleToken,
} from "@paged-media/helpers";
import type { ElementId, Mutation } from "@paged-media/plugin-api";

export type { CornerStyleToken };

/** Whether a corner write changes anything on `id` (the kinds the engine
 *  both accepts and renders). */
export function supportsLiveCorners(id: ElementId): boolean {
  return supportsLiveCornerKind(id.kind);
}

/** The eight writes of one style at one uniform radius, in ONE `batch` =
 *  one undo step. */
export function cornerStyleMutationFor(
  elementId: ElementId,
  preset: { style: CornerStyleToken; radius: number },
): Mutation {
  return {
    op: "batch",
    args: {
      ops: cornerPresetOps(
        elementId,
        preset.style,
        preset.radius,
      ) as Mutation[],
    },
  };
}
