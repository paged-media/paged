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

// ADR 180 — the document is a repository in the local library; a file is a
// projection of it. This is the editor's side of that: which library
// document is open, and the two moments it changes — a file opened (an
// import) and a save (a commit).
//
// A STORE IN THE EDITOR'S SCOPE, like `open-file-handle.ts` and for its
// reasons: the writers are the shell's loader and the app's save command,
// the readers are a panel and that same save command, and none of them
// share a provider. Per editor (plan task E1): each editor knows which
// library document it holds.
//
// The library is OPTIONAL by construction. Until the app hands one over
// (`setLibrary`) — or when the browser has no origin-private file system, or
// the worker fails — every function here is a no-op and the editor behaves
// exactly as it did: open loads, save writes the file. A library that fails
// must never cost the user the file save it rides alongside.

import type { DocumentEntry, LibraryClient } from "@paged-media/repository";

import { scoped, type EditorScope } from "./editor-scope";

interface LibraryState {
  library: LibraryClient | null;
  current: DocumentEntry | null;
  /** The import of the file just opened, until it lands: a save that races
   *  it waits for it rather than minting a second document. */
  opening: Promise<void> | null;
  version: number;
  readonly listeners: Set<() => void>;
}

const LIBRARY = scoped("libraryDocument", (): LibraryState => ({
  library: null,
  current: null,
  opening: null,
  version: 0,
  listeners: new Set(),
}));

function changed(st: LibraryState): void {
  st.version++;
  for (const l of [...st.listeners]) l();
}

export function setLibrary(
  scope: EditorScope,
  client: LibraryClient | null,
): void {
  const st = scope.get(LIBRARY);
  st.library = client;
  changed(st);
}

export function getLibrary(scope: EditorScope): LibraryClient | null {
  return scope.get(LIBRARY).library;
}

/** For `useSyncExternalStore`: bumps whenever the library or the open document changes. */
export function subscribeLibrary(
  scope: EditorScope,
  listener: () => void,
): () => void {
  const { listeners } = scope.get(LIBRARY);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function libraryVersion(scope: EditorScope): number {
  return scope.get(LIBRARY).version;
}

export function currentLibraryDocument(
  scope: EditorScope,
): DocumentEntry | null {
  return scope.get(LIBRARY).current;
}

/** The open document IS this library document (opened from the library), or
 *  none (File ▸ New: a library document is made on its first save). */
export function setCurrentLibraryDocument(
  scope: EditorScope,
  entry: DocumentEntry | null,
): void {
  const st = scope.get(LIBRARY);
  st.opening = null;
  st.current = entry;
  changed(st);
}

/** A file was opened: it becomes a library document. Never throws. */
export function rememberOpenedFile(
  scope: EditorScope,
  bytes: Uint8Array,
  name: string,
): void {
  const st = scope.get(LIBRARY);
  st.current = null;
  if (!st.library) return changed(st);
  const lib = st.library;
  const run: Promise<void> = lib
    .importFile(bytes, name)
    .then((entry) => {
      if (st.opening === run) st.current = entry;
    })
    .catch((err: unknown) =>
      console.warn(`library: could not keep ${name}:`, err),
    )
    .finally(() => {
      if (st.opening === run) st.opening = null;
      changed(st);
    });
  st.opening = run;
  changed(st);
}

/** A save: commits the saved bytes to the open document's repository (making
 *  one for a document that has none yet). Null when there is no library. */
export async function commitSave(
  scope: EditorScope,
  bytes: Uint8Array,
  name: string,
): Promise<{ head: string; changed: boolean } | null> {
  const st = scope.get(LIBRARY);
  if (!st.library) return null;
  if (st.opening) await st.opening;
  if (!st.current) {
    st.current = await st.library.importFile(bytes, name);
    changed(st);
    return { head: st.current.head ?? "", changed: true };
  }
  const result = await st.library.save(st.current.id, bytes);
  st.current = { ...st.current, head: result.head, updatedAt: Date.now() };
  changed(st);
  return result;
}
