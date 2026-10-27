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

// Editor ADR 303 — Find & Replace, the state and the actions: one store
// per editor (the dialog, the results panel and the commands share it), and
// the actions over the engine — `RequestFindText` for the hits,
// `findReplace` for Replace All (one undo step, engine ADR 1021), and one
// batch (`deleteRange` + `insertText`, + `applyStyle`) for Replace on the
// hit the selection stands on, so it is that hit and not the document's
// first that changes, still in one undo step.

import type {
  CanvasClient,
  ContentSelection,
  FindHit,
  Mutation,
  WorkerToMain,
} from "@paged-media/client";
import {
  createValueStore,
  scoped,
  type EditorScope,
  type ValueStore,
} from "@paged-media/shell";

import {
  byteLength,
  DEFAULT_FIND_OPTIONS,
  findSpecOf,
  isHit,
  nextHitIndex,
  replacementFor,
  type CaretRange,
  type FindOptions,
} from "./find-model";

/** The last action's outcome, for the dialog's status line. */
export type FindStatus =
  | { kind: "found"; index: number; count: number }
  | { kind: "notFound" }
  | { kind: "replaced"; count: number }
  | { kind: "error"; message: string };

export interface FindState {
  options: FindOptions;
  /** The last search's hits, in document story order. */
  hits: FindHit[];
  /** The hit last gone to, `-1` for none. */
  current: number;
  /** The search text the hits answer (null: not searched yet). */
  searchedFor: string | null;
  status: FindStatus | null;
  /** The Find & Replace dialog is open. */
  dialog: boolean;
  /** The Go To dialog is open. */
  goTo: boolean;
  /** Bumped to move focus into the results panel's search field. */
  focusSearch: number;
}

export const INITIAL_FIND_STATE: FindState = {
  options: DEFAULT_FIND_OPTIONS,
  hits: [],
  current: -1,
  searchedFor: null,
  status: null,
  dialog: false,
  goTo: false,
  focusSearch: 0,
};

/** The editor's find store. */
export const FIND_STATE = scoped("findReplace", () =>
  createValueStore<FindState>(INITIAL_FIND_STATE),
);

export function findStoreOf(scope: EditorScope): ValueStore<FindState> {
  return scope.get(FIND_STATE);
}

/** Merge `patch` into the store. */
export function patchFind(
  store: ValueStore<FindState>,
  patch: Partial<FindState>,
): void {
  store.set({ ...store.get(), ...patch });
}

/** Set some options; the hits no longer answer them. */
export function setFindOptions(
  store: ValueStore<FindState>,
  patch: Partial<FindOptions>,
): void {
  const s = store.get();
  store.set({
    ...s,
    options: { ...s.options, ...patch },
    status: null,
  });
}

/** What the actions need from the editor. */
export interface FindDeps {
  client: Pick<CanvasClient, "send" | "mutate">;
  /** The text selection (content offsets), null without a caret. */
  selection(): ContentSelection | null;
  /** Take the user to a range and select it; false when it is not laid
   *  out (overset). */
  reveal(range: CaretRange): Promise<boolean> | boolean;
}

/** Run the search the options describe; the hits land in the store. */
export async function runSearch(
  deps: FindDeps,
  store: ValueStore<FindState>,
): Promise<FindHit[]> {
  const { options } = store.get();
  if (!options.find) {
    patchFind(store, { hits: [], current: -1, searchedFor: null });
    return [];
  }
  const sel = deps.selection();
  const reply = (await deps.client.send({
    kind: "requestFindText",
    payload: { spec: findSpecOf(options, sel?.storyId ?? null) },
  })) as WorkerToMain;
  const payload =
    reply.kind === "foundText"
      ? (reply.payload as { hits: FindHit[]; error?: string | null })
      : { hits: [], error: `unexpected reply ${reply.kind}` };
  const hits = payload.hits ?? [];
  // A search for what the store still holds (the user did not type on).
  if (store.get().options.find !== options.find) return hits;
  patchFind(store, {
    hits,
    current: hits.findIndex((h) => isHit(sel, h)),
    searchedFor: options.find,
    status: payload.error
      ? { kind: "error", message: payload.error }
      : hits.length === 0
        ? { kind: "notFound" }
        : store.get().status,
  });
  return hits;
}

/** Go to hit `index` of the store's hits. */
export async function goToHit(
  deps: FindDeps,
  store: ValueStore<FindState>,
  index: number,
): Promise<boolean> {
  const { hits } = store.get();
  const hit = hits[index];
  if (!hit) return false;
  patchFind(store, {
    current: index,
    status: { kind: "found", index, count: hits.length },
  });
  return Boolean(
    await deps.reveal({ storyId: hit.storyId, start: hit.start, end: hit.end }),
  );
}

/** Find Next (Find Previous with `backwards`) from the selection. */
export async function findNext(
  deps: FindDeps,
  store: ValueStore<FindState>,
  backwards = false,
): Promise<boolean> {
  const hits = await runSearch(deps, store);
  if (hits.length === 0) return false;
  return goToHit(deps, store, nextHitIndex(hits, deps.selection(), backwards));
}

function applied(reply: WorkerToMain): boolean {
  return reply.kind === "mutationApplied";
}

function failure(reply: WorkerToMain): string {
  const p = reply.payload as { error?: unknown } | undefined;
  return typeof p?.error === "string"
    ? p.error
    : JSON.stringify(p?.error ?? reply.kind);
}

/**
 * Replace: when the selection is a hit, replace that hit (one undo step)
 * and go to the next one; otherwise find the next hit first, as Word's
 * first press of Replace does.
 */
export async function replaceCurrent(
  deps: FindDeps,
  store: ValueStore<FindState>,
): Promise<boolean> {
  const hits = await runSearch(deps, store);
  const sel = deps.selection();
  const at = hits.findIndex((h) => isHit(sel, h));
  if (at < 0) {
    if (hits.length === 0) return false;
    return goToHit(deps, store, nextHitIndex(hits, sel));
  }
  const hit = hits[at]!;
  const { options } = store.get();
  const text = replacementFor(options.replace, hit, options.mode);
  if (text === null) {
    patchFind(store, {
      status: { kind: "error", message: "^m cannot be replaced in" },
    });
    return false;
  }
  const ops: Mutation[] = [
    {
      op: "deleteRange",
      args: { storyId: hit.storyId, start: hit.start, end: hit.end },
    },
  ];
  if (text) {
    ops.push({
      op: "insertText",
      args: { storyId: hit.storyId, offset: hit.start, text },
    });
  }
  const end = hit.start + byteLength(text);
  for (const [style, scope] of [
    [options.replaceParagraphStyle, "paragraph"],
    [options.replaceCharacterStyle, "character"],
  ] as const) {
    if (style && text) {
      ops.push({
        op: "applyStyle",
        args: {
          storyId: hit.storyId,
          start: hit.charStart,
          end: hit.charStart + [...text].length,
          style,
          scope,
        },
      });
    }
  }
  const reply = await deps.client.mutate(
    ops.length === 1 ? ops[0]! : ({ op: "batch", args: { ops } } as Mutation),
  );
  if (!applied(reply)) {
    patchFind(store, { status: { kind: "error", message: failure(reply) } });
    return false;
  }
  // Stand on the replacement, then go on to the next hit after it.
  await deps.reveal({ storyId: hit.storyId, start: hit.start, end });
  patchFind(store, { status: { kind: "replaced", count: 1 } });
  const after = await runSearch(deps, store);
  if (after.length > 0) {
    const next = nextHitIndex(after, {
      storyId: hit.storyId,
      start: end,
      end,
    });
    await goToHit(deps, store, next);
    patchFind(store, { status: { kind: "replaced", count: 1 } });
  }
  return true;
}

/** Replace All: the engine's one `findReplace`, one undo step. */
export async function replaceAll(
  deps: FindDeps,
  store: ValueStore<FindState>,
): Promise<number> {
  const hits = await runSearch(deps, store);
  if (hits.length === 0) return 0;
  const { options } = store.get();
  const sel = deps.selection();
  const reply = await deps.client.mutate({
    op: "findReplace",
    args: {
      spec: findSpecOf(options, sel?.storyId ?? null),
      replace: options.replace,
      replaceAll: true,
      ...(options.replaceParagraphStyle
        ? { paragraphStyle: options.replaceParagraphStyle }
        : {}),
      ...(options.replaceCharacterStyle
        ? { characterStyle: options.replaceCharacterStyle }
        : {}),
    },
  } as Mutation);
  if (!applied(reply)) {
    patchFind(store, { status: { kind: "error", message: failure(reply) } });
    return 0;
  }
  await runSearch(deps, store);
  patchFind(store, { status: { kind: "replaced", count: hits.length } });
  return hits.length;
}
