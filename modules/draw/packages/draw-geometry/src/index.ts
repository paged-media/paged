// @paged-media/draw-geometry — pure path math, zero dependencies,
// host-free. The distillation target for geometry that previously
// lived inline in the editor (pencil RDP, path-edit overlay Bezier
// math); the editor re-imports it from here (D1 seam proof).

export {
  vec,
  clone,
  dist,
  type Vec2,
  type Vec2Mut,
  type AnchorTriple,
  type AnchorTable,
} from "./types";
export { segmentDistance, simplifyRdp } from "./rdp";
export { smoothAnchorsThrough } from "./spline";
export {
  splitSegmentDeCasteljau,
  evalCubic,
  closestTOnCubic,
  flattenAnchorRun,
  type SegmentSplit,
} from "./bezier";
export { constrainAngle } from "./constrain";
export { cornerAnchor, mirrorHandle, smoothAnchorFromDrag } from "./handles";
export { isCornerAnchor } from "./classify";
export {
  applyAffine,
  inverseApplyAffine,
  affineScale,
  type Affine,
} from "./affine";
export {
  NEUTRAL_PRESSURE,
  clampPressure,
  strokeWidthFromPressure,
  type StrokeWidthProfile,
} from "./pressure";
