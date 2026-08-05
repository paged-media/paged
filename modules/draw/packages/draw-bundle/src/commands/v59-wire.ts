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

// THE PROTOCOL-AHEAD WIRE SEAM FOR C-15 + B-18 — `bindCreated`,
// `pasteInto` and `releaseFrom`, their `"$h:"` reference helper, their
// capability probes and their refusal reader. The `v58-wire.ts`
// precedent, for the same reason: two features reaching the same
// protocol generation through two copies of the same cast is exactly the
// drift the no-second-copy rule exists to prevent.
//
// THE FOURTH SEAM in this repo, and it deliberately does NOT absorb the
// other three: `handlers/planar-regions.ts` owns K-11's arrangement
// query, `commands/v58-wire.ts` owns the C-28/C-29 quartet, and
// `binding-provider/adr023-seam.ts` owns the binding-provider door AND
// the one protocol-59 `reorderElement` its Layers lane needs. Nothing
// here reorders anything, so `reorderElement` is not re-declared —
// there is exactly one builder for it and it lives with its consumer.
//
// ------------------------------------------- contract skew: CLOSED
// This block used to explain three `as unknown as Mutation` casts and
// promise they would become a pure deletion at the next canary bump.
// The bump happened (`0.2.25-canary.0` → `0.2.28-canary.0`) and the
// deletion is done: all three ops carry TYPED definitions in
// `@paged-media/plugin-api`'s protocol-ahead delta —
//
//   bindCreated  { handle }                     — plugin-sdk `bc52766`
//   pasteInto    { containerId, childId }       — v56 (B-18)
//   releaseFrom  { childId }                    — v56 (B-18)
//
// — and the builders below return `PendingMutation` directly.
//
// The delta is still a DELTA: these ops live in `PendingMutation`, not
// in `Mutation`, and the door that accepts both is
// `MutationInput = Mutation | PendingMutation` (what
// `host.document.mutate` takes). So a batch that mixes settled and
// protocol-ahead ops is typed `MutationInput[]`, never `Mutation[]` —
// that is a real distinction the contract is making, not a leftover,
// and it is why this file still exists after the casts are gone.
//
// ---------------------------------------------------- what C-15 buys
// `bindCreated` is what collapses a two-batch flow into ONE undo step.
// Before it, a bundle that inserted geometry and then painted, linked or
// grouped it had to issue two batches — which is why `pattern.ts`,
// `appearance-bake.ts`, `compound-path.ts` (release), `symbols.ts`,
// `image-trace.ts`, `live-paint.ts` and `blend.ts` each pay two undo
// steps and say so. THREE RULES, each measured against the booted engine
// rather than assumed, because getting any of them wrong fails in a
// confusing way:
//   1. the bind must come AFTER its creating child. Placed before, the
//      batch is refused BY NAME ("has nothing to name — no creating
//      child ran before it in this batch");
//   2. it is its OWN op, not a field. A handle inside a creating op's
//      own `args` is SILENTLY IGNORED, and the later `$h:` then fails
//      with "node not found";
//   3. scope is the declaring batch. A `$h:` in TEXT content is content
//      and is never rewritten.
//
// MEASURED HERE, and every one of these is a position this bundle
// actually uses: `"$h:<handle>"` resolves in an `ElementId.id`, in a
// bare-string `deleteFrame.frameId`, in `setElementProperty.elementId`
// (including the `framePath` door), in a `createGroup.memberIds` entry
// and at BOTH ends of `pasteInto`. 200 inserts + binds + property writes
// apply in one batch in ~12 ms and ONE undo removes all of them.
//
// A MEASURED EDGE — DIAGNOSED AND FIXED IN CORE, still worked around
// here until the engine ships it. This is why `commands/repeat.ts` never
// addresses a group it minted in its own batch: with an EARLIER
// `bindCreated` present in the same batch, a `bindCreated` placed after
// a `createGroup` resolved to the PREVIOUS creation, so
// `dissolveGroup { groupId: "$h:g" }` refused with "node not found:
// Group(<the earlier insert's id>)".
//
// The cause was never the resolver. A wire `createGroup` translated with
// `spec.self_id: None` — the engine minted the group's id during APPLY —
// while a handle-using batch translates every child BEFORE applying any
// of them, so it could only learn a created id from the translated op.
// `None` there meant nothing was bound and the stale previous creation
// stayed live. Core now mints the group id at translation time (the same
// `u<hex>` space and the same value the applier would have chosen), so
// the group is nameable by the bind that follows it.
//
// KEEP THE WORKAROUND until the engine carrying that fix is published:
// this bundle runs against whatever wasm the host booted, and reading the
// previous group out of the TREE is correct on both old and new engines.

import type {
  BundleHost,
  ElementId,
  Mutation,
  MutationInput,
  PendingMutation,
} from "@paged-media/plugin-api";

import { engineOpVocabulary } from "./join-average";

/** The prefix a batch-local handle is referenced by. */
export const HANDLE_PREFIX = "$h:";

/** C-15 — name the id the PRECEDING creating child minted, so a LATER
 *  child of the same batch can address it as `"$h:<handle>"`. */
export function bindCreatedMutationFor(handle: string): PendingMutation {
  return { op: "bindCreated", args: { handle } };
}

/** A `"$h:<handle>"` reference as an `ElementId` of `kind`. `insertPath`
 *  mints Polygons, so that is the default.
 *
 *  `kind` is narrowed to the kinds whose `id` is a STRING, which the
 *  contract's union makes explicit and the old cast hid: `storyRange`,
 *  `table` and `tableCell` key on a STRUCTURED id (story + offsets,
 *  story + table, story + table + row/col), and there is no way to
 *  express "the thing the previous op minted" in those shapes. A handle
 *  addresses a page ITEM; the three structured kinds are addresses
 *  INSIDE a story, which no creating op mints. */
type HandleableElementId = Extract<ElementId, { id: string }>;

export function handleElementId(
  handle: string,
  kind: HandleableElementId["kind"] = "polygon",
): HandleableElementId {
  return { kind, id: `${HANDLE_PREFIX}${handle}` } as HandleableElementId;
}

/** B-18 — nest an existing TOP-LEVEL page item inside a container
 *  Rectangle / Oval / Polygon. The child keeps its document-space
 *  geometry (nothing moves on canvas) and renders CLIPPED by the
 *  container's outline. */
export function pasteIntoMutationFor(
  containerId: ElementId,
  childId: ElementId,
): PendingMutation {
  return { op: "pasteInto", args: { containerId, childId } };
}

/** B-18 — the inverse: pop a pasted-in child back to top level (it
 *  stacks on top), world transform preserved. */
export function releaseFromMutationFor(childId: ElementId): PendingMutation {
  return { op: "releaseFrom", args: { childId } };
}

// ------------------------------------------- THE ONE REMAINING CAST
//
// A CONTRACT GAP, and the only one the `0.2.28-canary.0` repin did not
// close. The generated `Mutation` types batch as
// `{ op: "batch"; args: { ops: Mutation[] } }` — SETTLED ops only — and
// `PendingMutation` carries no batch variant at all. So the union has
// no way to say "a batch that contains a protocol-ahead op", which is
// precisely what every one-undo-step flow in this bundle builds:
// Repeats, Blends, opacity masks and text-on-path all mix settled
// inserts with `bindCreated` / `pasteInto` / `applyOpacityMask`.
//
// The engine accepts it — `bindCreated` is meaningless OUTSIDE a batch,
// so a batch containing one is the only shape it was ever designed for.
// The gap is in the hand-maintained delta, not in core.
//
// Rather than leave a `Mutation` cast at each of the twelve call sites
// the repin exposed, there is ONE builder and this is it. Filed for the
// SDK as: add a `BatchMutation` to `PendingMutation` whose `ops` are
// `MutationInput[]`. When that lands, this function loses its cast and
// keeps its signature.

/** A batch whose children may include protocol-ahead ops. */
export function batchMutationFor(ops: readonly MutationInput[]): MutationInput {
  return {
    op: "batch",
    args: { ops: ops as Mutation[] },
  };
}

// ---------------------------------------------------- refusal reading

/** The engine's own sentence for a refused B-18 op, or null. The
 *  `v58RefusalReason` precedent with this op family's marker — the
 *  refusals that matter are "a grouped item cannot be pasted into a
 *  frame (ungroup first)" and "the item is pasted into a container —
 *  release it before removing". */
export function b18RefusalReason(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  let text: string;
  try {
    text = typeof error === "string" ? error : (JSON.stringify(error) ?? "");
  } catch {
    return null;
  }
  if (!text) return null;
  const what = /"what"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  const raw = (what ? what[1].replace(/\\"/g, '"') : text).trim();
  const marked = /B-18:\s*([\s\S]*)$/.exec(raw);
  return (marked ? marked[1] : raw).trim() || null;
}

// ------------------------------------------------------- capabilities

/** Does this engine resolve `bindCreated` (protocol ≥ 57)? An
 *  unreadable vocabulary answers TRUE — optimistic, because the ATTEMPT
 *  then reports honestly (the `v58-wire.ts` convention). */
export async function supportsBindCreated(host: BundleHost): Promise<boolean> {
  const vocab = await engineOpVocabulary(host);
  if (!vocab) return true;
  return vocab.has("bindCreated");
}

/** Does this engine carry the B-18 nesting pair (protocol ≥ 56)? */
export async function supportsPasteInto(host: BundleHost): Promise<boolean> {
  const vocab = await engineOpVocabulary(host);
  if (!vocab) return true;
  return vocab.has("pasteInto") && vocab.has("releaseFrom");
}
