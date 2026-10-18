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

// The one place a freehand/curvature commit becomes an engine
// `insertPath` Mutation — exported so the conformance specs replay the
// EXACT wire shape the live tools emit (no second copy to drift from).

import type { Mutation } from "@paged-media/plugin-api";
import type { AnchorTriple } from "@paged-media/draw-geometry";

/** `insertPath{ pageId, anchors, open }` for a committed anchor run.
 *  The anchors carry their fitted handles, so the engine's optional
 *  `smooth` pass is NOT requested — the machines own the smoothing
 *  (draw-geometry's Catmull-Rom fit), keeping preview == committed
 *  geometry. */
export function insertPathMutationFor(
  pageId: string,
  anchors: readonly AnchorTriple[],
  open: boolean,
): Mutation {
  return {
    op: "insertPath",
    args: {
      pageId,
      anchors: anchors.map((a) => ({
        anchor: [a.anchor[0], a.anchor[1]] as [number, number],
        left: [a.left[0], a.left[1]] as [number, number],
        right: [a.right[0], a.right[1]] as [number, number],
      })),
      open,
    },
  };
}
