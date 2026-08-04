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
// Core is at **protocol 59** and has not published yet. Sixteen new ops
// landed there that bundles need NOW: four in v56 (paged.draw's Wave-B
// path topology + B-18 nested content), seven in v57 (B-22 — the
// REGION Pathfinder row + Shape Builder's face commit), four in v58
// (C-28 opacity masks + C-29 type-on-a-path) and one in v59 (Arrange —
// the z-order door). Hand-editing wire.d.ts to add them would break the
// drift gate — a vendored copy that no longer matches its source is not
// a passing check. So they live HERE, in the hand-owned curation module,
// exactly the way DOC-03's `StoryContent` (protocol v54) ships
// hand-written in host.ts ahead of its vendoring: the shapes below are
// byte-equal to the tsify output the v59 build emits, so when
// canvas-wasm 0.59 publishes and `sync-wire.mjs` runs, `Mutation`
// absorbs them and these aliases become redundant (the union stays sound
// throughout — `PendingMutation` collapses into a subset of `Mutation`,
// it never contradicts it).
//
// HONEST LIMIT: a protocol-ahead op is not gated by `host.supports()`
// — the gate is the WORKER's protocol version, which the client
// handshake already checks (`protocolMismatch`). A bundle sending one
// of these to a pre-v56 (resp. pre-v57 / v58 / v59) worker gets an
// honest non-applied `MutationOutcome` from the engine, never a silent
// no-op. Nor can they ride the vendored `batch` op
// (`args.ops: Mutation[]`) until the re-sync — batch them by issuing
// separate `mutate` calls.

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

/** v59 (Arrange) — where `reorderElement` puts its target inside the
 *  sibling list it already belongs to. `0` is the BACKMOST slot (painted
 *  first). Prefer the four verbs: they are evaluated against the order
 *  the engine holds at apply time, so a concurrent insert or delete
 *  cannot make them restack the wrong item. `{ index }` is absolute and
 *  therefore CAN go stale — an out-of-range index is refused with an
 *  honest error, never clamped. */
export type ZOrderTarget =
  | "front"
  | "back"
  | "forward"
  | "backward"
  | { index: number };

/** v59 (Arrange) — **the z-order door**: restack an element within the
 *  sibling list it already belongs to. Nothing on the wire could change
 *  stacking before v59, which is why so many bundles carry "inserted
 *  items land on top of the z-order" as an accepted limit — that
 *  sentence is retired by this op.
 *
 *  The sibling list is DERIVED from where the element already is: a
 *  top-level item restacks in the spread's z table, a group member
 *  inside its group, a pasted-in child inside its container. There is no
 *  parent argument, so a reorder can never move an element between those
 *  scopes — for that use `createGroup` / `dissolveGroup` /
 *  `pasteInto` / `releaseFrom`. An opacity-mask artwork is painted from
 *  no list at all and is refused. One undo restores the previous order
 *  exactly (the engine's inverse carries the slot the item came from).
 *
 *  CREATE-THEN-ARRANGE in one undo step — the Live Paint shape (fill a
 *  face, then put the fill UNDER the strokes bounding it) — is a batch
 *  of `[insert…, bindCreated { handle }, reorderElement
 *  { elementId: "$h:<handle>", to: "back" }]`. The `bindCreated` is
 *  required: the bare `$created` sentinel is understood by
 *  `setPluginMetadata` / `setElementProperty` only, while the generic
 *  handle resolver — the one that rewrites any id position of any op —
 *  is armed by a `bindCreated` child being present.
 *
 *  HONEST LIMIT 1 — Arrange is WITHIN a layer. The renderer sorts by
 *  `ItemLayer` before it paints, so bring-to-front cannot lift an
 *  element above one on a higher layer. That is InDesign's model:
 *  crossing layers is a property write, not an Arrange.
 *
 *  HONEST LIMIT 2 — the new order shows on canvas and survives a
 *  `.paged` save, but NOT an `.idml` export: the IDML writer re-emits
 *  existing source elements byte-for-byte and only places new ones, so a
 *  reorder reverts on an export/reopen round trip. Do not present
 *  Arrange as durable across IDML interchange yet. */
export type ReorderElementMutation = {
  op: "reorderElement";
  args: { elementId: ElementId; to: ZOrderTarget };
};

/** The protocol-ahead ops, as one union — the delta between the
 *  vendored `Mutation` (protocol 51) and core's protocol 59. Empties
 *  itself on the next `sync-wire.mjs` run. */
/** v57 (C-15) — name the id a creating sibling is about to mint, so a
 *  LATER child of the same batch can address it as `"$h:<handle>"`.
 *
 *  This is what collapses a two-batch flow into ONE undo step. Before it,
 *  a bundle that inserted geometry and then painted or grouped it had to
 *  issue two batches, because a batch op could not reference an id minted
 *  in the same batch — paged.draw's appearance bake, pattern bake and
 *  re-plan, compound-path release, symbol place, image trace and
 *  live-paint fill all pay two undo steps for exactly that reason.
 *
 *  Three rules, each of which was measured against the engine rather than
 *  assumed, because getting any of them wrong fails in a confusing way:
 *
 *  1. **Order matters.** The bind must come AFTER the creating child.
 *     Placed before, the batch is refused BY NAME (an honest error, not a
 *     silent no-op).
 *  2. **It is its own op, not a field.** Passing a handle inside a
 *     creating op's own `args` is SILENTLY IGNORED — which is what made
 *     an early probe read as "the engine doesn't support this".
 *  3. **Scope is the declaring batch**, visible to its own later children
 *     including nested batches, never outward. A `$h:` appearing in TEXT
 *     content is content and is never rewritten.
 *
 *  Generalises the v34 `$created` sentinel — which only two mutation
 *  kinds understood — to any number of live names addressable from any
 *  mutation kind. */
export type BindCreatedMutation = {
  op: "bindCreated";
  args: { handle: string };
};

export type PendingMutation =
  | BindCreatedMutation
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
  | DetachTextFromPathMutation
  | ReorderElementMutation;

/** What `host.document.mutate` ACCEPTS: the vendored op union plus the
 *  protocol-ahead ops. Widening an accepted-input type is additive —
 *  every existing `Mutation` call site still compiles. */
export type MutationInput = Mutation | PendingMutation;
