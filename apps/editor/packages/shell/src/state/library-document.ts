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
// A MODULE-SCOPE STORE, like `open-file-handle.ts` and for its reasons: the
// writers are the shell's loader and the app's save command, the readers are
// a panel and that same save command, and none of them share a provider.
//
// The library is OPTIONAL by construction. Until the app hands one over
// (`setLibrary`) — or when the browser has no origin-private file system, or
// the worker fails — every function here is a no-op and the editor behaves
// exactly as it did: open loads, save writes the file. A library that fails
// must never cost the user the file save it rides alongside.

import type { DocumentEntry, LibraryClient } from "@paged-media/repository";

let library: LibraryClient | null = null;
let current: DocumentEntry | null = null;
/** The import of the file just opened, until it lands: a save that races it
 *  waits for it rather than minting a second document. */
let opening: Promise<void> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
  version++;
  for (const l of listeners) l();
}

export function setLibrary(client: LibraryClient | null): void {
  library = client;
  changed();
}

export function getLibrary(): LibraryClient | null {
  return library;
}

/** For `useSyncExternalStore`: bumps whenever the library or the open document changes. */
export function subscribeLibrary(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function libraryVersion(): number {
  return version;
}

export function currentLibraryDocument(): DocumentEntry | null {
  return current;
}

/** The open document IS this library document (opened from the library), or
 *  none (File ▸ New: a library document is made on its first save). */
export function setCurrentLibraryDocument(entry: DocumentEntry | null): void {
  opening = null;
  current = entry;
  changed();
}

/** A file was opened: it becomes a library document. Never throws. */
export function rememberOpenedFile(bytes: Uint8Array, name: string): void {
  current = null;
  if (!library) return changed();
  const lib = library;
  const run: Promise<void> = lib
    .importFile(bytes, name)
    .then((entry) => {
      if (opening === run) current = entry;
    })
    .catch((err: unknown) =>
      console.warn(`library: could not keep ${name}:`, err),
    )
    .finally(() => {
      if (opening === run) opening = null;
      changed();
    });
  opening = run;
  changed();
}

/** A save: commits the saved bytes to the open document's repository (making
 *  one for a document that has none yet). Null when there is no library. */
export async function commitSave(
  bytes: Uint8Array,
  name: string,
): Promise<{ head: string; changed: boolean } | null> {
  if (!library) return null;
  if (opening) await opening;
  if (!current) {
    current = await library.importFile(bytes, name);
    changed();
    return { head: current.head ?? "", changed: true };
  }
  const result = await library.save(current.id, bytes);
  current = { ...current, head: result.head, updatedAt: Date.now() };
  changed();
  return result;
}
