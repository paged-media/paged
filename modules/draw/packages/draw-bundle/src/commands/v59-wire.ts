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
// ------------------------------------------------------ contract skew
// NAMED, not hidden, and NARROW — all three ops have TYPED definitions
// in `@paged-media/plugin-api`'s hand-maintained protocol-ahead delta
// (`packages/plugin-api/src/mutations.ts` → `PendingMutation`):
//
//   bindCreated  { handle }                     — plugin-sdk `bc52766`
//   pasteInto    { containerId, childId }       — v56 (B-18)
//   releaseFrom  { childId }                    — v56 (B-18)
//
// This repo installs the PUBLISHED `0.2.25-canary.0`, which predates
// `bc52766` and carries none of the three in its vendored `Mutation`
// union, so the casts below are still required — but they cast toward a
// contract that EXISTS and is COMMITTED, and every argument name/type
// matches it field-for-field. When the canary bumps, the change here is
// a PURE DELETION: drop three `as unknown as Mutation` casts.
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
// A MEASURED EDGE, recorded because it is why `commands/repeat.ts` never
// addresses a group it minted in its own batch: with an EARLIER
// `bindCreated` present in the same batch, a `bindCreated` placed after
// a `createGroup` resolves inconsistently — `deleteFrame { frameId:
// "$h:g" }` reaches the GROUP (and is refused, since deleteFrame refuses
// groups) while `dissolveGroup { groupId: "$h:g" }` refuses with "node
// not found: Group(<the earlier insert's id>)". With no earlier bind in
// the batch, the dissolve resolves correctly.

import type { BundleHost, ElementId, Mutation } from "@paged-media/plugin-api";

import { engineOpVocabulary } from "./join-average";

/** The prefix a batch-local handle is referenced by. */
export const HANDLE_PREFIX = "$h:";

/** C-15 — name the id the PRECEDING creating child minted, so a LATER
 *  child of the same batch can address it as `"$h:<handle>"`. */
export function bindCreatedMutationFor(handle: string): Mutation {
  return { op: "bindCreated", args: { handle } } as unknown as Mutation;
}

/** A `"$h:<handle>"` reference as an `ElementId` of `kind`. `insertPath`
 *  mints Polygons, so that is the default. */
export function handleElementId(handle: string, kind = "polygon"): ElementId {
  return { kind, id: `${HANDLE_PREFIX}${handle}` } as ElementId;
}

/** B-18 — nest an existing TOP-LEVEL page item inside a container
 *  Rectangle / Oval / Polygon. The child keeps its document-space
 *  geometry (nothing moves on canvas) and renders CLIPPED by the
 *  container's outline. */
export function pasteIntoMutationFor(
  containerId: ElementId,
  childId: ElementId,
): Mutation {
  return {
    op: "pasteInto",
    args: { containerId, childId },
  } as unknown as Mutation;
}

/** B-18 — the inverse: pop a pasted-in child back to top level (it
 *  stacks on top), world transform preserved. */
export function releaseFromMutationFor(childId: ElementId): Mutation {
  return { op: "releaseFrom", args: { childId } } as unknown as Mutation;
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
