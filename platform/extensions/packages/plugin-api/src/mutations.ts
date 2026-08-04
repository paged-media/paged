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
// Core is at **protocol 57** and has not published yet. Eleven new ops
// landed there that bundles need NOW: four in v56 (paged.draw's Wave-B
// path topology + B-18 nested content) and seven in v57 (B-22 — the
// REGION Pathfinder row + Shape Builder's face commit). Hand-editing
// wire.d.ts to add them would break the drift gate — a vendored copy
// that no longer matches its source is not a passing check. So they
// live HERE, in the hand-owned curation module, exactly the way DOC-03's
// `StoryContent` (protocol v54) ships hand-written in host.ts ahead of
// its vendoring: the shapes below are byte-equal to the tsify output the
// v57 build emits, so when canvas-wasm 0.57 publishes and
// `sync-wire.mjs` runs, `Mutation` absorbs them and these aliases become
// redundant (the union stays sound throughout — `PendingMutation`
// collapses into a subset of `Mutation`, it never contradicts it).
//
// HONEST LIMIT: a protocol-ahead op is not gated by `host.supports()`
// — the gate is the WORKER's protocol version, which the client
// handshake already checks (`protocolMismatch`). A bundle sending one
// of these to a pre-v56 (resp. pre-v57) worker gets an honest
// non-applied `MutationOutcome` from the engine, never a silent no-op.
// Nor can they ride the vendored `batch` op (`args.ops: Mutation[]`)
// until the re-sync — batch them by issuing separate `mutate` calls.

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

// ------------------------------------------ v57 (B-22) region ops
//
// The REGION Pathfinder row. Where the vendored `pathfinderBoolean`
// (Shape Modes) combines paths into ONE result, these resolve the planar
// ARRANGEMENT of the inputs — the faces the overlapping outlines divide
// the plane into (`host.document.planarRegions` reads that same
// arrangement) — and operate PER FACE.
//
// `elementIds` is TOP-TO-BOTTOM stacking order: index 0 is the
// FRONTMOST object (the convention `pathfinderBoolean`'s `kept`-is-top
// already sets). Getting that order wrong silently changes the result
// — a consumer derives it from paint order, it does not guess.
// Each is ONE undo step restoring every input.
//
// Consumers: paged.draw's six `Pathfinder: <verb>` commands
// (`commands/pathfinder-region.ts`) and its Shape Builder gesture
// (`handlers/shape-builder.ts`); the editor's Pathfinder panel is the
// downstream surface.

/** v57 (B-22) — every face of the arrangement becomes its own object,
 *  keeping the attributes of the topmost input covering it. */
export type PathfinderDivideMutation = {
  op: "pathfinderDivide";
  args: { elementIds: ElementId[] };
};

/** v57 (B-22) — each input is clipped to the part nothing above it
 *  covers, and loses its stroke. Inputs entirely hidden are deleted. */
export type PathfinderTrimMutation = {
  op: "pathfinderTrim";
  args: { elementIds: ElementId[] };
};

/** v57 (B-22) — Trim, then coalesce: inputs that share a fill colour
 *  merge into one object. */
export type PathfinderMergeMutation = {
  op: "pathfinderMerge";
  args: { elementIds: ElementId[] };
};

/** v57 (B-22) — keep only what falls inside the TOPMOST input, coloured
 *  by the objects beneath it; the topmost input is consumed as the
 *  cookie cutter and disappears. */
export type PathfinderCropMutation = {
  op: "pathfinderCrop";
  args: { elementIds: ElementId[] };
};

/** v57 (B-22) — fills become strokes: every arrangement edge (split at
 *  each crossing) becomes an open `GraphicLine` stroked with the fill of
 *  the input that contributed it. All inputs are consumed. */
export type PathfinderOutlineMutation = {
  op: "pathfinderOutline";
  args: { elementIds: ElementId[] };
};

/** v57 (B-22) — the BACKMOST object minus every object in front of it. */
export type PathfinderMinusBackMutation = {
  op: "pathfinderMinusBack";
  args: { elementIds: ElementId[] };
};

/** v57 (B-22) — whether `pathfinderFaces` KEEPS the named faces or
 *  REMOVES them (Shape Builder's drag vs alt-drag). */
export type FaceSelectMode = "keep" | "remove";

/** v57 (B-22) — Shape Builder's click/drag output: unite the named faces
 *  of the arrangement into one result element. `faces` carries the
 *  STABLE ids `host.document.planarRegions` reported for the SAME
 *  `elementIds` (ids are only stable per input set); `mode` picks
 *  whether they are the faces kept or the faces removed. An unknown id
 *  is REFUSED, not ignored — a stale face set fails loudly. */
export type PathfinderFacesMutation = {
  op: "pathfinderFaces";
  args: { elementIds: ElementId[]; faces: string[]; mode: FaceSelectMode };
};

/** v58 (C-28) — how the mask artwork's coverage is read. `luminosity`
 *  is Illustrator's default and PDF's `/S /Luminosity`; `alpha` reads
 *  the artwork's alpha channel instead. Unpainted area means HIDDEN for
 *  both (PDF's black backdrop). Omitted = `luminosity`. */
export type OpacityMaskType = "luminosity" | "alpha";

/** v58 (C-28) — **Make Opacity Mask**: `maskId`'s artwork becomes a soft
 *  mask over `targetId`. The mask item leaves the page's z-order (its
 *  slot is captured) and one undo pops it back exactly.
 *
 *  RENDERER GAP, stated because it is user-visible: the mask is honoured
 *  by the CPU rasterizer and by PDF export, but NOT by the Vello/WebGPU
 *  backend the editor canvas uses — Vello's `push_layer` takes a shape,
 *  not a coverage buffer. On canvas the content currently draws
 *  UNMASKED; the exported PDF is correct. Do not present this as
 *  on-canvas WYSIWYG. */
export type ApplyOpacityMaskMutation = {
  op: "applyOpacityMask";
  args: {
    targetId: ElementId;
    maskId: ElementId;
    maskType?: OpacityMaskType | null;
    invert?: boolean | null;
  };
};

/** v58 (C-28) — drop the mask relation; the artwork returns to top level
 *  with its geometry untouched. One undo re-applies the mask with its
 *  original mode/invert at the same z slot. */
export type ReleaseOpacityMaskMutation = {
  op: "releaseOpacityMask";
  args: { targetId: ElementId };
};

/** v58 (C-29) — **Type on a Path**: flow an existing story along an
 *  existing path element. The engine could already RENDER type on a path
 *  loaded from an IDML; until v58 nothing could create one.
 *
 *  Hosts are Rectangle / GraphicLine / Polygon. A TextFrame is refused
 *  WITH a reason: its glyphs are emitted by the story pass, so accepting
 *  it would produce a visible lie. `pathTypeAlignment` (Baseline /
 *  Center honoured), `flipPathEffect` and the `startBracket`/`endBracket`
 *  range are all live. `PathEffect` is deliberately NOT exposed — only
 *  `RainbowPathEffect` actually renders. */
export type AttachTextToPathMutation = {
  op: "attachTextToPath";
  args: {
    elementId: ElementId;
    storyId: string;
    pathTypeAlignment?: string | null;
    flipPathEffect?: string | null;
    startBracket?: number | null;
    endBracket?: number | null;
  };
};

/** v58 (C-29) — unlink the text from the path; the exact inverse. */
export type DetachTextFromPathMutation = {
  op: "detachTextFromPath";
  args: { elementId: ElementId };
};

/** The protocol-ahead ops, as one union — the delta between the
 *  vendored `Mutation` (protocol 51) and core's protocol 58. Empties
 *  itself on the next `sync-wire.mjs` run. */
export type PendingMutation =
  | ClosePathMutation
  | JoinPathsMutation
  | PasteIntoMutation
  | ReleaseFromMutation
  | PathfinderDivideMutation
  | PathfinderTrimMutation
  | PathfinderMergeMutation
  | PathfinderCropMutation
  | PathfinderOutlineMutation
  | PathfinderMinusBackMutation
  | PathfinderFacesMutation
  | ApplyOpacityMaskMutation
  | ReleaseOpacityMaskMutation
  | AttachTextToPathMutation
  | DetachTextFromPathMutation;

/** What `host.document.mutate` ACCEPTS: the vendored op union plus the
 *  protocol-ahead ops. Widening an accepted-input type is additive —
 *  every existing `Mutation` call site still compiles. */
export type MutationInput = Mutation | PendingMutation;
