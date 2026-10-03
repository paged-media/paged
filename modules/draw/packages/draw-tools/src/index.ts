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
  penPlanMutation,
  penEndpointAt,
  type PenEndpoint,
  type PenEvent,
  type PenSample,
  type PenModifiers,
  type PenSnapshot,
  type PenCommit,
  type PenOptions,
  type PenPath,
  type PenHit,
  type PenIntent,
  type PenPlan,
  type StrokeWidthProfile,
} from "./pen-machine";

// PATH EDITING — the Direct Selection machine: drag anchors, handles and
// segments of one path, marquee/click selection, nudge, delete. Events
// plus a HOST-supplied hit description in; the previewed table, the
// selection and the marquee out; on release a plan that lowers to ONE
// batch (`directSelectMutation`).
export {
  DirectSelectMachine,
  directSelectMutation,
  type DirectSelectEvent,
  type DirectSelectHit,
  type DirectSelectKey,
  type DirectSelectModifiers,
  type DirectSelectMode,
  type DirectSelectOp,
  type DirectSelectOptions,
  type DirectSelectPlan,
  type DirectSelectPlanKind,
  type DirectSelectRefusal,
  type DirectSelectSnapshot,
  type MarqueeRect,
} from "./direct-select-machine";

// The ONE op applier — the engine's path-point rules on a single table
// (promoted from the test suite's reference model for
// `DirectSelectMachine.apply`), plus the index remap a selection follows.
export {
  applyPathOps,
  modelOf,
  remapIndexThrough,
  type ModelTable,
} from "./apply-path-ops";

// The op vocabulary both path-editing machines plan in, the wire shapes
// it lowers to (asserted against the engine's `Mutation` union in
// wire-compat.ts), and the lowering itself.
export {
  lowerPathOp,
  pathEditBatch,
  targetedPathEditBatch,
  anchorEditOps,
  type PathPointRole,
  type PathPointOp,
  type TargetedPathOp,
  type PathPointSetWire,
  type PathPointInsertWire,
  type PathPointRemoveWire,
  type PathPointCurveTypeWire,
  type ClosePathWire,
  type JoinPathsWire,
  type InsertPathWire,
  type PathEditWireOp,
  type PathEditBatchWire,
} from "./path-edit-ops";

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

// The KNIFE's gesture: freehand (or Alt-straight) samples in, the cut
// polyline out. What the cut does is the bundle's (`commands/knife.ts`).
export {
  KnifeMachine,
  type KnifeEvent,
  type KnifeModifiers,
  type KnifeOptions,
  type KnifeCommit,
  type KnifeSnapshot,
} from "./knife-machine";

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

// LIVE PAINT v0 — the Shape Builder machine's sibling over the SAME
// `RegionFace` arrangement: hover resolves a face, a click paints it, a
// drag paints every face it crosses. Drives both the bucket and the
// face-selection tool (the host decides what the collected ids mean).
export {
  LivePaintMachine,
  type LivePaintEvent,
  type LivePaintSnapshot,
} from "./live-paint-machine";

export {
  planAnchorAdd,
  planAnchorAddAt,
  planAnchorDelete,
  planAnchorDeleteAt,
  planAnchorConvert,
  planAnchorConvertAt,
  nearestAnchorIndex,
  segmentPairsOf,
  segmentPairFrom,
  type AnchorEditPlan,
  type SegmentPair,
} from "./anchor-machine";

// Illustrator Phase 3 (§12.4) — the on-canvas REPEAT widget's math: a
// drag steers ONE parameter per kind and the overlay draws ONE guide
// polyline (the door's ceiling — see the module header for what "live"
// does and does not mean here).
export {
  repeatSteer,
  repeatGuide,
  snapAngleDeg,
  CONSTRAIN_STEP_DEG,
  MIN_RADIUS_PT,
  RING_SEGMENTS,
  type RepeatSteerKind,
  type RepeatSteer,
  type RepeatSteerModifiers,
  type RepeatGuideSpec,
} from "./repeat-machine";

export type {
  AnchorTripleFeedsWire,
  PathPointSetFeedsWire,
  PathPointInsertFeedsWire,
  PathPointRemoveFeedsWire,
  PathPointCurveTypeFeedsWire,
  ClosePathFeedsWire,
  JoinPathsFeedsWire,
  InsertPathFeedsWire,
  PathEditBatchFeedsWire,
  PathPointRoleIsWire,
} from "./wire-compat";
