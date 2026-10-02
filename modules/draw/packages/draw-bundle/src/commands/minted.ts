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

// THE "WHAT DID MY WRITE CREATE" SEAM — one function every flow that
// inserts goes through, instead of each reading the whole scene tree
// before and after its batch and diffing the two.
//
// WHY IT EXISTS. A batch outcome carries ONE `createdId` — the last
// thing the batch made. A flow that inserts several paths therefore used
// to read `document.tree()` before its batch and again after it: two
// replies carrying every leaf of the document, to learn a handful of ids.
// Measured on a 1 403-leaf document, that was 2–3 tree reads per command
// and 150 for a symbol redefine (`test/perf/perf-budgets-commands.spec.ts`).
//
// THE ANSWER WAS ALREADY ON THE WIRE. The engine's `mutationApplied`
// reply lists every element a batch minted, in mint order (`minted`).
// plugin-sdk's `host.document.mutate` builds a `MutationOutcome` from
// that reply and drops the list (RFI K-15).
//
// THREE LANES, tried in this order, and a flow never knows which it got:
//
//   "outcome"  `outcome.minted` — a `MutationOutcome` that carries the
//              list. No published SDK does yet; when one does, this lane
//              answers and nothing below it runs.
//   "reply"    the raw reply, read off the documented escape hatch
//              `host.editor.client`. THE WRITE STILL GOES THROUGH
//              `host.document.mutate`: this module only LISTENS
//              (`client.subscribe`) while the facade writes, and takes the
//              last `mutationApplied` it heard — the reply that resolves
//              the facade's call is fanned out to subscribers in the same
//              step (the editor's client broadcasts every reply; the
//              headless host's `client.mutate` does too), so it is
//              already there when the facade's promise settles.
//              NOT `client.send({ kind: "mutate" })`, on purpose: that
//              would skip the facade's capability gate and its
//              metadata-namespace check, and — measured — the headless
//              host does not fan a `send` reply out, so no
//              `document.onDidChange` listener (the link index, every
//              open panel) would hear the write.
//   "diff"     the tree before and after, diffed — what every flow did
//              before this module, for a host with neither.
//
// WHICH LANE is learned per host and remembered. A host with the hatch is
// tried OPTIMISTICALLY — no "before" read — because `minted` is on every
// `mutationApplied` of an engine that has it (measured: the key is there
// even when the list is empty). If the reply turns out not to carry it,
// the batch has already applied and there is no "before" to diff
// against, so the seam steps back once (`undo`), reads the tree, steps
// forward again (`redo`) and reads it again. That costs two rebuilds and
// two reads ONCE per host; from then on that host takes the diff lane
// with its "before" read up front.
//
// WHAT `minted` IS — measured against the booted engine (0.64.0) and
// pinned in `test/conformance/minted.spec.ts`, because every flow below
// depends on it:
//   · a SINGLE mutation answers `minted: []` and names its one creation
//     in `createdId`; this module folds that into a one-element list;
//   · a BATCH lists one entry per CREATING child, in the order the batch
//     wrote them — `insertPath` → a polygon, `createGroup` → the GROUP
//     (kind "group"). `createSwatch` is not an element and is not listed;
//   · an element the same batch then DELETES (an absorbed compound
//     contour) or DISSOLVES is STILL listed: `minted` is what was made,
//     not what is left;
//   · `handle` is the `bindCreated` name on some batches and `null` on
//     others (a batch the engine translates whole drops the binds before
//     it applies). ORDER is the contract; the name is a cross-check.
//
// THE ONE DIFFERENCE BETWEEN THE LANES, and why `bindMinted` exists. A
// tree diff sees what SURVIVED: a transient contour is not in it, and a
// new group is found after the new leaves rather than where the batch
// made it. So a flow does not index `minted` by hand — it hands
// `bindMinted` the batch it sent, which knows from the batch itself
// which creations were named, which were groups and which the batch took
// away again, and answers the same map in every lane.

import type {
  BundleHost,
  ElementId,
  MutationInput,
  MutationOutcome,
  SceneTreeNode,
} from "@paged-media/plugin-api";

import { HANDLE_PREFIX } from "./v59-wire";

/** Where a {@link Minting} came from (the module header). */
export type MintLane = "outcome" | "reply" | "diff";

/** One element a mutation minted. */
export interface MintedElement {
  element: ElementId;
  /** The `bindCreated` name, when the engine reports one. `null` is not
   *  "unnamed" — see the module header. */
  handle: string | null;
}

/** A mutation's outcome, and what it created. */
export interface Minting {
  outcome: MutationOutcome;
  /** In the "outcome" and "reply" lanes: every element the mutation
   *  minted, in mint order. In the "diff" lane: the new nodes the tree
   *  shows — leaves in tree order, then groups. Empty when refused. */
  minted: readonly MintedElement[];
  lane: MintLane;
}

/** The lane each host answered through last. Keyed by the host object,
 *  like the link index and the op-vocabulary probe. */
const lanes = new WeakMap<object, MintLane>();

const isElementId = (v: unknown): v is ElementId =>
  !!v &&
  typeof v === "object" &&
  typeof (v as { kind?: unknown }).kind === "string" &&
  "id" in (v as object);

/** A `minted` list as the wire (or a future outcome) spells it, or null
 *  when `raw` is not one. Tolerates both `{ element, handle }` entries
 *  and bare element ids. */
function parseMinted(raw: unknown): MintedElement[] | null {
  if (!Array.isArray(raw)) return null;
  const out: MintedElement[] = [];
  for (const entry of raw) {
    const element = isElementId(entry)
      ? entry
      : (entry as { element?: unknown } | null)?.element;
    if (!isElementId(element)) return null;
    const handle = (entry as { handle?: unknown } | null)?.handle;
    out.push({ element, handle: typeof handle === "string" ? handle : null });
  }
  return out;
}

const sameElement = (a: ElementId, b: ElementId): boolean =>
  a.kind === b.kind && JSON.stringify(a.id) === JSON.stringify(b.id);

/** Fold the single-mutation case in, and refuse a list that is not this
 *  mutation's: the outcome's `createdId` is the LAST thing a mutation
 *  minted (measured), so a list ending in something else was not built
 *  from the same reply. */
function settle(
  minted: MintedElement[],
  outcome: Extract<MutationOutcome, { applied: true }>,
): MintedElement[] | null {
  const created = outcome.createdId;
  if (minted.length === 0) {
    return created ? [{ element: created, handle: null }] : [];
  }
  if (created && !sameElement(minted[minted.length - 1]!.element, created)) {
    return null;
  }
  return minted;
}

/** Listen on the raw client for the reply the facade is about to
 *  receive. Null when this host has no hatch. */
function tapReplies(
  host: BundleHost,
): { stop(): MintedElement[] | null } | null {
  try {
    let heard = false;
    let last: unknown;
    const off = host.editor.client.subscribe((message) => {
      if (message.kind !== "mutationApplied") return;
      heard = true;
      last = (message.payload as { minted?: unknown }).minted;
    });
    return {
      stop() {
        try {
          off();
        } catch {
          /* a listener that cannot be removed has nothing more to hear */
        }
        return heard ? parseMinted(last) : null;
      },
    };
  } catch {
    return null;
  }
}

const nodeKey = (id: ElementId): string =>
  `${id.kind}:${typeof id.id === "string" ? id.id : JSON.stringify(id.id)}`;

/** Every node of the tree that carries an id — leaves in tree order
 *  (which is insertion order, which is paint order), then groups. */
function nodesOf(roots: readonly SceneTreeNode[]): ElementId[] {
  const leaves: ElementId[] = [];
  const groups: ElementId[] = [];
  const walk = (nodes: readonly SceneTreeNode[]): void => {
    for (const node of nodes) {
      if (node.id) (node.id.kind === "group" ? groups : leaves).push(node.id);
      walk(node.children ?? []);
    }
  };
  walk(roots);
  return [...leaves, ...groups];
}

const readNodes = async (host: BundleHost): Promise<ElementId[]> =>
  nodesOf(await host.document.tree().catch(() => []));

const added = (
  before: readonly ElementId[],
  after: readonly ElementId[],
): MintedElement[] => {
  const known = new Set(before.map(nodeKey));
  return after
    .filter((id) => !known.has(nodeKey(id)))
    .map((element) => ({ element, handle: null }));
};

/** THE DIFF LANE — the tree before, the write, the tree after. */
async function mutateDiffing(
  host: BundleHost,
  mutation: MutationInput,
): Promise<Minting> {
  const before = await readNodes(host);
  const outcome = await host.document.mutate(mutation);
  if (!outcome.applied) return { outcome, minted: [], lane: "diff" };
  return { outcome, minted: added(before, await readNodes(host)), lane: "diff" };
}

/** One history step through the facade, and whether the engine TOOK it —
 *  `document.undo()` answers nothing, so the raw reply is the only place
 *  a refused step shows. False when it cannot be heard at all. */
async function step(host: BundleHost, which: "undo" | "redo"): Promise<boolean> {
  let took = false;
  let off: (() => void) | null = null;
  try {
    off = host.editor.client.subscribe((message) => {
      if (message.kind === `${which}Applied`) took = true;
    });
    await host.document[which]();
  } catch {
    took = false;
  }
  try {
    off?.();
  } catch {
    /* nothing more to hear */
  }
  return took;
}

/** The mutation APPLIED, nothing said what it minted, and no "before"
 *  was read (the optimistic lane — module header). Step back, look, step
 *  forward, look again.
 *
 *  FAILS CLOSED. Each step is confirmed by the engine's own reply; a step
 *  back that did not happen answers an empty list (the document is as
 *  the mutation left it, and `bindMinted` then refuses rather than
 *  guesses). A step forward that did not happen is the one case that
 *  sends the mutation again — the document is provably BEFORE it there. */
async function recover(
  host: BundleHost,
  mutation: MutationInput,
  outcome: MutationOutcome,
): Promise<Minting> {
  if (!(await step(host, "undo"))) return { outcome, minted: [], lane: "diff" };
  const before = await readNodes(host);
  if (!(await step(host, "redo"))) {
    const again = await host.document.mutate(mutation);
    if (!again.applied) return { outcome: again, minted: [], lane: "diff" };
  }
  return { outcome, minted: added(before, await readNodes(host)), lane: "diff" };
}

/**
 * `host.document.mutate(mutation)`, and what it created.
 *
 * ONE write through the facade in every lane. A refusal answers
 * `outcome.applied === false` and an empty list; nothing is retried here
 * (the flows own their fallbacks).
 */
export async function mutateMinting(
  host: BundleHost,
  mutation: MutationInput,
): Promise<Minting> {
  const known = lanes.get(host);
  if (known === "diff") return mutateDiffing(host, mutation);

  // A host that has answered through its outcome needs no listener.
  const tap = known === "outcome" ? null : tapReplies(host);
  if (!tap && known !== "outcome") {
    // No hatch, and nothing has shown that the outcome carries the list:
    // read the "before" up front. If the outcome does carry it, that is
    // learned here and this read is not paid again.
    const before = await readNodes(host);
    const outcome = await host.document.mutate(mutation);
    if (!outcome.applied) return { outcome, minted: [], lane: "diff" };
    const told = parseMinted((outcome as { minted?: unknown }).minted);
    const minted = told && settle(told, outcome);
    if (minted) {
      lanes.set(host, "outcome");
      return { outcome, minted, lane: "outcome" };
    }
    lanes.set(host, "diff");
    return { outcome, minted: added(before, await readNodes(host)), lane: "diff" };
  }

  const outcome = await host.document.mutate(mutation);
  const heard = tap ? tap.stop() : null;
  if (!outcome.applied) {
    return { outcome, minted: [], lane: known ?? "reply" };
  }
  const told = parseMinted((outcome as { minted?: unknown }).minted);
  const fromOutcome = told && settle(told, outcome);
  if (fromOutcome) {
    lanes.set(host, "outcome");
    return { outcome, minted: fromOutcome, lane: "outcome" };
  }
  const fromReply = heard && settle(heard, outcome);
  if (fromReply) {
    lanes.set(host, "reply");
    return { outcome, minted: fromReply, lane: "reply" };
  }
  lanes.set(host, "diff");
  return recover(host, mutation, outcome);
}

// ------------------------------------------------------------- binding

/** What a flow gets back for the batch it sent. */
export interface MintedBinding {
  /** `bindCreated` handle → the element it named. A handle the batch
   *  itself deleted or dissolved again is present in the "outcome" and
   *  "reply" lanes and ABSENT in the "diff" lane — a flow has no use for
   *  the id of something that no longer exists, so none reads it. */
  byHandle: ReadonlyMap<string, ElementId>;
  /** Every group a `createGroup` child made, in the order the batch
   *  made them. */
  groups: readonly ElementId[];
}

interface Creation {
  handle: string | null;
  group: boolean;
  /** Removed again by the same batch — minted, and gone. */
  transient: boolean;
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
  const named = new Map<string, Creation>();
  const handleIn = (v: unknown): string | null =>
    typeof v === "string" && v.startsWith(HANDLE_PREFIX)
      ? v.slice(HANDLE_PREFIX.length)
      : null;
  let previous: string | null = null;
  for (const op of ops) {
    const args = (op.args ?? {}) as Record<string, unknown>;
    if (op.op === "bindCreated") {
      const handle = String(args.handle);
      // A bind names the creating child before it. After a `createGroup`
      // (or another bind) that child is already on the list.
      let creation = out[out.length - 1];
      if (!creation || (previous !== "createGroup" && previous !== "bindCreated")) {
        creation = { handle, group: false, transient: false };
        out.push(creation);
      } else if (creation.handle === null) {
        creation.handle = handle;
      }
      named.set(handle, creation);
    } else if (op.op === "createGroup") {
      out.push({ handle: null, group: true, transient: false });
    } else if (op.op === "deleteFrame" || op.op === "dissolveGroup") {
      const handle = handleIn(args.frameId ?? args.groupId);
      const creation = handle === null ? undefined : named.get(handle);
      if (creation) creation.transient = true;
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
  const byHandle = new Map<string, ElementId>();
  const groups: ElementId[] = [];
  const take = (creation: Creation, minted: MintedElement): boolean => {
    if (creation.group !== (minted.element.kind === "group")) return false;
    if (
      minted.handle !== null &&
      creation.handle !== null &&
      minted.handle !== creation.handle
    ) {
      return false;
    }
    if (creation.group) groups.push(minted.element);
    if (creation.handle !== null) byHandle.set(creation.handle, minted.element);
    return true;
  };

  if (minting.lane !== "diff") {
    if (minting.minted.length !== creations.length) return null;
    for (let i = 0; i < creations.length; i++) {
      if (!take(creations[i]!, minting.minted[i]!)) return null;
    }
    return { byHandle, groups };
  }

  // The diff lane lists what SURVIVED, leaves before groups.
  const alive = creations.filter((c) => !c.transient);
  const expected = [
    ...alive.filter((c) => !c.group),
    ...alive.filter((c) => c.group),
  ];
  if (minting.minted.length !== expected.length) return null;
  for (let i = 0; i < expected.length; i++) {
    if (!take(expected[i]!, minting.minted[i]!)) return null;
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

/** Which lane `host` answered through last, if it has answered. */
export const mintLaneOf = (host: BundleHost): MintLane | undefined =>
  lanes.get(host);
