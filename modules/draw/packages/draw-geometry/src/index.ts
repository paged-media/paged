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
export { segmentDistance, simplifyRdp, simplifyRdpIndices } from "./rdp";
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
// Brush tools v0 — the calligraphic nib width model (tangent angle ×
// nib × pressure → per-anchor width stops for outlineStrokeVariable).
export {
  calligraphicWidth,
  anchorTangentAngle,
  MIN_BRUSH_WIDTH_RATIO,
  type NibProfile,
} from "./brush";
// Wave 2 — parametric shape generators (insert-shape commands).
export {
  arcPath,
  spiralPath,
  rectGridPaths,
  polarGridPaths,
} from "./parametric";
// Wave 2 — the width tool's peaked per-anchor profile
// (outlineStrokeVariable stops).
export { peakedWidthProfile } from "./width";
// Wave 2 — blend interpolation (anchor-run lerp + sRGB colour mix).
export { interpolateAnchors, mixRgb } from "./blend";
// Wave 2 — the lasso-select region test.
export { pointInPolygon, pointInAnchorPath } from "./polygon";
// Illustrator Phase 2 — compound paths: the contour algebra (merge /
// split) plus the NON-ZERO winding re-orientation that makes a nested
// contour render as a HOLE instead of a solid island.
export {
  contourRanges,
  contourSignedArea,
  reverseContour,
  contourDepths,
  orientForNonZeroHoles,
  mergeCompound,
  makeCompoundTable,
  splitCompound,
} from "./compound";
