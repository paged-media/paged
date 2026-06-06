// Shared geometry vocabulary. Tuples are MUTABLE [number, number] on
// outputs so results assign directly to the editor's wire types
// (`PathAnchorSpec.anchor: [number, number]`); inputs accept readonly.

export type Vec2 = readonly [number, number];
export type Vec2Mut = [number, number];

/**
 * One cubic-Bezier path point: on-curve anchor + incoming (`left`)
 * and outgoing (`right`) control handles. Structurally identical to
 * the engine's `PathAnchorSpec` / `PathAnchorTriple` wire shapes
 * (IDML `PathPointType` semantics: a corner point collapses both
 * handles onto the anchor).
 */
export interface AnchorTriple {
  anchor: Vec2Mut;
  left: Vec2Mut;
  right: Vec2Mut;
}

/**
 * Host-agnostic mirror of the engine's `PathAnchorsResult`: the flat
 * anchor table plus per-contour bookkeeping (`subpathStarts` offsets;
 * `subpathOpen` parallel to the ranges, missing entries = closed —
 * matches the renderer's `unwrap_or(false)`).
 */
export interface AnchorTable {
  anchors: readonly AnchorTriple[];
  subpathStarts: readonly number[];
  subpathOpen?: readonly boolean[];
}

export function vec(x: number, y: number): Vec2Mut {
  return [x, y];
}

export function clone(p: Vec2): Vec2Mut {
  return [p[0], p[1]];
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
