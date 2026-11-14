/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// `paged.pathfinder.*` — the ten Pathfinder verbs as host commands.
//
// WHY THIS LIVES IN THE EDITOR AND NOT IN A PLUGIN. Pathfinder is a wire op
// (`pathfinderBoolean`, `pathfinderDivide` ... `pathfinderMinusBack`), not a
// vector-plugin feature, and the Pathfinder panel is the host's. The verbs
// were reachable only as panel buttons here, while paged.draw carried the
// commands, the menu and the palette rows for the same ops (two
// implementations; PM-0017). This file is the one implementation: the
// panel's buttons call `runShapeMode` / `runRegionVerb`, and the commands
// below call the same two functions.
//
//  1. SHAPE MODES (Unite / Subtract / Intersect / Exclude) take the FIRST
//     selected object as the kept target: it receives the result, the rest
//     are consumed. One `pathfinderBoolean`, one undo step.
//  2. THE REGION VERBS (Divide / Trim / Merge / Crop / Outline / Minus
//     back) take `elementIds` TOP-TO-BOTTOM, index 0 frontmost. Selection
//     order is CLICK order, not stacking order, so the real z is read from
//     the scene tree (leaves come back in paint order, back to front) and
//     reversed. A selection made bottom-up would otherwise invert Crop's
//     cookie cutter and Minus back's survivor. An unreadable tree leaves
//     click order in place rather than aborting.
//  3. THE ENGINE'S REFUSAL IS SHOWN, in words: the arrangement is capped at
//     1000 inputs and 100 000 faces behind a work budget, and refused past
//     any of them, never truncated. Both functions answer the sentence (or
//     null); the panel puts it in its status line, the commands in the
//     Problems panel.
//  4. AFTER A SUCCESS the shape modes leave the kept object selected; the
//     region verbs clear the selection.

import type {
  CommandContribution,
  MenuItemContribution,
} from "@paged-media/shell";
import { commandNeeds } from "@paged-media/shell";
import type {
  CanvasClient,
  ElementId,
  Mutation,
  PathfinderKind,
  SceneTreeNode,
  WorkerToMain,
} from "@paged-media/client";
import { refusalText } from "@paged-media/panel-kit";
import { defineMessages, t } from "@paged-media/strings";

import { objectVerbApplies } from "./object-commands";

/** The six region verbs' wire op names: the `Mutation` variants that take a
 *  bare `{ elementIds }`. */
export type PathfinderRegionVerb =
  | "pathfinderDivide"
  | "pathfinderTrim"
  | "pathfinderMerge"
  | "pathfinderCrop"
  | "pathfinderOutline"
  | "pathfinderMinusBack";

const M = defineMessages("app.pathfinderCommands", {
  unite: "Pathfinder: Unite",
  subtract: "Pathfinder: Subtract",
  intersect: "Pathfinder: Intersect",
  exclude: "Pathfinder: Exclude overlap",
  divide: "Pathfinder: Divide",
  trim: "Pathfinder: Trim",
  merge: "Pathfinder: Merge",
  crop: "Pathfinder: Crop",
  outline: "Pathfinder: Outline",
  minusBack: "Pathfinder: Minus back",
});

// The menu leaves (`menu.<label>`).
defineMessages("menu", {
  Unite: "Unite",
  Subtract: "Subtract",
  Intersect: "Intersect",
  Exclude: "Exclude",
  Divide: "Divide",
  Trim: "Trim",
  Merge: "Merge",
  Crop: "Crop",
  Outline: "Outline",
  "Minus back": "Minus back",
});

export const PAGED_PATHFINDER_UNITE = "paged.pathfinder.unite";
export const PAGED_PATHFINDER_SUBTRACT = "paged.pathfinder.subtract";
export const PAGED_PATHFINDER_INTERSECT = "paged.pathfinder.intersect";
export const PAGED_PATHFINDER_EXCLUDE = "paged.pathfinder.exclude";
export const PAGED_PATHFINDER_DIVIDE = "paged.pathfinder.divide";
export const PAGED_PATHFINDER_TRIM = "paged.pathfinder.trim";
export const PAGED_PATHFINDER_MERGE = "paged.pathfinder.merge";
export const PAGED_PATHFINDER_CROP = "paged.pathfinder.crop";
export const PAGED_PATHFINDER_OUTLINE = "paged.pathfinder.outline";
export const PAGED_PATHFINDER_MINUS_BACK = "paged.pathfinder.minusBack";

/** The Problems panel's source id for these commands. */
export const PATHFINDER_DIAGNOSTIC_SOURCE = "paged.pathfinder";

type Key = { kind: string; id: unknown };

const keyOf = (id: ElementId): string => {
  const k = id as unknown as Key;
  return `${k.kind}:${String(k.id)}`;
};

/** Flatten the scene tree to its selectable leaves in PAINT order (back to
 *  front, the order `frames_in_order` records). */
function paintOrder(roots: readonly SceneTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: readonly SceneTreeNode[]) => {
    for (const node of nodes) {
      if (node.id) out.push(keyOf(node.id));
      if (node.children) walk(node.children);
    }
  };
  walk(roots);
  return out;
}

/** The selection ordered TOP-TO-BOTTOM (index 0 frontmost). Ids the tree
 *  does not carry keep their relative selection order at the back: a
 *  partial answer still runs rather than dropping operands. */
export function topToBottom(
  selection: readonly ElementId[],
  paint: readonly string[],
): ElementId[] {
  const rank = new Map<string, number>();
  paint.forEach((k, i) => rank.set(k, i));
  return selection
    .map((id, i) => ({ id, i, z: rank.get(keyOf(id)) ?? -1 }))
    .sort((a, b) => (a.z !== b.z ? b.z - a.z : a.i - b.i))
    .map((e) => e.id);
}

/** The engine's reason for a refused mutation, in words, or null when it
 *  applied. An apply-layer refusal arrives as `mutationFailed`; the user
 *  gets the reason, not the envelope. */
function refusalOf(reply: WorkerToMain, subject: string): string | null {
  if (reply.kind !== "mutationFailed") return null;
  return refusalText(reply.payload.error, subject);
}

/** What a run needs of the app: the client and the live selection. */
export interface PathfinderDeps {
  client: Pick<CanvasClient, "mutate" | "sceneTree">;
  getSelection: () => readonly ElementId[];
  /** Replace the selection (worker first, then the mirror). */
  setSelection: (ids: ElementId[]) => Promise<void>;
}

/** One shape mode over the selection (first = kept). Answers the engine's
 *  refusal in words, or null. Fewer than two selected: nothing sent. */
export async function runShapeMode(
  deps: PathfinderDeps,
  kind: PathfinderKind,
  label: string,
): Promise<string | null> {
  const [kept, ...others] = deps.getSelection();
  if (!kept || others.length === 0) return null;
  const reply = await deps.client.mutate({
    op: "pathfinderBoolean",
    args: { kept, others, kind },
  });
  const refusal = refusalOf(reply, label);
  // The kept object holds the result: it stays selected.
  if (refusal === null) await deps.setSelection([kept]);
  return refusal;
}

/** One region verb over the selection, ordered by real z. */
export async function runRegionVerb(
  deps: PathfinderDeps,
  verb: PathfinderRegionVerb,
  label: string,
): Promise<string | null> {
  const selection = deps.getSelection();
  if (selection.length < 2) return null;
  let ordered = [...selection];
  try {
    ordered = topToBottom(selection, paintOrder(await deps.client.sceneTree()));
  } catch {
    // An unreadable tree leaves click order in place.
  }
  const reply = await deps.client.mutate({
    op: verb,
    args: { elementIds: ordered },
  } as Mutation);
  const refusal = refusalOf(reply, label);
  // The verbs consume, replace and mint objects; naming a survivor would be
  // a guess, so the selection is cleared rather than left on ids that may
  // no longer exist.
  if (refusal === null) await deps.setSelection([]);
  return refusal;
}

interface Verb {
  id: string;
  title: string;
  menu: string;
  label: string;
  run: (deps: PathfinderDeps, label: string) => Promise<string | null>;
}

const shape = (kind: PathfinderKind) => (deps: PathfinderDeps, label: string) =>
  runShapeMode(deps, kind, label);
const region =
  (verb: PathfinderRegionVerb) => (deps: PathfinderDeps, label: string) =>
    runRegionVerb(deps, verb, label);

/** The ten verbs, in Illustrator's own order. */
const VERBS: readonly Verb[] = [
  {
    id: PAGED_PATHFINDER_UNITE,
    title: M.unite,
    menu: "Unite",
    label: "Unite",
    run: shape("union"),
  },
  {
    id: PAGED_PATHFINDER_SUBTRACT,
    title: M.subtract,
    menu: "Subtract",
    label: "Subtract",
    run: shape("subtract"),
  },
  {
    id: PAGED_PATHFINDER_INTERSECT,
    title: M.intersect,
    menu: "Intersect",
    label: "Intersect",
    run: shape("intersect"),
  },
  {
    id: PAGED_PATHFINDER_EXCLUDE,
    title: M.exclude,
    menu: "Exclude",
    label: "Exclude",
    run: shape("exclude"),
  },
  {
    id: PAGED_PATHFINDER_DIVIDE,
    title: M.divide,
    menu: "Divide",
    label: "Divide",
    run: region("pathfinderDivide"),
  },
  {
    id: PAGED_PATHFINDER_TRIM,
    title: M.trim,
    menu: "Trim",
    label: "Trim",
    run: region("pathfinderTrim"),
  },
  {
    id: PAGED_PATHFINDER_MERGE,
    title: M.merge,
    menu: "Merge",
    label: "Merge",
    run: region("pathfinderMerge"),
  },
  {
    id: PAGED_PATHFINDER_CROP,
    title: M.crop,
    menu: "Crop",
    label: "Crop",
    run: region("pathfinderCrop"),
  },
  {
    id: PAGED_PATHFINDER_OUTLINE,
    title: M.outline,
    menu: "Outline",
    label: "Outline",
    run: region("pathfinderOutline"),
  },
  {
    id: PAGED_PATHFINDER_MINUS_BACK,
    title: M.minusBack,
    menu: "Minus back",
    label: "Minus back",
    run: region("pathfinderMinusBack"),
  },
];

/** The ten commands. `deps` reads the live app; `report` lands a refusal in
 *  the Problems panel. Each run starts from a clean slate (`clear`). */
export function buildPathfinderCommands(
  deps: PathfinderDeps,
  report: (message: string) => void,
  clear: () => void,
): CommandContribution[] {
  return VERBS.map((v) => ({
    id: v.id,
    title: t(v.title),
    category: "Pathfinder",
    when: objectVerbApplies,
    applicability: commandNeeds("outsideContext", "noText", "noPathEdit"),
    handler: async () => {
      clear();
      const refusal = await v.run(deps, v.label);
      if (refusal) report(refusal);
    },
  }));
}

/** Object > Pathfinder > <verb>, ahead of "Keep or remove faces…". */
export const PATHFINDER_MENU_ITEMS: MenuItemContribution[] = VERBS.map(
  (v, i) => ({
    path: `Object/Pathfinder/${v.menu}`,
    command: v.id,
    order: 66 + (i + 1) / 100,
    group: "path",
    when: objectVerbApplies,
    applicability: commandNeeds("outsideContext", "noText", "noPathEdit"),
  }),
);
