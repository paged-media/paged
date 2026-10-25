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

// The registered actions as the editor's own surfaces see them (extensions
// ADR 344; editor ADR 291): the Data panel's picture column picker lists the
// actions a column's chain can use, from the same shared registry every
// bundle host of this editor registers into. The app points the editor's
// scope at that registry once (`setRegisteredActionsSource`); React reads it through
// `useSyncExternalStore`.
//
// The registry announces no registrations, so the snapshot is read again on
// every render and kept while its actions are the same ones: a surface that
// opens after a bundle registered sees the action, and an unchanged list
// keeps its identity.

import { useSyncExternalStore } from "react";

import type { ActionInfo, ActionValueKind } from "@paged-media/plugin-api";

import { scoped, useScoped, type EditorScope } from "./editor-scope";

/** What the app hands the shell: the shared action registry's listing. */
export interface RegisteredActionsSource {
  list(input?: ActionValueKind): readonly ActionInfo[];
}

interface ActionsStore {
  source: RegisteredActionsSource | null;
  listeners: Set<() => void>;
  /** The last snapshot per input kind, with its signature. */
  last: Map<string, { sig: string; list: readonly ActionInfo[] }>;
  subscribe(l: () => void): () => void;
}

const NONE: readonly ActionInfo[] = [];

const ACTIONS = scoped("actionsDoor", (): ActionsStore => {
  const store: ActionsStore = {
    source: null,
    listeners: new Set(),
    last: new Map(),
    subscribe(l) {
      store.listeners.add(l);
      return () => store.listeners.delete(l);
    },
  };
  return store;
});

/** Point an editor's surfaces at the shared action registry (or nothing). */
export function setRegisteredActionsSource(
  scope: EditorScope,
  next: RegisteredActionsSource | null,
): void {
  const store = scope.get(ACTIONS);
  store.source = next;
  store.last.clear();
  for (const l of [...store.listeners]) l();
}

function snapshot(
  store: ActionsStore,
  input: ActionValueKind | undefined,
): readonly ActionInfo[] {
  if (!store.source) return NONE;
  const list = store.source.list(input);
  const sig = JSON.stringify(list);
  const key = input ?? "";
  const last = store.last.get(key);
  if (last?.sig === sig) return last.list;
  store.last.set(key, { sig, list });
  return list;
}

/** The registered actions, or those taking `input`. */
export function useRegisteredActions(
  input?: ActionValueKind,
): readonly ActionInfo[] {
  const store = useScoped(ACTIONS);
  return useSyncExternalStore(
    store.subscribe,
    () => snapshot(store, input),
    () => NONE,
  );
}
