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

// Session continuity (UX audit F-06; editor ADR 1224): the editor comes
// back to the document the user was working on. The library document open
// last is remembered in the editor's settings (`paged.session.lastDocument
// .v1`); a closed document (File ▸ Close) is forgotten. At the next start,
// when the recovery journal offers nothing (a crashed session's unsaved
// work comes first, editor ADR 1204) and nothing else opened a document,
// that library document opens again. File ▸ Open recent lists the
// library's documents and the files opened lately, newest first.

import { useEffect, useSyncExternalStore } from "react";

import type { DocumentEntry } from "@paged-media/repository";
import {
  attachFileSource,
  createValueStore,
  currentLibraryDocument,
  editorStorage,
  getLibrary,
  libraryVersion,
  openFile,
  openLibraryDocument,
  recoveryOffers,
  scoped,
  setOpenFileHandle,
  subscribeLibrary,
  useEditorScope,
  usePaged,
  writesBackTo,
  type EditorScope,
  type PagedEditor,
} from "@paged-media/shell";
import { defineMessages, t } from "@paged-media/strings";

import type { DocumentIdentity, RecentFile } from "./document-identity";

/** The library document open last (settings-inventory.json). */
export const LAST_DOCUMENT_KEY = "paged.session.lastDocument.v1";

const M = defineMessages("app.sessionContinuity", {
  reopening: "Reopening {name}",
  opening: "Opening {name}",
  noPermission: "the browser did not allow reading the file",
});

/** The library document stored as open last, by a shape check (ADR 247). */
export function readLastDocument(scope: EditorScope): string | null {
  try {
    const raw = editorStorage(scope).getItem(LAST_DOCUMENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    const id = (parsed as { id?: unknown } | null)?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function writeLastDocument(scope: EditorScope, id: string | null): void {
  try {
    const storage = editorStorage(scope);
    if (id === null) storage.removeItem(LAST_DOCUMENT_KEY);
    else storage.setItem(LAST_DOCUMENT_KEY, JSON.stringify({ id }));
  } catch {
    /* storage blocked: the next start opens nothing, as before */
  }
}

/** Whether the start is decided: the recovery journal has said what it
 *  offers (or that it keeps none). Set by `mountEditor`. */
const START = scoped("sessionStart", () => createValueStore(false));

export function markStartDecided(scope: EditorScope): void {
  scope.get(START).set(true);
}

/** Remember the library document open now; forget it when the editor's
 *  document closes. Mounted once, by the canvas app. */
export function useRememberLastDocument(): void {
  const scope = useEditorScope();
  const paged = usePaged();
  const version = useSyncExternalStore(
    (l) => subscribeLibrary(scope, l),
    () => libraryVersion(scope),
    () => libraryVersion(scope),
  );
  const docId = paged.document.handle?.docId ?? null;
  useEffect(() => {
    const current = currentLibraryDocument(scope);
    if (current) writeLastDocument(scope, current.id);
  }, [scope, version]);
  // A document that closed (File ▸ Close) is not reopened at the next
  // start; one replaced by another is remembered as the other above.
  useEffect(() => {
    const opened = scope.get(OPENED);
    if (docId !== null) {
      opened.once = true;
      return;
    }
    if (opened.once) writeLastDocument(scope, null);
  }, [scope, docId]);
}

const OPENED = scoped("sessionOpenedOnce", () => ({ once: false }));

/** At the start: reopen the library document open last, when the
 *  recovery journal offers nothing and nothing else opened a document.
 *  Mounted once, by the canvas app. */
export function useReopenLastDocument(): void {
  const scope = useEditorScope();
  const paged = usePaged();
  const start = scope.get(START);
  const decided = useSyncExternalStore(start.subscribe, start.get, start.get);
  const libraryReady = useSyncExternalStore(
    (l) => subscribeLibrary(scope, l),
    () => getLibrary(scope) !== null,
    () => false,
  );
  useEffect(() => {
    if (!decided || !libraryReady) return;
    if (scope.get(REOPEN).tried) return;
    scope.get(REOPEN).tried = true;
    void reopenLastDocument(paged);
  }, [decided, libraryReady, scope, paged]);
}

const REOPEN = scoped("sessionReopen", () => ({ tried: false }));

/** Open the library document stored as open last, if the editor shows
 *  none and the journal offers nothing. Resolves whether it opened. */
export async function reopenLastDocument(paged: PagedEditor): Promise<boolean> {
  const scope = paged.scope;
  if (paged.document.handle) return false;
  if (recoveryOffers(scope).current()) return false;
  const id = readLastDocument(scope);
  const library = getLibrary(scope);
  if (!id || !library) return false;
  const entry = (await library.list().catch(() => [] as DocumentEntry[])).find(
    (d) => d.id === id,
  );
  if (!entry) {
    writeLastDocument(scope, null);
    return false;
  }
  // Something opened while the library answered: that one stays.
  if (paged.document.handle) return false;
  return openLibraryDocument(paged, entry, {
    action: t(M.reopening, { name: entry.name }),
  });
}

/** One row of File ▸ Open recent. */
export type RecentDocument =
  | {
      kind: "library";
      id: string;
      name: string;
      at: number;
      entry: DocumentEntry;
    }
  | { kind: "file"; id: string; name: string; at: number; file: RecentFile };

/** The library's documents and the files opened lately, newest first. */
export async function recentDocuments(
  scope: EditorScope,
  identity: Pick<DocumentIdentity, "recentFiles"> | null,
  limit = 10,
): Promise<RecentDocument[]> {
  const library = getLibrary(scope);
  const docs = library
    ? await library.list().catch(() => [] as DocumentEntry[])
    : [];
  const files = identity ? await identity.recentFiles(limit) : [];
  return [
    ...docs
      .filter((d) => d.kind !== "data")
      .map((entry): RecentDocument => ({
        kind: "library",
        id: `lib:${entry.id}`,
        name: entry.name,
        at: entry.updatedAt,
        entry,
      })),
    ...files.map((file): RecentDocument => ({
      kind: "file",
      id: file.key,
      name: file.name,
      at: file.seenAt,
      file,
    })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

/** A file handle the browser can read again (the File System Access API). */
interface ReadableHandle {
  name: string;
  getFile(): Promise<File>;
  queryPermission?(o: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(o: {
    mode: "read" | "readwrite";
  }): Promise<PermissionState>;
}

/** Open a row of File ▸ Open recent: a library document as the Library
 *  panel opens it, a file through File ▸ Open's own path (its replace
 *  question, its importers), its handle kept so Save writes back. */
export async function openRecent(
  paged: PagedEditor,
  row: RecentDocument,
  sinks: { setStatus: (s: string) => void; pushWarning: (w: string) => void },
): Promise<boolean> {
  if (row.kind === "library")
    return openLibraryDocument(paged, row.entry, {
      action: t(M.opening, { name: row.name }),
      ...sinks,
    });
  const handle = row.file.handle as unknown as ReadableHandle;
  const granted = await readPermission(handle);
  if (!granted) {
    sinks.pushWarning(`${row.name}: ${t(M.noPermission)}`);
    return false;
  }
  const file = attachFileSource(await handle.getFile(), row.file.handle);
  setOpenFileHandle(
    paged.scope,
    writesBackTo(file.name) ? (handle as never) : null,
  );
  await openFile(paged, file, sinks);
  return true;
}

async function readPermission(handle: ReadableHandle): Promise<boolean> {
  if (typeof handle.getFile !== "function") return false;
  try {
    const state =
      (await handle.queryPermission?.({ mode: "read" })) ?? "granted";
    if (state === "granted") return true;
    return (await handle.requestPermission?.({ mode: "read" })) === "granted";
  } catch {
    return false;
  }
}
