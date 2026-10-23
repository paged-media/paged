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

// Where an editor keeps what it remembers (plan task E1): the theme, the
// workflow mode, the dock's tabs, the palette's recents, the export
// options, the remembered grants. An app on its own page keeps them in the
// page's `localStorage`, under the keys apps/editor/scripts/
// settings-inventory.json lists; an embedded editor keeps them where its
// host says (`createEditor({ storage })`), by default only in memory, so it
// never reads or writes the host's origin storage unasked.
//
// The adapter's methods are Web Storage's, so `localStorage` is one.

import { scoped, useEditorScope, type EditorScope } from "./editor-scope";

/** Where an editor keeps its settings: `localStorage`, or the host's own. */
export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** The keys it holds, when it can say (a one-shot migration of old keys
   *  uses it); absent, nothing is enumerated. */
  keys?(): string[];
}

/** A store for this editor's lifetime only. */
export function memoryStorage(): StorageAdapter {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

/** Nothing kept: every read finds nothing, every write is dropped. */
export function noStorage(): StorageAdapter {
  return {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
}

/** The page's `localStorage`, read at each call (a sandbox may refuse it:
 *  the call throws, as the callers already expect). */
export function pageStorage(): StorageAdapter {
  const ls = () => globalThis.localStorage;
  return {
    getItem: (key) => ls().getItem(key),
    setItem: (key, value) => ls().setItem(key, value),
    removeItem: (key) => ls().removeItem(key),
    keys() {
      const store = ls();
      const out: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k !== null) out.push(k);
      }
      return out;
    },
  };
}

const STORAGE = scoped("storage", () => ({
  adapter: null as StorageAdapter | null,
}));

/** Keep `scope`'s settings in `adapter` (before the shell mounts). */
export function setEditorStorage(
  scope: EditorScope,
  adapter: StorageAdapter,
): void {
  scope.get(STORAGE).adapter = adapter;
}

/** Where `scope`'s editor keeps its settings: the adapter its host gave,
 *  else the page's `localStorage` (a shell on its own page). */
export function editorStorage(scope: EditorScope): StorageAdapter {
  const store = scope.get(STORAGE);
  store.adapter ??= pageStorage();
  return store.adapter;
}

/** `editorStorage` for this component's editor. */
export function useEditorStorage(): StorageAdapter {
  return editorStorage(useEditorScope());
}
