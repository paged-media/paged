// Anchor classification — the corner test the editor's path-edit
// overlay uses for its smooth/corner double-click toggle: an anchor
// is a corner iff BOTH handles coincide with it (IDML's zero-handle
// convention for sharp corners).

import { dist } from "./types";
import type { AnchorTriple } from "./types";

export function isCornerAnchor(a: AnchorTriple, eps = 1e-3): boolean {
  return dist(a.left, a.anchor) < eps && dist(a.right, a.anchor) < eps;
}
