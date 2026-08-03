/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// Curated re-exports: the wire-type subset a bundle reads/emits —
// since the M1.1(a) vendoring pass these come from ./wire.d.ts, the
// VENDORED copy of the editor's tsify-generated types (source of
// truth: core; sync + drift check: scripts/sync-wire.mjs). Same
// curation rule as contributions.ts: a type joins this list when a
// bundle actually uses it.

import type { ElementId, Mutation } from "./wire";

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
  // C-1 — the in-frame scene-layer IR (host.contribute.sceneLayer().submit).
  SceneLayer,
  SceneItem,
  ScenePathSeg,
  ScenePaint,
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

// ------------------------------------------------- protocol-ahead ops
//
// `Mutation` (above, from ./wire) IS a typed, CLOSED op union — every
// write the engine accepts, discriminated by `op`. It is GENERATED:
// wire.d.ts is vendored verbatim from the PUBLISHED
// `@paged-media/canvas-wasm` and guarded by
// `scripts/sync-wire.mjs --check` (content drift OR a stale stamp
// fails CI). The current stamp is 0.51.0 = protocol 51.
//
// Core is at **protocol 56** and has not published yet. Four new ops
// landed there that bundles need NOW (paged.draw's Wave-B path
// topology + B-18 nested content). Hand-editing wire.d.ts to add them
// would break the drift gate — a vendored copy that no longer matches
// its source is not a passing check. So they live HERE, in the
// hand-owned curation module, exactly the way DOC-03's `StoryContent`
// (protocol v54) ships hand-written in host.ts ahead of its vendoring:
// the shapes below are byte-equal to the tsify output the v56 build
// emits, so when canvas-wasm 0.56 publishes and `sync-wire.mjs` runs,
// `Mutation` absorbs them and these aliases become redundant (the
// union stays sound throughout — `PendingMutation` collapses into a
// subset of `Mutation`, it never contradicts it).
//
// HONEST LIMIT: a protocol-ahead op is not gated by `host.supports()`
// — the gate is the WORKER's protocol version, which the client
// handshake already checks (`protocolMismatch`). A bundle sending one
// of these to a pre-v56 worker gets an honest non-applied
// `MutationOutcome` from the engine, never a silent no-op. Nor can
// they ride the vendored `batch` op (`args.ops: Mutation[]`) until the
// re-sync — batch them by issuing separate `mutate` calls.

/** v56 (Wave B) — close an OPEN subpath of a path element: the inverse
 *  gesture of `pathOpenAt`'s scissors cut. `subpath` picks the contour
 *  by index; omit for the default (the single/last open subpath).
 *  Coincident endpoints — the duplicated pair a cut leaves — merge back
 *  into one anchor; endpoints apart gain the implicit closing edge. */
export type ClosePathMutation = {
  op: "closePath";
  args: { elementId: ElementId; subpath?: number | null };
};

/** v56 (Wave B) — weld two OPEN single-contour path elements into one
 *  (InDesign's Join): connect the NEAREST endpoints of `elementId` and
 *  `otherId`, then delete `otherId`. Both endpoint pairs coincident
 *  closes the result into a ring. Non-path / closed / multi-contour
 *  inputs are rejected with an honest error (no-op). One undo step
 *  restores BOTH elements. */
export type JoinPathsMutation = {
  op: "joinPaths";
  args: { elementId: ElementId; otherId: ElementId };
};

/** v56 (B-18) — InDesign paste-into: nest an existing TOP-LEVEL page
 *  item inside a container Rectangle / Oval / Polygon. The child keeps
 *  its document-space geometry (nothing moves on canvas) and renders
 *  clipped by the container's outline. Grouped / already-nested
 *  children and non-container hosts are rejected with an honest error.
 *  One undo pops the child back to its exact stacking slot. */
export type PasteIntoMutation = {
  op: "pasteInto";
  args: { containerId: ElementId; childId: ElementId };
};

/** v56 (B-18) — the inverse gesture: pop a pasted-in child back to top
 *  level (stacks on top), world transform preserved. One undo re-nests
 *  it at the same child index. */
export type ReleaseFromMutation = {
  op: "releaseFrom";
  args: { childId: ElementId };
};

/** The protocol-ahead ops, as one union — the delta between the
 *  vendored `Mutation` (protocol 51) and core's protocol 56. Empties
 *  itself on the next `sync-wire.mjs` run. */
export type PendingMutation =
  | ClosePathMutation
  | JoinPathsMutation
  | PasteIntoMutation
  | ReleaseFromMutation;

/** What `host.document.mutate` ACCEPTS: the vendored op union plus the
 *  protocol-ahead ops. Widening an accepted-input type is additive —
 *  every existing `Mutation` call site still compiles. */
export type MutationInput = Mutation | PendingMutation;
