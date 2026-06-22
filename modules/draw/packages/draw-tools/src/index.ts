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
