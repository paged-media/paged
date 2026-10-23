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

// One editor's own state (plan task E1, docs/composable-editor.md §8).
//
// The shell used to keep its small stores at module scope: the palette's
// open/close emitter, the export dialog's, the context menu's point, the
// view toggles, the replace question's queue, the file a document came
// from, the cockpit's panel placement. One editor per page made that
// harmless; two editors on one page shared every one of them (Cmd+K in one
// opened the palette in both, a Save wrote the other editor's file).
//
// A scope is the editor's own: `PagedShell` provides one per mount (or the
// host's, through `scope`), and each store is created on first use from a
// key the module that owns it defines once:
//
//     const VIEW_TOGGLES = scoped("viewToggles", () => createToggles());
//     useScoped(VIEW_TOGGLES)            // in a component
//     paged.scope.get(VIEW_TOGGLES)      // in a command handler
//
// Keys are constants; what they create lives in the scope, so it is
// created again for the next editor and dropped with it.

import { createContext, useContext, type ReactNode } from "react";

/** A store kept per editor, created on first use. */
export interface ScopedKey<T> {
  /** For diagnostics only: stores are found by the key's identity. */
  readonly name: string;
  readonly create: (scope: EditorScope) => T;
}

/** One editor's stores. */
export interface EditorScope {
  /** This editor's instance of `key` (created on first use). */
  get<T>(key: ScopedKey<T>): T;
}

/** Define a per-editor store. Call once, at module scope. */
export function scoped<T>(
  name: string,
  create: (scope: EditorScope) => T,
): ScopedKey<T> {
  return { name, create };
}

/** A new, empty editor scope. */
export function createEditorScope(): EditorScope {
  const stores = new Map<ScopedKey<unknown>, unknown>();
  const scope: EditorScope = {
    get<T>(key: ScopedKey<T>): T {
      if (!stores.has(key)) stores.set(key, key.create(scope));
      return stores.get(key) as T;
    },
  };
  return scope;
}

const ScopeContext = createContext<EditorScope | null>(null);

export function EditorScopeProvider({
  scope,
  children,
}: {
  scope: EditorScope;
  children: ReactNode;
}) {
  return (
    <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>
  );
}

// A component rendered outside any editor (a standalone panel, a unit
// test) gets one scope for the page, so the shell's pieces still work on
// their own; every editor mount provides its own.
let detached: EditorScope | null = null;

/** The scope a component outside an editor uses (see above). */
export function detachedEditorScope(): EditorScope {
  detached ??= createEditorScope();
  return detached;
}

/** The scope of the editor a command handler was invoked in: its first
 *  argument, the `PagedEditor` (typed `unknown` by the contract). */
export function scopeOf(paged: unknown): EditorScope {
  const scope = (paged as { scope?: EditorScope } | null | undefined)?.scope;
  return scope ?? detachedEditorScope();
}

/** The scope of the editor this component is mounted in. */
export function useEditorScope(): EditorScope {
  return useContext(ScopeContext) ?? detachedEditorScope();
}

/** This editor's instance of a scoped store. */
export function useScoped<T>(key: ScopedKey<T>): T {
  return useEditorScope().get(key);
}

/** A per-editor event: a command emits, the mounted component listens. */
export interface Emitter<T> {
  emit(value: T): void;
  subscribe(listener: (value: T) => void): () => void;
}

export function createEmitter<T>(): Emitter<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    emit(value) {
      for (const l of [...listeners]) l(value);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** A per-editor value a component reads with `useSyncExternalStore`. */
export interface ValueStore<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: () => void): () => void;
}

export function createValueStore<T>(initial: T): ValueStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
