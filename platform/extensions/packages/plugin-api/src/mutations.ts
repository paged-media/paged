// Curated re-exports: the wire-type subset a bundle reads/emits —
// since the M1.1(a) vendoring pass these come from ./wire.d.ts, the
// VENDORED copy of the editor's tsify-generated types (source of
// truth: core; sync + drift check: scripts/sync-wire.mjs). Same
// curation rule as contributions.ts: a type joins this list when a
// bundle actually uses it.

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
  // Document reads (collections, meta, geometry, scene tree).
  CollectionName,
  DocumentMeta,
  ElementGeometryItem,
  SceneTreeNode,
  SelectionMode,
  ContentSelection,
  // Worker channel envelopes (PagedClient.send/subscribe).
  MainToWorker,
  MainToWorkerKind,
  WorkerToMain,
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
} from "./wire";
