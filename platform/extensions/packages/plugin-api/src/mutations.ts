// Curated re-exports: the wire-type subset a bundle reads/emits.
// Source of truth is the tsify-generated `paged_canvas_wasm.d.ts`
// in `@paged-media/client` (PROTOCOL_VERSION-pinned, CI-enforced in
// the editor repo). Same curation rule as contributions.ts: a type
// joins this list when a bundle actually uses it.

export type {
  // Identity + addressing.
  ElementId,
  PageId,
  NodeId,
  NodeSpec,
  // The mutation channel (undoable, shared history).
  Mutation,
  Operation,
  PropertyPath,
  Value,
  // Path geometry (the paged.draw heart).
  PathAnchorSpec,
  PathAnchorTriple,
  PathAnchorsResult,
  PathPointAddress,
  PathPointRole,
  PathfinderKind,
  // Hit-testing.
  HitFilter,
  HitResult,
  // Worker gesture channel.
  GestureType,
  GestureHandle,
  GestureModifiers,
  // Color / swatch specs paged.draw's fill & stroke panels touch.
  SwatchSpec,
  GradientSpec,
  GradientStopSpec,
  SwatchSummary,
  GradientSummary,
  LayerSummary,
} from "@paged-media/client";
