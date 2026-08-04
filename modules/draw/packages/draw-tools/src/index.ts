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

// @paged-media/draw-tools — host-agnostic tool state machines.
// Events in (page-local pt), intents/previews/commits out. The
// editor's gesture handlers are thin shims over these; a future
// isolated bundle runs the same machines unchanged.

export {
  PenMachine,
  strokeWidthFromPressure,
  penPreview,
  type PenEvent,
  type PenSample,
  type PenModifiers,
  type PenSnapshot,
  type PenCommit,
  type PenOptions,
  type StrokeWidthProfile,
} from "./pen-machine";

export {
  CurvatureMachine,
  curvaturePreview,
  type CurvatureEvent,
  type CurvatureModifiers,
  type CurvatureSnapshot,
  type CurvatureCommit,
  type CurvatureOptions,
} from "./curvature-machine";

export {
  PencilMachine,
  type PencilEvent,
  type PencilSnapshot,
  type PencilCommit,
  type PencilOptions,
} from "./pencil-machine";

// Brush tools v0 — the pencil sampling pipeline with a calligraphic
// per-anchor width lane on the commit (centerline + widths →
// outlineStrokeVariable in the bundle).
export {
  BrushMachine,
  type BrushEvent,
  type BrushOptions,
  type BrushCommit,
  type BrushSnapshot,
} from "./brush-machine";
// Wave 2 — the Width tool's drag machine (nearest-anchor peak +
// falloff profile → outlineStrokeVariable widths in the bundle).
export {
  WidthMachine,
  type WidthEvent,
  type WidthOptions,
  type WidthCommit,
  type WidthSnapshot,
} from "./width-machine";
// §13.2 on-canvas corner widgets — pure math for the corner-radius
// gesture tool (the bundle owns the host wiring).
export {
  cornerAt,
  cornerPoints,
  cornerPreview,
  maxRadius,
  radiusFromDrag,
  type Bounds,
  type CornerIndex,
} from "./corner-radius-machine";

export {
  MeasureMachine,
  measureReadout,
  type MeasureEvent,
  type MeasureModifiers,
  type MeasureReadout,
  type MeasureSnapshot,
} from "./measure-machine";

export {
  ShapeBuilderMachine,
  type ShapeBuilderEvent,
  type ShapeBuilderModifiers,
  type ShapeBuilderMode,
  type ShapeBuilderSnapshot,
  type FaceMode,
  type RegionFace,
} from "./shape-builder-machine";

export {
  planAnchorAdd,
  planAnchorDelete,
  planAnchorConvert,
  nearestAnchorIndex,
  segmentPairsOf,
  type AnchorEditPlan,
  type SegmentPair,
} from "./anchor-machine";

export type { AnchorTripleFeedsWire } from "./wire-compat";
