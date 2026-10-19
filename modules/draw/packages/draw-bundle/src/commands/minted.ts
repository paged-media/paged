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

// "WHAT DID MY WRITE CREATE" — one function every flow that inserts goes
// through: the write, and the list of what it made.
//
// The engine's `mutationApplied` reply lists every element a batch
// minted, in mint order, and `MutationOutcome.minted` carries that list.
// (Until B3b this module also served SDKs that dropped it, through the
// raw client's reply or a scene-tree diff; see docs/migration/seams.md.)
//
// WHAT `minted` IS — measured against the booted engine and pinned in
// `test/conformance/minted.spec.ts`, because every flow below depends on
// it:
//   · a SINGLE mutation answers `minted: []` and names its one creation
//     in `createdId`; this module folds that into a one-element list;
//   · a BATCH lists one entry per CREATING child, in the order the batch
//     wrote them — `insertPath` → a polygon, `createGroup` → the GROUP
//     (kind "group"). `createSwatch` is not an element and is not listed;
//   · an element the same batch then DELETES (an absorbed compound
//     contour) or DISSOLVES is STILL listed: `minted` is what was made,
//     not what is left;
//   · `handle` is the `bindCreated` name of a bound mint and `null` for
//     an unbound one. ORDER is the contract; the name is a cross-check.
//
// A flow does not index `minted` by hand — it hands `bindMinted` the
// batch it sent, which knows from the batch itself which creations were
// named and which were groups, and refuses rather than mis-binds when the
// two disagree.

import type {
  BundleHost,
  ElementId,
  MutationInput,
  MutationOutcome,
} from "@paged-media/plugin-api";

/** One element a mutation minted. */
export interface MintedElement {
  element: ElementId;
  /** The `bindCreated` name, when the engine reports one. */
  handle: string | null;
}

/** A mutation's outcome, and what it created. */
export interface Minting {
  outcome: MutationOutcome;
  /** Every element the mutation minted, in mint order. Empty when
   *  refused, or when the outcome's list is not this mutation's. */
  minted: readonly MintedElement[];
}

const sameElement = (a: ElementId, b: ElementId): boolean =>
  a.kind === b.kind && JSON.stringify(a.id) === JSON.stringify(b.id);

/** The outcome's list, the single-mutation case folded in. Null when the
 *  list is not this mutation's: the outcome's `createdId` is the LAST
 *  thing a mutation minted (measured), so a list ending in something
 *  else was not built from the same reply. */
function mintedOf(
  outcome: Extract<MutationOutcome, { applied: true }>,
): MintedElement[] | null {
  const minted = (outcome.minted ?? []).map((m) => ({
    element: m.element,
    handle: m.handle,
  }));
  const created = outcome.createdId;
  if (minted.length === 0) {
    return created ? [{ element: created, handle: null }] : [];
  }
  if (created && !sameElement(minted[minted.length - 1]!.element, created)) {
    return null;
  }
  return minted;
}

/**
 * `host.document.mutate(mutation)`, and what it created.
 *
 * ONE write through the facade. A refusal answers `outcome.applied ===
 * false` and an empty list; nothing is retried here (the flows own their
 * fallbacks).
 */
export async function mutateMinting(
  host: BundleHost,
  mutation: MutationInput,
): Promise<Minting> {
  const outcome = await host.document.mutate(mutation);
  if (!outcome.applied) return { outcome, minted: [] };
  return { outcome, minted: mintedOf(outcome) ?? [] };
}

// ------------------------------------------------------------- binding

/** What a flow gets back for the batch it sent. */
export interface MintedBinding {
  /** `bindCreated` handle → the element it named (a handle the batch
   *  itself deleted or dissolved again is present too: `minted` is what
   *  was made). */
  byHandle: ReadonlyMap<string, ElementId>;
  /** Every group a `createGroup` child made, in the order the batch
   *  made them. */
  groups: readonly ElementId[];
}

interface Creation {
  handle: string | null;
  group: boolean;
}

/** What `batch` creates, read off the batch itself: a creating child is
 *  one a `bindCreated` names, or a `createGroup`. (An insert the batch
 *  does NOT bind is unknown here on purpose — the count then disagrees
 *  with the engine's and `bindMinted` refuses, rather than this module
 *  keeping a copy of the engine's list of creating ops.) */
function creationsOf(batch: MutationInput): Creation[] | null {
  if (batch.op !== "batch") return null;
  const ops = (batch.args as { ops: readonly MutationInput[] }).ops;
  const out: Creation[] = [];
  let previous: string | null = null;
  for (const op of ops) {
    const args = (op.args ?? {}) as Record<string, unknown>;
    if (op.op === "bindCreated") {
      const handle = String(args.handle);
      // A bind names the creating child before it. After a `createGroup`
      // (or another bind) that child is already on the list.
      const creation = out[out.length - 1];
      if (
        !creation ||
        (previous !== "createGroup" && previous !== "bindCreated")
      ) {
        out.push({ handle, group: false });
      } else if (creation.handle === null) {
        creation.handle = handle;
      }
    } else if (op.op === "createGroup") {
      out.push({ handle: null, group: true });
    }
    previous = op.op;
  }
  return out;
}

/**
 * Match what a batch minted against what the batch says it creates.
 *
 * Null when the two disagree — a count that does not match, a group
 * where a path was expected, a name the engine reports differently — so
 * a flow refuses rather than mis-binds (the `bindPatternCopies`
 * convention, for every flow at once).
 */
export function bindMinted(
  minting: Minting,
  batch: MutationInput,
): MintedBinding | null {
  const creations = creationsOf(batch);
  if (!creations || !minting.outcome.applied) return null;
  if (minting.minted.length !== creations.length) return null;
  const byHandle = new Map<string, ElementId>();
  const groups: ElementId[] = [];
  for (let i = 0; i < creations.length; i++) {
    const creation = creations[i]!;
    const minted = minting.minted[i]!;
    if (creation.group !== (minted.element.kind === "group")) return null;
    if (
      minted.handle !== null &&
      creation.handle !== null &&
      minted.handle !== creation.handle
    ) {
      return null;
    }
    if (creation.group) groups.push(minted.element);
    if (creation.handle !== null) byHandle.set(creation.handle, minted.element);
  }
  return { byHandle, groups };
}

/** The ids of a {@link Minting}, in order. */
export const mintedIds = (minting: Minting): ElementId[] =>
  minting.minted.map((m) => m.element);

/** The ids of a {@link Minting} that are not groups, in order — what a
 *  flow that inserted paths and bound nothing reads (a stepwise insert
 *  batch). */
export const mintedLeaves = (minting: Minting): ElementId[] =>
  mintedIds(minting).filter((id) => id.kind !== "group");
