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
  planAnchorAdd,
  planAnchorDelete,
  planAnchorConvert,
  nearestAnchorIndex,
  segmentPairsOf,
  type AnchorEditPlan,
  type SegmentPair,
} from "./anchor-machine";

export type { AnchorTripleFeedsWire } from "./wire-compat";
