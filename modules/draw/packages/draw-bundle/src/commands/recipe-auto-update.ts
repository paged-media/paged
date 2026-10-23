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

// THE AUTOMATIC RECIPE UPDATE (plan G4) — when an edit changes a source of
// a pattern, repeat, blend, objects-on-path or live-paint recipe, the
// recipe is rebuilt as part of THAT edit's undo step.
//
// The engine reports a change only after it committed, so a rebuild on
// the event used to be a second undo step: it cleared the redo stack, and
// undoing the edit left the rebuilt artwork behind (whose own undo was the
// next step). Engine ADR 1004 closes that: `mutate(…, { amend })` applies
// a write INTO the step the change names. The rebuild here sends every one
// of its mutations that way, so
//
//   · one undo reverts the edit and the rebuild, one redo replays both;
//   · an undo or a redo is never followed by a rebuild — it already
//     restored the instances together with their sources (the change's
//     `kind` says which it was, and only `mutationApplied` /
//     `gestureCommitted` carry an `appliedSeq` to amend);
//   · the rebuild's own commits never start another (they are recognised
//     by the seqs the amends answered, and a rebuild leaves the sources as
//     they were);
//   · when the step is no longer the last one by the time the rebuild
//     writes (the user did something else meanwhile), the engine refuses
//     the amend, nothing is applied, and the log says to run the update
//     by hand — a rebuild is never attached to an unrelated step.
//
// WHICH RECIPES. The event names pages, not elements, so the update keeps
// a fingerprint of every recipe's sources (their path anchors and property
// tables) and rebuilds the recipes whose fingerprint moved. A recipe seen
// for the first time is only fingerprinted. After every rebuild, undo and
// redo the fingerprints are taken again.
//
// WHEN. On the commit, never on a pointer move: a drag reports one
// `gestureCommitted`, not its updates. A burst of commits (a command that
// writes twice) is handled once, against the last of them.
//
// The update needs `supports("document.mutate.amend@1")`; without it
// nothing is automatic and `updateLinkedRecipes` stays the way to rebuild.
// It is on by default; the bundle's storage key `recipes.autoUpdate` set
// to `false` turns it off (`setRecipeAutoUpdate`).

import type {
  BundleHost,
  DocumentChangeEvent,
  Disposable,
  ElementId,
  MutateOptions,
  MutationInput,
  MutationOutcome,
} from "@paged-media/plugin-api";

import {
  RECIPE_KINDS,
  allRecipes,
  recipesSourcedBy,
  updateRecipe,
  type RecipeRef,
} from "./recipe-update";
import { linkIndex, shareLinkIndex } from "../link-index";
import { addressOf } from "../object-model/shared";

/** The host feature the automatic update rides on (engine ADR 1004). */
export const RECIPE_AUTO_UPDATE_FEATURE = "document.mutate.amend@1";

/** The bundle storage key that turns the automatic update off (`false`). */
export const RECIPE_AUTO_UPDATE_KEY = "recipes.autoUpdate";

/** Is the automatic update on for this host (the default)? */
export function recipeAutoUpdateEnabled(host: BundleHost): boolean {
  try {
    return host.storage.get<boolean>(RECIPE_AUTO_UPDATE_KEY) !== false;
  } catch {
    return true;
  }
}

/** Turn the automatic update on or off (kept in the bundle's storage). */
export function setRecipeAutoUpdate(host: BundleHost, on: boolean): void {
  if (on) host.storage.delete(RECIPE_AUTO_UPDATE_KEY);
  else host.storage.set(RECIPE_AUTO_UPDATE_KEY, false);
}

/** What `contributeRecipeAutoUpdate` hands back. */
export interface RecipeAutoUpdate extends Disposable {
  /** Resolves once every change reported so far has been handled. */
  idle(): Promise<void>;
  /** The recipes the last automatic update rebuilt (addresses). */
  lastRebuilt(): readonly string[];
}

const handles = new WeakMap<object, RecipeAutoUpdate>();

/** The automatic update running for `host` (a test awaits its `idle`). */
export function recipeAutoUpdateOf(
  host: BundleHost,
): RecipeAutoUpdate | undefined {
  return handles.get(host);
}

/** A change to handle: a committed change, a recipe written (`baseline`:
 *  fingerprint the recipes not seen yet), or a document opened (`open`:
 *  forget every fingerprint and take them afresh). */
type Pending = DocumentChangeEvent | "baseline" | "open";

const keyOf = (r: RecipeRef): string => `${r.kind}/${r.id}`;

const NOT_AMENDABLE = "notAmendable";

/** Is a refused outcome's error the engine's `notAmendable`? (It is the
 *  `mutationFailed` payload, `{ error: { kind, details } }`.) */
const isNotAmendable = (error: unknown): boolean => {
  const inner =
    error && typeof error === "object"
      ? ((error as { error?: unknown }).error ?? error)
      : null;
  return (
    !!inner &&
    typeof inner === "object" &&
    (inner as { kind?: unknown }).kind === NOT_AMENDABLE
  );
};

/** Every recipe's source ids, read off the links (one walk per revision). */
async function sourcesByRecipe(
  host: BundleHost,
): Promise<Map<string, { recipe: RecipeRef; sources: ElementId[] }>> {
  const out = new Map<string, { recipe: RecipeRef; sources: ElementId[] }>();
  const { linked } = await linkIndex(host).snapshot();
  for (const { id, envelope } of linked) {
    for (const recipe of recipesSourcedBy(envelope)) {
      const key = keyOf(recipe);
      let entry = out.get(key);
      if (!entry) out.set(key, (entry = { recipe, sources: [] }));
      entry.sources.push(id);
    }
  }
  return out;
}

/** A recipe's sources as they are now: geometry and properties. */
async function fingerprintOf(
  host: BundleHost,
  sources: readonly ElementId[],
): Promise<string> {
  const parts = await Promise.all(
    sources.map(async (id) => {
      const [anchors, props] = await Promise.all([
        host.document.pathAnchors(id).catch(() => null),
        host.document.elementProperties(id).catch(() => null),
      ]);
      return JSON.stringify([id.kind, String(id.id), anchors, props]);
    }),
  );
  return parts.sort().join("\n");
}

/**
 * A view of `host` whose `document.mutate` amends the step `seq` names
 * (and follows the seq each amend answers), whose `mutateWithBytes` is
 * refused (no recipe update sends bytes, and a write that could not amend
 * must not land as a step of its own), and whose `selection.set` leaves
 * the user's selection alone. Everything else is `host`'s own.
 */
function amendingHost(
  host: BundleHost,
  start: number,
  own: Set<number>,
): { host: BundleHost; refused: () => unknown } {
  let seq = start;
  let refusal: unknown = null;
  const document = Object.create(host.document) as BundleHost["document"];
  document.mutate = async (
    mutation: MutationInput,
    options?: MutateOptions,
  ): Promise<MutationOutcome> => {
    if (refusal !== null) return { applied: false, error: refusal };
    const out = await host.document.mutate(mutation, {
      ...options,
      amend: seq,
    });
    if (out.applied && typeof out.appliedSeq === "number") {
      seq = out.appliedSeq;
      own.add(seq);
    } else if (!out.applied && isNotAmendable(out.error)) {
      refusal = out.error;
    }
    return out;
  };
  document.mutateWithBytes = async () => ({
    applied: false,
    error: "the automatic recipe update sends no bytes",
  });
  const selection = Object.create(host.selection) as BundleHost["selection"];
  selection.set = async () => [...host.selection.get()];
  const view = Object.create(host) as BundleHost;
  Object.defineProperty(view, "document", { value: document });
  Object.defineProperty(view, "selection", { value: selection });
  shareLinkIndex(view, host);
  return { host: view, refused: () => refusal };
}

export function contributeRecipeAutoUpdate(host: BundleHost): RecipeAutoUpdate {
  let rebuilt: readonly string[] = [];
  if (!host.supports(RECIPE_AUTO_UPDATE_FEATURE)) {
    return {
      dispose() {},
      idle: () => Promise.resolve(),
      lastRebuilt: () => rebuilt,
    };
  }
  const handle = contributeRunning(host, {
    setRebuilt: (r) => {
      rebuilt = r;
    },
    rebuilt: () => rebuilt,
  });
  handles.set(host, handle);
  return {
    ...handle,
    dispose() {
      handles.delete(host);
      handle.dispose();
    },
  };
}

function contributeRunning(
  host: BundleHost,
  out: {
    setRebuilt: (r: readonly string[]) => void;
    rebuilt: () => readonly string[];
  },
): RecipeAutoUpdate {
  /** The fingerprint of each recipe's sources, as last seen. */
  const seen = new Map<string, string>();
  /** The seqs the rebuild's own amends answered. */
  const own = new Set<number>();
  /** The changes not handled yet, in the order they were reported. */
  let queue: Pending[] = [];
  let running: Promise<void> = Promise.resolve();
  let scheduled = false;
  let disposed = false;

  const refingerprint = async (
    recipes: Map<string, { recipe: RecipeRef; sources: ElementId[] }>,
    only?: (key: string) => boolean,
  ): Promise<void> => {
    if (!only) seen.clear();
    for (const [key, { sources }] of recipes) {
      if (only && !only(key)) continue;
      seen.set(key, await fingerprintOf(host, sources));
    }
  };

  const handleChange = async (change: Pending): Promise<void> => {
    // Off: nothing is read. Turned on again, the next change only takes
    // the fingerprints.
    if (!recipeAutoUpdateEnabled(host)) {
      seen.clear();
      return;
    }
    // Nothing to do without a recipe: five part reads, no walk.
    if ((await allRecipes(host)).length === 0) {
      seen.clear();
      return;
    }
    const recipes = await sourcesByRecipe(host);
    if (change === "open") {
      await refingerprint(recipes);
      return;
    }
    if (change === "baseline") {
      // A recipe was written (a make writes its record after its artwork
      // committed): take the fingerprints of the recipes not seen yet.
      await refingerprint(recipes, (key) => !seen.has(key));
      return;
    }
    const seq =
      change.kind === "undoApplied" || change.kind === "redoApplied"
        ? null
        : (change.appliedSeq ?? null);
    if (seq === null) {
      // An undo or redo restored the sources and their instances
      // together; a script run carries no step to amend. Look again.
      await refingerprint(recipes);
      return;
    }
    const changed: RecipeRef[] = [];
    const now = new Map<string, string>();
    for (const [key, { recipe, sources }] of recipes) {
      const print = await fingerprintOf(host, sources);
      now.set(key, print);
      const was = seen.get(key);
      if (was !== undefined && was !== print) changed.push(recipe);
    }
    seen.clear();
    for (const [key, print] of now) seen.set(key, print);
    if (changed.length === 0) return;
    changed.sort(
      (a, b) => RECIPE_KINDS.indexOf(a.kind) - RECIPE_KINDS.indexOf(b.kind),
    );
    const view = amendingHost(host, seq, own);
    const done: string[] = [];
    for (const recipe of changed) {
      if (view.refused() !== null) break;
      try {
        if (await updateRecipe(view.host, recipe))
          done.push(addressOf(recipe.kind, recipe.id));
      } catch (e) {
        host.log.warn(
          `recipes: the automatic update of ${addressOf(recipe.kind, recipe.id)} failed (${String(e)})`,
        );
      }
    }
    out.setRebuilt(done);
    if (view.refused() !== null) {
      host.log.info(
        "recipes: the edit is no longer the last step, so its recipes were " +
          "not updated with it — run Update linked recipes",
      );
    }
    // The rebuild may have rewritten the sources' links: look again, so
    // the next edit compares against what is there now.
    const rebuiltKeys = new Set(changed.map(keyOf));
    await refingerprint(await sourcesByRecipe(host), (key) =>
      rebuiltKeys.has(key),
    );
  };

  const isOwn = (change: Pending): boolean =>
    typeof change === "object" &&
    typeof change.appliedSeq === "number" &&
    own.has(change.appliedSeq);

  const drain = async (): Promise<void> => {
    while (queue.length > 0 && !disposed) {
      // The rebuild's own commits are not edits — known by now, since the
      // amends that made them have answered. Of the rest, the last one
      // stands for the burst.
      // A document opened, or a recipe written, counts only when no edit
      // came with it.
      const changes = queue.filter((c) => !isOwn(c));
      queue = [];
      const edits = changes.filter((c) => typeof c === "object");
      const change =
        edits[edits.length - 1] ??
        (changes.includes("open") ? "open" : changes[changes.length - 1]);
      if (change === undefined) continue;
      try {
        await handleChange(change);
      } catch (e) {
        host.log.debug(`recipes: automatic update skipped (${String(e)})`);
      }
    }
  };

  const schedule = (change: Pending): void => {
    queue.push(change);
    if (scheduled) return;
    scheduled = true;
    running = running.then(
      () =>
        new Promise<void>((resolve) => {
          // After the commit's own reply has resolved, and after whatever
          // else the same burst commits.
          setTimeout(() => {
            scheduled = false;
            drain().then(resolve, resolve);
          }, 0);
        }),
    );
  };

  const subs: Disposable[] = [];
  subs.push(
    host.document.onDidChange((change) => {
      if (disposed) return;
      // A change that arrives while a rebuild runs waits for it; own
      // commits are recognised once their amends have answered.
      schedule(change);
    }),
  );
  // A recipe part written (a make records its recipe after the artwork's
  // commit), as the link index reports it beside the document's changes.
  subs.push(
    linkIndex(host).onDidChange(() => {
      if (!disposed) schedule("baseline");
    }),
  );
  try {
    if (host.supports("document.onDidOpen@1"))
      subs.push(host.document.onDidOpen(() => schedule("open")));
  } catch {
    /* no open event: the first change takes the baseline */
  }
  schedule("open");

  return {
    dispose() {
      disposed = true;
      for (const s of subs) s.dispose();
    },
    idle: async () => {
      // A schedule made while waiting extends the chain: wait it out.
      let last: Promise<void> | null = null;
      while (last !== running) {
        last = running;
        await last;
      }
    },
    lastRebuilt: out.rebuilt,
  };
}
