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
// SCRIPTS. A script run is one undo step, and its reply names it
// (`appliedSeq` on the `scriptResult` change, `document.mutate.amend@2`):
// the rebuild joins it as it joins an edit. A plugin write the script made
// through the host is a change of its own while the script still runs; a
// rebuild that joins it stays the script's (the engine knows the amended
// step by both numbers), and one that loses the race to the script's next
// write is retried on the script's reply. A run that names no step (it
// called `paged.undo()`, or an edit split it) is only fingerprinted.
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
  MutateWithBytesOptions,
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
import { takeRecipesRebuiltIn } from "./recipe-steps";
import { linkIndex, shareLinkIndex } from "../link-index";
import { addressOf } from "../object-model/shared";

/** The host feature the automatic update rides on (engine ADR 1004). */
export const RECIPE_AUTO_UPDATE_FEATURE = "document.mutate.amend@1";

/** The host feature that adds a script run's step to the change event and
 *  `amend` to `mutateWithBytes` (engine ADR 1004, amendment). */
export const RECIPE_SCRIPT_FEATURE = "document.mutate.amend@2";

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

/** Who hears the setting change (the panels' checkboxes). */
const settingListeners = new Set<() => void>();

/** The setting as last read or written, per host: a panel reads it on
 *  every render without touching the storage door. */
const settingSnapshot = new WeakMap<
  BundleHost,
  { generation: number; on: boolean }
>();
/** Bumped by every {@link setRecipeAutoUpdate}: a write through any view
 *  of the host makes every view read the storage again. */
let settingGeneration = 0;

/** {@link recipeAutoUpdateEnabled}, read once per host and setting change
 *  (a `useSyncExternalStore` snapshot). */
export function recipeAutoUpdateSnapshot(host: BundleHost): boolean {
  const kept = settingSnapshot.get(host);
  if (kept && kept.generation === settingGeneration) return kept.on;
  const on = recipeAutoUpdateEnabled(host);
  settingSnapshot.set(host, { generation: settingGeneration, on });
  return on;
}

/** Turn the automatic update on or off (kept in the bundle's storage). */
export function setRecipeAutoUpdate(host: BundleHost, on: boolean): void {
  if (on) host.storage.delete(RECIPE_AUTO_UPDATE_KEY);
  else host.storage.set(RECIPE_AUTO_UPDATE_KEY, false);
  settingGeneration++;
  for (const l of [...settingListeners]) l();
}

/** Hear {@link setRecipeAutoUpdate} (storage reports no change itself). */
export function onRecipeAutoUpdateChange(listener: () => void): Disposable {
  settingListeners.add(listener);
  return {
    dispose() {
      settingListeners.delete(listener);
    },
  };
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
type Pending = DocumentChangeEvent | "baseline" | "open" | "setting";

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
 * A view of `host` whose `document.mutate` and `mutateWithBytes` amend the
 * step `seq` names (and follow the seq each amend answers), and whose
 * `selection.set` leaves the user's selection alone. Everything else is
 * `host`'s own. On a host whose `mutateWithBytes` cannot amend
 * (`document.mutate.amend@2` absent) that door is refused: a write that
 * could not amend must not land as a step of its own.
 */
function amendingHost(
  host: BundleHost,
  start: number,
  own: Set<number>,
): { host: BundleHost; refused: () => unknown; seq: () => number } {
  let seq = start;
  let refusal: unknown = null;
  const follow = (out: MutationOutcome): MutationOutcome => {
    if (out.applied && typeof out.appliedSeq === "number") {
      seq = out.appliedSeq;
      own.add(seq);
    } else if (!out.applied && isNotAmendable(out.error)) {
      refusal = out.error;
    }
    return out;
  };
  const document = Object.create(host.document) as BundleHost["document"];
  document.mutate = async (
    mutation: MutationInput,
    options?: MutateOptions,
  ): Promise<MutationOutcome> => {
    if (refusal !== null) return { applied: false, error: refusal };
    return follow(
      await host.document.mutate(mutation, { ...options, amend: seq }),
    );
  };
  const bytesAmend = host.supports(RECIPE_SCRIPT_FEATURE);
  document.mutateWithBytes = async (
    mutation: MutationInput,
    bytes: Uint8Array,
    options?: MutateWithBytesOptions,
  ): Promise<MutationOutcome> => {
    if (refusal !== null) return { applied: false, error: refusal };
    if (!bytesAmend)
      return {
        applied: false,
        error: "this host cannot join image bytes to an undo step",
      };
    return follow(
      await host.document.mutateWithBytes(mutation, bytes, {
        ...options,
        amend: seq,
      }),
    );
  };
  const selection = Object.create(host.selection) as BundleHost["selection"];
  selection.set = async () => [...host.selection.get()];
  const view = Object.create(host) as BundleHost;
  Object.defineProperty(view, "document", { value: document });
  Object.defineProperty(view, "selection", { value: selection });
  shareLinkIndex(view, host);
  return { host: view, refused: () => refusal, seq: () => seq };
}

/** What {@link rebuildInStep} did. */
export interface StepRebuild {
  /** The step's number after the rebuild (the last amend's answer). */
  appliedSeq: number;
  /** The recipes rebuilt (addresses). */
  rebuilt: string[];
  /** The engine's `notAmendable` when the step could no longer be joined
   *  (nothing more was written from then on), else `null`. */
  refused: unknown;
}

/**
 * Rebuild `recipes` INSIDE the undo step `appliedSeq` names (engine ADR
 * 1004): every write of every update amends it. The automatic update runs
 * this for an edit's changed sources; a typed recipe parameter write runs
 * it as its follow-up (`object-model/recipe-kinds.ts`), so the write and
 * its artwork are one step. `own` collects the seqs the amends answered.
 */
export async function rebuildInStep(
  host: BundleHost,
  recipes: readonly RecipeRef[],
  appliedSeq: number,
  own: Set<number> = new Set(),
): Promise<StepRebuild> {
  const view = amendingHost(host, appliedSeq, own);
  const rebuilt: string[] = [];
  for (const recipe of recipes) {
    if (view.refused() !== null) break;
    try {
      if (await updateRecipe(view.host, recipe))
        rebuilt.push(addressOf(recipe.kind, recipe.id));
    } catch (e) {
      host.log.warn(
        `recipes: the update of ${addressOf(recipe.kind, recipe.id)} in the step failed (${String(e)})`,
      );
    }
  }
  return { appliedSeq: view.seq(), rebuilt, refused: view.refused() };
}

/**
 * Run `work` INSIDE the undo step `appliedSeq` names, the way
 * {@link rebuildInStep} runs a recipe update: every write `work` makes
 * through the host it is handed amends that step, and it never moves the
 * user's selection. For a rebuild that is not a recipe (the live image
 * trace, `image-trace-live.ts`). Answers what `work` answered, the step's
 * number afterwards and the engine's `notAmendable` when the step could
 * no longer be joined.
 */
export async function runInStep<T>(
  host: BundleHost,
  appliedSeq: number,
  work: (view: BundleHost) => Promise<T>,
  own: Set<number> = new Set(),
): Promise<{ result: T; appliedSeq: number; refused: unknown }> {
  const view = amendingHost(host, appliedSeq, own);
  const result = await work(view.host);
  return { result, appliedSeq: view.seq(), refused: view.refused() };
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
  /** The prints of recipes whose rebuild lost the race to a script's next
   *  write, owed to that script's reply (key → the print before the edit). */
  const owed = new Map<string, string>();
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

  const handleChange = async (
    change: Pending,
    /** The recipes their own command already rebuilt in the burst's steps
     *  (`recipe-steps.ts`): only fingerprinted, never rebuilt again. */
    rebuiltByCommand: ReadonlySet<string> = new Set(),
  ): Promise<void> => {
    // Off: nothing is read, and the prints taken before the switch-off
    // are KEPT. Turned on again (the setting's change schedules a
    // `setting`), only the recipes with no kept print are fingerprinted:
    // re-taking the others would race the next edit — a write sent right
    // after the click can land before the baseline is read, which then
    // already holds the edit and nothing rebuilds (measured in the
    // editor's plugin-surface checkbox spec). So the first edit after the
    // switch-on compares against the state before the switch-off, and its
    // rebuild also catches up whatever changed while it was off. A
    // document opened while off forgets them (they name another document).
    if (!recipeAutoUpdateEnabled(host)) {
      if (change === "open") seen.clear();
      return;
    }
    // Nothing to do without a recipe: five part reads, no walk.
    if ((await allRecipes(host)).length === 0) {
      seen.clear();
      return;
    }
    const recipes = await sourcesByRecipe(host);
    if (change === "open") {
      owed.clear();
      await refingerprint(recipes);
      return;
    }
    if (change === "setting") {
      await refingerprint(recipes, (key) => !seen.has(key));
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
    // The prints a lost race owes a script's reply (see below): only that
    // reply uses them, and an undo, a redo, a gesture or the reply itself
    // ends the debt.
    const owedNow = new Map(owed);
    if (change.kind !== "mutationApplied") owed.clear();
    const retry = change.kind === "scriptResult" && seq !== null;
    if (seq === null) {
      // An undo or redo restored the sources and their instances
      // together; a script run that names no step (it moved the history,
      // or an edit split it) has nothing to amend. Look again.
      await refingerprint(recipes);
      return;
    }
    const changed: RecipeRef[] = [];
    const now = new Map<string, string>();
    const previous = new Map(seen);
    if (retry) for (const [key, was] of owedNow) previous.set(key, was);
    for (const [key, { recipe, sources }] of recipes) {
      const print = await fingerprintOf(host, sources);
      now.set(key, print);
      const was = previous.get(key);
      if (was !== undefined && was !== print && !rebuiltByCommand.has(key))
        changed.push(recipe);
    }
    seen.clear();
    for (const [key, print] of now) seen.set(key, print);
    if (changed.length === 0) return;
    changed.sort(
      (a, b) => RECIPE_KINDS.indexOf(a.kind) - RECIPE_KINDS.indexOf(b.kind),
    );
    const step = await rebuildInStep(host, changed, seq, own);
    out.setRebuilt(step.rebuilt);
    if (step.refused !== null) {
      // Lost the race. A script's own host write is the usual case: the
      // script went on writing before the rebuild could join its commit,
      // and its reply will name the step the whole run ended in — keep the
      // prints the rebuild was owed, so that reply retries them. An undo,
      // a redo or a gesture drops them: a rebuild is never attached to a
      // step the user made.
      for (const r of changed) {
        if (step.rebuilt.includes(addressOf(r.kind, r.id))) continue;
        const was = owed.get(keyOf(r)) ?? previous.get(keyOf(r));
        if (was !== undefined) owed.set(keyOf(r), was);
      }
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
      // What the burst's own recipe commands already rebuilt (taken for
      // every step, so a note never outlives the change it names).
      const rebuiltByCommand = new Set<string>();
      for (const c of changes)
        if (typeof c === "object" && typeof c.appliedSeq === "number")
          for (const key of takeRecipesRebuiltIn(c.appliedSeq))
            rebuiltByCommand.add(key);
      const edits = changes.filter((c) => typeof c === "object");
      const change =
        edits[edits.length - 1] ??
        (changes.includes("open")
          ? "open"
          : changes.includes("setting")
            ? "setting"
            : changes[changes.length - 1]);
      if (change === undefined) continue;
      try {
        await handleChange(change, rebuiltByCommand);
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
  // Turned on again: take the fingerprints now, so the very next edit is
  // compared against the document as it is (off, nothing was tracked).
  subs.push(
    onRecipeAutoUpdateChange(() => {
      if (!disposed) schedule("setting");
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
