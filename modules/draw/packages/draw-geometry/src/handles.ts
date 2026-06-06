// Handle derivation for interactive anchor creation. IDML convention
// (and the engine's wire shape): a corner point carries both handles
// collapsed onto the anchor; a smooth point mirrors them.

import { clone, type Vec2, type Vec2Mut } from "./types";
import type { AnchorTriple } from "./types";

/** A corner anchor — both handles collapsed (the pencil/pen click). */
export function cornerAnchor(point: Vec2): AnchorTriple {
  return { anchor: clone(point), left: clone(point), right: clone(point) };
}

/** Mirror `handle` through `anchor` — the smooth-pair twin. */
export function mirrorHandle(anchor: Vec2, handle: Vec2): Vec2Mut {
  return [2 * anchor[0] - handle[0], 2 * anchor[1] - handle[1]];
}

/** Smooth anchor from a pen drag: the outgoing (right) handle follows
 *  the pointer, the incoming (left) mirrors it. */
export function smoothAnchorFromDrag(anchor: Vec2, drag: Vec2): AnchorTriple {
  return {
    anchor: clone(anchor),
    left: mirrorHandle(anchor, drag),
    right: clone(drag),
  };
}
