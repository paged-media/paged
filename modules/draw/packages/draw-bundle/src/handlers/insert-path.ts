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
