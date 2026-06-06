// @paged-media/draw-tools — host-agnostic tool state machines.
// Events in (page-local pt), intents/previews/commits out. The
// editor's gesture handlers are thin shims over these; a future
// isolated bundle runs the same machines unchanged.

export {
  PenMachine,
  type PenEvent,
  type PenModifiers,
  type PenSnapshot,
  type PenCommit,
  type PenOptions,
} from "./pen-machine";

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
