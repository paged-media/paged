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
