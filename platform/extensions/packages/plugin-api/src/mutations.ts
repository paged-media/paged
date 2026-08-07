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

import type { Mutation } from "./wire";

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
// fails CI). The current stamp is 0.61.0 = protocol 61.
//
// THE WAIT IS OVER (2026-08-06). This block was written while core sat
// at protocol 59 with nothing published: sixteen ops that bundles needed
// NOW lived here, in the hand-owned curation module, because
// hand-editing wire.d.ts to add them would have broken the drift gate —
// a vendored copy that no longer matches its source is not a passing
// check. canvas-wasm 0.61.0 published, `sync-wire.mjs` ran, and the
// vendored `Mutation` union now carries every one of them (four in v56 —
// Wave-B path topology + B-18 nested content; seven in v57 — the B-22
// REGION Pathfinder row + Shape Builder's face commit; four in v58 —
// C-28 opacity masks + C-29 type-on-a-path; one in v59 — Arrange, the
// z-order door). The prediction held exactly: `PendingMutation`
// collapsed into a SUBSET of `Mutation` rather than contradicting it, so
// the union stayed sound throughout.
//
// The aliases below are therefore REDUNDANT — and they stay anyway,
// because removing exported contract types is a breaking change and
// paged.draw imports them by name (`RegionMutation`,
// `OpacityMaskMutation`, in draw-bundle's index.ts and v58-wire.ts).
// Retiring them is a deliberate two-repo change: move paged.draw onto
// the vendored `Mutation` members first, then delete these.
//
// K-12 (2026-08-07) — they are now aliases IN FACT, not just in this
// comment: each is `Extract<Mutation, { op: "…" }>` rather than a
// re-declared object literal. Saying "redundant" while shipping a
// second hand-written copy of a generated type is how the two come
// apart — structural typing hides it until the generated side changes
// a field, and then the error lands in a bundle, not here. See the
// subset gate at the foot of this file.
//
// HONEST LIMIT: a protocol-ahead op is not gated by `host.supports()`
// — the gate is the WORKER's protocol version, which the client
// handshake already checks (`protocolMismatch`). A bundle sending one
// of these to a pre-v56 (resp. pre-v57 / v58 / v59) worker gets an
// honest non-applied `MutationOutcome` from the engine, never a silent
// no-op.
//
// They CAN now ride the vendored `batch` op. Until the 0.61.0 re-sync
// `args.ops: Mutation[]` could not describe them, so callers issued
// separate `mutate` calls and got one undo step PER op; the vendored
// union now contains them, so a sequence that belongs together can be
// batched back into a single undo step.

/** v56 (Wave B) — close an OPEN subpath of a path element: the inverse
 *  gesture of `pathOpenAt`'s scissors cut. `subpath` picks the contour
 *  by index; omit for the default (the single/last open subpath).
 *  Coincident endpoints — the duplicated pair a cut leaves — merge back
 *  into one anchor; endpoints apart gain the implicit closing edge. */
export type ClosePathMutation = Extract<Mutation, { op: "closePath" }>;

/** v56 (Wave B) — weld two OPEN single-contour path elements into one
 *  (InDesign's Join): connect the NEAREST endpoints of `elementId` and
 *  `otherId`, then delete `otherId`. Both endpoint pairs coincident
 *  closes the result into a ring. Non-path / closed / multi-contour
 *  inputs are rejected with an honest error (no-op). One undo step
 *  restores BOTH elements. */
export type JoinPathsMutation = Extract<Mutation, { op: "joinPaths" }>;

/** v56 (B-18) — InDesign paste-into: nest an existing TOP-LEVEL page
 *  item inside a container Rectangle / Oval / Polygon. The child keeps
 *  its document-space geometry (nothing moves on canvas) and renders
 *  clipped by the container's outline. Grouped / already-nested
 *  children and non-container hosts are rejected with an honest error.
 *  One undo pops the child back to its exact stacking slot. */
export type PasteIntoMutation = Extract<Mutation, { op: "pasteInto" }>;

/** v56 (B-18) — the inverse gesture: pop a pasted-in child back to top
 *  level (stacks on top), world transform preserved. One undo re-nests
 *  it at the same child index. */
export type ReleaseFromMutation = Extract<Mutation, { op: "releaseFrom" }>;

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
export type PathfinderDivideMutation = Extract<Mutation, { op: "pathfinderDivide" }>;

/** v57 (B-22) — each input is clipped to the part nothing above it
 *  covers, and loses its stroke. Inputs entirely hidden are deleted. */
export type PathfinderTrimMutation = Extract<Mutation, { op: "pathfinderTrim" }>;

/** v57 (B-22) — Trim, then coalesce: inputs that share a fill colour
 *  merge into one object. */
export type PathfinderMergeMutation = Extract<Mutation, { op: "pathfinderMerge" }>;

/** v57 (B-22) — keep only what falls inside the TOPMOST input, coloured
 *  by the objects beneath it; the topmost input is consumed as the
 *  cookie cutter and disappears. */
export type PathfinderCropMutation = Extract<Mutation, { op: "pathfinderCrop" }>;

/** v57 (B-22) — fills become strokes: every arrangement edge (split at
 *  each crossing) becomes an open `GraphicLine` stroked with the fill of
 *  the input that contributed it. All inputs are consumed. */
export type PathfinderOutlineMutation = Extract<Mutation, { op: "pathfinderOutline" }>;

/** v57 (B-22) — the BACKMOST object minus every object in front of it. */
export type PathfinderMinusBackMutation = Extract<Mutation, { op: "pathfinderMinusBack" }>;

/** v57 (B-22) — whether `pathfinderFaces` KEEPS the named faces or
 *  REMOVES them (Shape Builder's drag vs alt-drag). */
export type FaceSelectMode = "keep" | "remove";

/** v57 (B-22) — Shape Builder's click/drag output: unite the named faces
 *  of the arrangement into one result element. `faces` carries the
 *  STABLE ids `host.document.planarRegions` reported for the SAME
 *  `elementIds` (ids are only stable per input set); `mode` picks
 *  whether they are the faces kept or the faces removed. An unknown id
 *  is REFUSED, not ignored — a stale face set fails loudly. */
export type PathfinderFacesMutation = Extract<Mutation, { op: "pathfinderFaces" }>;

/** v58 (C-28) — how the mask artwork's coverage is read. `luminosity`
 *  is Illustrator's default and PDF's `/S /Luminosity`; `alpha` reads
 *  the artwork's alpha channel instead. Unpainted area means HIDDEN for
 *  both (PDF's black backdrop). Omitted = `luminosity`. */
export type OpacityMaskType = "luminosity" | "alpha";

/** v58 (C-28) — **Make Opacity Mask**: `maskId`'s artwork becomes a soft
 *  mask over `targetId`. The mask item leaves the page's z-order (its
 *  slot is captured) and one undo pops it back exactly.
 *
 *  RENDERS EVERYWHERE. An earlier revision of this comment warned that
 *  the mask was honoured by the CPU rasterizer and PDF export but NOT by
 *  the Vello/WebGPU backend the editor canvas uses, so a plugin must not
 *  imply WYSIWYG. **That is no longer true, and it was never as
 *  fundamental as it read**: the claim rested on the belief that Vello
 *  lacked a coverage-buffer API, when the pinned version has
 *  `Scene::push_luminance_mask_layer` (an unrelated 0.3.0 entry in
 *  `Cargo.lock`, belonging to a spike crate, was misread as the resolved
 *  version). Alpha masks need no mask layer at all — `Compose::DestIn`
 *  IS `dst · src.a`.
 *
 *  Vello output is now byte-identical to the CPU rasterizer across
 *  luminosity, alpha and both inverted forms. Safe to build WYSIWYG UI
 *  over. */
export type ApplyOpacityMaskMutation = Extract<Mutation, { op: "applyOpacityMask" }>;

/** v58 (C-28) — drop the mask relation; the artwork returns to top level
 *  with its geometry untouched. One undo re-applies the mask with its
 *  original mode/invert at the same z slot. */
export type ReleaseOpacityMaskMutation = Extract<Mutation, { op: "releaseOpacityMask" }>;

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
export type AttachTextToPathMutation = Extract<Mutation, { op: "attachTextToPath" }>;

/** v58 (C-29) — unlink the text from the path; the exact inverse. */
export type DetachTextFromPathMutation = Extract<Mutation, { op: "detachTextFromPath" }>;

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
export type ReorderElementMutation = Extract<Mutation, { op: "reorderElement" }>;

/** The protocol-ahead ops, as one union.
 *
 *  This said "the delta between the vendored `Mutation` (protocol 51)
 *  and core's protocol 59 — empties itself on the next `sync-wire.mjs`
 *  run". The run happened (the vendored stamp is 0.61.0) and the delta
 *  did NOT empty itself: `sync-wire.mjs` rewrites `wire.d.ts` and has
 *  no idea this file exists. So it is currently EMPTY in substance —
 *  every member is a member of `Mutation` — while still being a real
 *  union, and the gate at the foot of this file is what keeps that
 *  claim honest instead of asserting it in prose. */
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
export type BindCreatedMutation = Extract<Mutation, { op: "bindCreated" }>;

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

/** K-12 — THE DELTA IS A SUBSET OF `Mutation`, and this is the gate.
 *
 *  `sync-wire.mjs` empties the delta in one direction only: it refreshes
 *  `wire.d.ts`, and nothing here notices that the ops it used to be
 *  ahead of have arrived. So the delta drained itself and no one told
 *  it — every member above is now IN the vendored union, and the block's
 *  own header has said so since 2026-08-06 while the members went on
 *  being independently-declared object literals.
 *
 *  That is not cosmetic. A hand-written literal that HAPPENS to match a
 *  generated one is a second type that structural typing lets you get
 *  away with until the generated side changes a field — and then the
 *  error surfaces at the call site, not here. Declaring each member as
 *  `Extract<Mutation, …>` makes them one type by construction, so they
 *  cannot drift at all.
 *
 *  This line is the check: if any member ever stops being part of
 *  `Mutation`, its `Extract` collapses to `never`, `PendingMutation`
 *  narrows, and the assignment below fails to compile — naming the
 *  regression here rather than in whichever bundle hit it first. When a
 *  genuinely protocol-ahead op is added, it will not be an `Extract`,
 *  and this line is what will (correctly) fail until it lands in a
 *  published wire and the member is folded back.
 *
 *  Type-level, never a value: this module is the type-only façade, and
 *  a `const` here — even an unexported one — would put a runtime symbol
 *  in a package whose whole contract is that it has none. */
type Assert<T extends true> = T;
export type DeltaIsASubsetOfTheSettledUnion = Assert<
  PendingMutation extends Mutation ? true : false
>;
