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

// UPDATE LINKED RECIPES (plan G4) — rebuild the recipes built from a
// changed source, without the caller having to know which they are.
//
// No construct updates itself: editing a pattern's tile, a repeat's
// source, a blend's key, a live-paint input or the objects on a path
// leaves the generated artwork as it was until that recipe's own update
// command runs. In the editor the recipe's panel holds that button; a
// script or the CLI that just rewrote a path would have to find, by
// itself, every recipe the path feeds. This command does the finding:
//
//   updateLinkedRecipes { all: false }   the recipes whose SOURCES are
//                                        selected (the twin selects its
//                                        `targets` first)
//   updateLinkedRecipes { all: true }    every recipe in the document
//
// and runs, for each, the update its own panel runs (`updateRepeat`,
// `updateBlend`, `editPatternField`, `updateObjectsOnPath`,
// `regenerateLivePaint`). It answers the addresses of the recipes it
// rebuilt. A source is what the recipe is made FROM — a repeat's or a
// pattern's source items, a blend's keys and spine, the objects and the
// path of an objects-on-path, a live-paint group's inputs — read off the
// links the make wrote, so a generated instance or step selects nothing.
//
// Each rebuild keeps its own undo steps (an update mints new ids, see
// `object-model/recipe-kinds.ts`). A recipe whose update refuses is left
// out of the answer; when nothing was rebuilt a caller with a payload (the
// typed twin, a script) gets `failed: <why>`, and a bare run (the menu
// row, the palette) says why in the log and changes nothing, as the
// other Update rows do.
//
// THE SAME REBUILD ON ITS OWN. Where the host can amend an undo step
// (engine ADR 1004), `recipe-auto-update.ts` runs `updateRecipe` for the
// recipes an edit changed the sources of, inside that edit's step. This
// command stays for a host without it, for a script's edits (which carry
// no step to join) and for a rebuild that lost the race to the next edit.

import type {
  BundleHost,
  Disposable,
  ElementId,
} from "@paged-media/plugin-api";

import {
  applyUpdateBlend,
  blendKeyOf,
  blendSpineOf,
  readBlendLibrary,
} from "./blend";
import {
  applyRegenerateLivePaint,
  livePaintMemberOf,
  readLivePaintLibrary,
} from "./live-paint";
import {
  applyUpdateObjectsOnPath,
  onPathObjectOf,
  onPathSpineOf,
  readObjectsOnPathLibrary,
} from "./objects-on-path";
import {
  applyEditPattern,
  patternSourceOf,
  readPatternLibrary,
} from "./pattern";
import { applyUpdateRepeat, readRepeatLibrary, repeatSourceOf } from "./repeat";
import { registerCommand } from "../command-registry";
import { linkIndex } from "../link-index";
import { addressOf } from "../object-model/shared";
import { defineMessages } from "@paged-media/strings";

/** The command title, a message key `registerCommand` reads in the editor's locale. */
const M = defineMessages("draw.recipeUpdate", {
  command: "Update the recipes built from the selection",
});

export const UPDATE_LINKED_RECIPES_COMMAND_ID =
  "media.paged.draw.command.updateLinkedRecipes";
export const RECIPE_UPDATE_COMMAND_CATEGORY = "Object";
export const RECIPE_UPDATE_COMMAND_IDS = [
  UPDATE_LINKED_RECIPES_COMMAND_ID,
] as const;

/** The five generator recipes, by their object-model kind. */
export const RECIPE_KINDS = [
  "pattern",
  "repeat",
  "blend",
  "objectsOnPath",
  "livePaint",
] as const;
export type RecipeKind = (typeof RECIPE_KINDS)[number];

/** One recipe: its kind and library-local id. */
export interface RecipeRef {
  kind: RecipeKind;
  id: string;
}

const failed = (why: string): never => {
  throw new Error(`failed: ${why}`);
};

/** The recipes an element is a SOURCE of, read off its envelope. Pure. */
export function recipesSourcedBy(
  envelope: Parameters<typeof repeatSourceOf>[0],
): RecipeRef[] {
  const out: RecipeRef[] = [];
  const pattern = patternSourceOf(envelope)?.pattern;
  if (pattern) out.push({ kind: "pattern", id: pattern });
  const repeat = repeatSourceOf(envelope)?.repeat;
  if (repeat) out.push({ kind: "repeat", id: repeat });
  const blend =
    blendKeyOf(envelope)?.blend ?? blendSpineOf(envelope)?.blend ?? null;
  if (blend) out.push({ kind: "blend", id: blend });
  const onPath =
    onPathObjectOf(envelope)?.onPath ?? onPathSpineOf(envelope)?.onPath ?? null;
  if (onPath) out.push({ kind: "objectsOnPath", id: onPath });
  const group = livePaintMemberOf(envelope)?.group;
  if (group) out.push({ kind: "livePaint", id: group });
  return out;
}

/** The recipes the given elements are sources of, each once, in
 *  {@link RECIPE_KINDS} order. */
export async function recipesOfSources(
  host: BundleHost,
  ids: readonly ElementId[],
): Promise<RecipeRef[]> {
  const index = linkIndex(host);
  const seen = new Set<string>();
  const found: RecipeRef[] = [];
  for (const id of ids) {
    const envelope = await index.envelopeOf(id).catch(() => null);
    for (const r of recipesSourcedBy(envelope)) {
      const key = `${r.kind}/${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(r);
    }
  }
  return found.sort(
    (a, b) => RECIPE_KINDS.indexOf(a.kind) - RECIPE_KINDS.indexOf(b.kind),
  );
}

/** Every recipe the document stores, in {@link RECIPE_KINDS} order. */
export async function allRecipes(host: BundleHost): Promise<RecipeRef[]> {
  const [patterns, repeats, blends, onPaths, livePaints] = await Promise.all([
    readPatternLibrary(host),
    readRepeatLibrary(host),
    readBlendLibrary(host),
    readObjectsOnPathLibrary(host),
    readLivePaintLibrary(host),
  ]);
  return [
    ...patterns.fields.map((r) => ({ kind: "pattern" as const, id: r.id })),
    ...repeats.repeats.map((r) => ({ kind: "repeat" as const, id: r.id })),
    ...blends.blends.map((r) => ({ kind: "blend" as const, id: r.id })),
    ...onPaths.associations.map((r) => ({
      kind: "objectsOnPath" as const,
      id: r.id,
    })),
    ...livePaints.groups.map((r) => ({ kind: "livePaint" as const, id: r.id })),
  ];
}

/** Run one recipe's own update. Answers whether it rebuilt anything. */
export async function updateRecipe(
  host: BundleHost,
  recipe: RecipeRef,
): Promise<boolean> {
  switch (recipe.kind) {
    case "pattern":
      return (
        (await applyEditPattern(host, { patternId: recipe.id })).length > 0
      );
    case "repeat":
      return (
        (await applyUpdateRepeat(host, { repeatId: recipe.id })).length > 0
      );
    case "blend":
      return (await applyUpdateBlend(host, { blendId: recipe.id })).length > 0;
    case "objectsOnPath":
      return (
        (await applyUpdateObjectsOnPath(host, { onPathId: recipe.id })).length >
        0
      );
    case "livePaint": {
      const r = await applyRegenerateLivePaint(host, { groupId: recipe.id });
      return r.rebuilt > 0 || r.dropped.length > 0;
    }
  }
}

/** Rebuild the recipes the selection is a source of (or, with `all`,
 *  every recipe). Answers the addresses of the recipes rebuilt. */
export async function applyUpdateLinkedRecipes(
  host: BundleHost,
  payload: unknown,
): Promise<string[]> {
  const all =
    !!payload &&
    typeof payload === "object" &&
    (payload as { all?: unknown }).all === true;
  const recipes = all
    ? await allRecipes(host)
    : await recipesOfSources(host, host.selection.get());
  if (recipes.length === 0)
    failed(
      all
        ? "the document has no pattern, repeat, blend, objects on a path or live paint"
        : "nothing selected is the source of a recipe",
    );
  const updated: string[] = [];
  for (const recipe of recipes)
    if (await updateRecipe(host, recipe))
      updated.push(addressOf(recipe.kind, recipe.id));
  if (updated.length === 0)
    failed(
      `every update was refused (${recipes
        .map((r) => addressOf(r.kind, r.id))
        .join(", ")}); the log says why`,
    );
  return updated;
}

export function contributeRecipeUpdateCommands(host: BundleHost): Disposable {
  return registerCommand(host, {
    id: UPDATE_LINKED_RECIPES_COMMAND_ID,
    title: M.command,
    category: RECIPE_UPDATE_COMMAND_CATEGORY,
    handler: async (_paged, payload) => {
      if (payload !== undefined) return applyUpdateLinkedRecipes(host, payload);
      try {
        return await applyUpdateLinkedRecipes(host, payload);
      } catch (e) {
        host.log.info(`${UPDATE_LINKED_RECIPES_COMMAND_ID}: ${String(e)}`);
        return [];
      }
    },
  });
}
