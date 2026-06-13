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
  composeAffine,
  IDENTITY_AFFINE,
  type Affine,
} from "./affine";
// SVG interchange — the round-trip path/shape/document layer (Phase 8).
export {
  parsePathData,
  serializePathData,
  quadToCubic,
} from "./svg-path";
export { arcToCubics, type ArcCubic } from "./svg-arc";
export {
  rectToPath,
  ellipseToPath,
  circleToPath,
  lineToPath,
  polyToPath,
} from "./svg-shapes";
export {
  parseSvgDocument,
  serializeSvgDocument,
  parseTransform,
  type SvgDocument,
  type DrawShape,
  type SvgStyle,
  type FillRule,
  type SvgWriteOptions,
} from "./svg-doc";
export {
  parseCssColor,
  rgbToHex,
  cmykToRgb,
  type Rgb,
} from "./svg-color";
export {
  NEUTRAL_PRESSURE,
  clampPressure,
  strokeWidthFromPressure,
  type StrokeWidthProfile,
} from "./pressure";
