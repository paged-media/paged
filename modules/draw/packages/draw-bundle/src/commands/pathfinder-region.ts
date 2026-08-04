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

// The REGION Pathfinder row — Divide / Trim / Merge / Crop / Outline /
// Minus Back (engine protocol v57, B-22). Where the four Shape Modes in
// `pathfinder.ts` combine the selection into ONE path, these six resolve
// the planar ARRANGEMENT of the inputs — the distinct areas overlapping
// paths divide the plane into — and operate per face. Each is one wire
// op over one payload (`elementIds`) and one undo step.
//
// ORDERING — the thing that decides Crop and Minus Back:
// `elementIds` is TOP-TO-BOTTOM, index 0 frontmost. That is the
// convention `pathfinderBoolean`'s `kept`-is-top already sets, and
// `pathfinder.ts` reaches it the cheap way: the user's FIRST click is
// the kept target, so selection order IS the answer there. It is NOT
// the answer here. These verbs have no user-named target — Crop treats
// the topmost object as a cookie cutter and Minus Back keeps what only
// the BACKMOST object covers, so a selection made bottom-up would
// silently invert both. So the real stacking order is read from the
// scene tree (`host.document.tree()`), whose leaves come back in paint
// order (back to front — IDML XML order, which is what the renderer
// draws); reversing it gives top-to-bottom. Ids the tree does not carry
// keep their selection-relative order at the back, so a partial answer
// still runs rather than dropping operands.
//
// REFUSALS ARE SURFACED, NOT SWALLOWED: the engine caps the arrangement
// at 12 inputs and 256 faces and REFUSES past either — it never
// truncates. A refusal comes back as a non-applied `MutationOutcome`
// whose error carries the engine's own sentence ("planar arrangement
// takes at most 12 inputs (got 13)"); `regionRefusalReason` extracts it
// so a caller can put it in front of the user instead of showing an
// empty result. The command lane logs it at WARN and publishes it on
// the `media.paged.draw.pathfinderStatus` binding.
//
// WIRE-TYPE NOTE (skew, named — the join-average.ts precedent): the six
// ops are protocol v57 and the INSTALLED `@paged-media/plugin-api`
// (0.2.25-canary.0) vendors protocol 51, so its curated `Mutation`
// union does not carry them yet. The builder below emits the EXACT v57
// wire shape and casts once, here, at the boundary; when the contract
// catches up the cast is the only thing to delete.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  SceneTreeNode,
} from "@paged-media/plugin-api";

export const PATHFINDER_REGION_COMMAND_CATEGORY = "Pathfinder";

/** The binding a refusal (or the last success) is published on, so a
 *  schema panel can show the engine's own words. */
export const BIND_PATHFINDER_STATUS = "media.paged.draw.pathfinderStatus";

/** The six region verbs, as their wire op names. */
export type PathfinderRegionVerb =
  | "pathfinderDivide"
  | "pathfinderTrim"
  | "pathfinderMerge"
  | "pathfinderCrop"
  | "pathfinderOutline"
  | "pathfinderMinusBack";

export interface PathfinderRegionPreset {
  /** The namespaced command id (under the manifest id). */
  id: string;
  title: string;
  /** The wire op this preset commits. */
  verb: PathfinderRegionVerb;
}

/** The six region-pathfinder commands, in registration order. */
export const PATHFINDER_REGION_PRESETS: readonly PathfinderRegionPreset[] = [
  {
    id: "media.paged.draw.command.pathfinderDivide",
    title: "Pathfinder: Divide",
    verb: "pathfinderDivide",
  },
  {
    id: "media.paged.draw.command.pathfinderTrim",
    title: "Pathfinder: Trim",
    verb: "pathfinderTrim",
  },
  {
    id: "media.paged.draw.command.pathfinderMerge",
    title: "Pathfinder: Merge",
    verb: "pathfinderMerge",
  },
  {
    id: "media.paged.draw.command.pathfinderCrop",
    title: "Pathfinder: Crop",
    verb: "pathfinderCrop",
  },
  {
    id: "media.paged.draw.command.pathfinderOutline",
    title: "Pathfinder: Outline",
    verb: "pathfinderOutline",
  },
  {
    id: "media.paged.draw.command.pathfinderMinusBack",
    title: "Pathfinder: Minus back",
    verb: "pathfinderMinusBack",
  },
] as const;

/** The contributed command ids, in registration order. */
export const PATHFINDER_REGION_COMMAND_IDS = PATHFINDER_REGION_PRESETS.map(
  (p) => p.id,
);

/** The `<verb>{ elementIds }` mutation one preset commits. `elementIds`
 *  MUST already be top-to-bottom (see the module header). Exported so
 *  the conformance spec asserts the EXACT wire shape the live command
 *  emits (no second copy to drift from). */
export function pathfinderRegionMutationFor(
  verb: PathfinderRegionVerb,
  elementIds: ElementId[],
): Mutation {
  return { op: verb, args: { elementIds } } as unknown as Mutation;
}

/** `pathfinderFaces { elementIds, faces, mode }` — Shape Builder's
 *  click/drag output. Here rather than in the handler because it is the
 *  same v57 wire family and the same one-cast boundary. */
export function pathfinderFacesMutationFor(
  elementIds: ElementId[],
  faces: string[],
  mode: "keep" | "remove",
): Mutation {
  return {
    op: "pathfinderFaces",
    args: { elementIds, faces, mode },
  } as unknown as Mutation;
}

/** Key an ElementId for order lookups (`kind` + `id`; the string-id
 *  page-item kinds are the only ones a pathfinder accepts). */
function keyOf(id: ElementId): string {
  return `${id.kind}:${String((id as { id: unknown }).id)}`;
}

/** Flatten the scene tree to its leaf ids in PAINT order (back to
 *  front) — the order `frames_in_order` records and the renderer
 *  honours. Group children come in the group's slot, which is the
 *  stacking answer for a group's members too. */
export function paintOrderLeaves(roots: readonly SceneTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: readonly SceneTreeNode[]) => {
    for (const node of nodes) {
      if (node.id) out.push(keyOf(node.id as ElementId));
      if (node.children) walk(node.children);
    }
  };
  walk(roots);
  return out;
}

/** Order `selection` TOP-TO-BOTTOM (index 0 frontmost) using the paint
 *  order the scene tree reports. Ids absent from the tree keep their
 *  relative selection order and sort to the BACK — a partial answer
 *  still runs; it never drops an operand. Pure, so the conformance spec
 *  pins the ordering rule without a document. */
export function orderTopToBottom(
  selection: readonly ElementId[],
  paintOrder: readonly string[],
): ElementId[] {
  const rank = new Map<string, number>();
  paintOrder.forEach((key, i) => rank.set(key, i));
  return selection
    .map((id, i) => ({ id, i, z: rank.get(keyOf(id)) ?? -1 }))
    .sort((a, b) => (a.z !== b.z ? b.z - a.z : a.i - b.i))
    .map((e) => e.id);
}

/** The selection, ordered top-to-bottom against the live scene tree.
 *  A tree read that fails leaves selection order untouched (and says so
 *  at debug) rather than aborting the command. */
export async function selectionTopToBottom(
  host: BundleHost,
): Promise<ElementId[]> {
  const selection = host.selection.get();
  try {
    const roots = await host.document.tree();
    return orderTopToBottom(selection, paintOrderLeaves(roots));
  } catch {
    host.log.debug(
      "pathfinder region: the scene tree is unreadable — falling back to " +
        "selection order (Crop / Minus back may pick the wrong operand)",
    );
    return [...selection];
  }
}

/** The engine's own sentence for a refused region op, or null when the
 *  error carries no readable text. The engine answers a cap breach with
 *  `WorkerError::NotImplemented { what: "frame mutation failed: … " }`;
 *  we hand the user the trailing clause, not the envelope. */
export function regionRefusalReason(error: unknown): string | null {
  let text: string;
  try {
    text = typeof error === "string" ? error : (JSON.stringify(error) ?? "");
  } catch {
    return null;
  }
  if (!text) return null;
  const what = /"what"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  const raw = what ? what[1].replace(/\\"/g, '"') : text;
  // Strip the two envelopes the apply layer wraps a reason in:
  // "frame mutation failed: invalid value for FramePath on X: <reason>".
  const tail = /:\s*([^:]*(?:planar|face)[^"]*)$/.exec(raw);
  return (tail ? tail[1] : raw).trim() || null;
}

/** Apply one region preset over the selection, top-to-bottom. Fewer
 *  than two selected ⇒ an honest no-op (debug log, never a throw); a
 *  refusal ⇒ the engine's reason at WARN + on the status binding. */
export async function applyPathfinderRegion(
  host: BundleHost,
  preset: PathfinderRegionPreset,
): Promise<void> {
  const selection = host.selection.get();
  if (selection.length < 2) {
    host.log.debug(
      `${preset.id}: needs ≥ 2 selected elements (have ${selection.length}) — no-op`,
    );
    return;
  }
  const ordered = await selectionTopToBottom(host);
  const outcome = await host.document.mutate(
    pathfinderRegionMutationFor(preset.verb, ordered),
  );
  if (!outcome.applied) {
    const reason =
      regionRefusalReason(outcome.error) ?? "the engine refused the operation";
    host.log.warn(`${preset.id} refused: ${reason}`);
    host.bindings.publish(BIND_PATHFINDER_STATUS, reason);
    return;
  }
  host.bindings.publish(BIND_PATHFINDER_STATUS, null);
  // The verbs consume, replace and mint elements; naming a survivor
  // would be a guess, so the selection is cleared rather than left
  // pointing at ids that may no longer exist.
  await host.selection.set([]);
}

/** Register the six region-pathfinder commands. */
export function contributePathfinderRegionCommands(
  host: BundleHost,
): Disposable {
  const disposers = PATHFINDER_REGION_PRESETS.map((preset) =>
    host.contribute.command({
      id: preset.id,
      title: preset.title,
      category: PATHFINDER_REGION_COMMAND_CATEGORY,
      handler: () => applyPathfinderRegion(host, preset),
    }),
  );
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
